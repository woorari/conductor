/**
 * Where conductor's home is, and which workspaces a run in a home that is not
 * a repository may work in. Everything it knows of the disk comes through
 * `Io`, so it can be read without the engine.
 */

import type { Candidate, Place, WorkspaceKind } from '../types'

export type Io = {
  exists(path: string): Promise<boolean>
  list(path: string): Promise<{ name: string; kind: 'dir' | 'file' }[]>
  /** The folder's real path, every symlink resolved; undefined when it cannot be read. */
  real(path: string): Promise<string | undefined>
  /** The user's own home folder, which is never a conductor home: its `.claude` is Claude Code's own. */
  userHome: string | undefined
}

/** A repository home is its own workspace, as before; a folder home holds places. */
export type Home = { kind: 'repository' | 'folder'; root: string }

const CONDUCTOR = '.claude/conductor'

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))
const trimmed = (path: string): string => path.replace(/\/+$/, '')

/** Whether `inner` lies strictly inside `outer`. */
const isWithin = (outer: string, inner: string): boolean => inner.startsWith(`${outer}/`)

/** Whether `path` is `root` or lies inside it. */
const holds = (root: string, path: string): boolean => path === root || isWithin(root, path)

/**
 * The nearest home at or above the session's folder.
 *
 * A repository home is what it was before: the session's own git repository
 * (as git names it) or a Lore workspace (a folder with `.lore`), with
 * `.claude/conductor` at its root. Any other `.git` folder makes nothing a
 * home: git did not name it for this session.
 *
 * A folder home is a folder with `.claude/conductor` that is no repository
 * root, lies inside no repository, and lies strictly inside the user's own
 * home folder, by its path and by its real path. A folder above or outside the
 * home folder may be one another user can write, and a config there names
 * programs that run. With no home folder known there is no folder home.
 * Inside a repository below its root `.claude/conductor` means nothing.
 * Neither `/` nor the user's home folder is ever a home.
 */
export async function findHome(io: Io, cwd: string, gitRoot: string | null): Promise<Home | null> {
  const userHome = io.userHome === undefined ? undefined : trimmed(io.userHome)
  const isRepository = async (dir: string): Promise<boolean> => dir === gitRoot || (await io.exists(`${dir}/.lore`))
  const isRoot = async (dir: string): Promise<boolean> => (await isRepository(dir)) || (await io.exists(`${dir}/.git`))
  const insideRepository = async (dir: string): Promise<boolean> => {
    for (let above = parentOf(dir); above !== ''; above = parentOf(above)) {
      if (await isRoot(above)) return true
    }

    return false
  }
  const isFolderHome = async (dir: string): Promise<boolean> => {
    if (userHome === undefined || userHome === '' || !isWithin(userHome, dir) || (await isRoot(dir)) || (await insideRepository(dir))) return false
    // Real paths are asked for only here: a repository home runs no program to be found.
    const userReal = await io.real(userHome)
    const real = await io.real(dir)

    return userReal !== undefined && real !== undefined && isWithin(userReal, real)
  }
  for (let dir = trimmed(cwd); dir !== ''; dir = parentOf(dir)) {
    if (dir === userHome || !(await io.exists(`${dir}/${CONDUCTOR}`))) continue
    if (await isRepository(dir)) return { kind: 'repository', root: dir }
    if (await isFolderHome(dir)) return { kind: 'folder', root: dir }
  }

  return null
}

async function kindOf(io: Io, dir: string): Promise<WorkspaceKind | undefined> {
  if (await io.exists(`${dir}/.git`)) return 'git'
  if (await io.exists(`${dir}/.lore`)) return 'lore'

  return undefined
}

/**
 * The git and Lore roots of a place, given by its real path: the place itself
 * and its direct subfolders, never deeper. A run's own workspaces (a folder
 * ending in `.conductor`) and hidden folders are not looked at. A subfolder
 * whose real path leads out of the place is left out, and said.
 */
export async function workspacesIn(io: Io, placeReal: string): Promise<{ found: { kind: WorkspaceKind; root: string }[]; left: string[] }> {
  const found: { kind: WorkspaceKind; root: string }[] = []
  const left: string[] = []
  const own = await kindOf(io, placeReal)
  if (own !== undefined) found.push({ kind: own, root: placeReal })
  const entries = await io.list(placeReal).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.') || entry.name.endsWith('.conductor')) continue
    const sub = `${placeReal}/${entry.name}`
    const kind = await kindOf(io, sub)
    if (kind === undefined) continue
    const real = await io.real(sub)
    if (real === undefined || !isWithin(placeReal, real)) {
      left.push(`${sub} leads out of its place`)
      continue
    }
    found.push({ kind, root: real })
  }

  return { found, left }
}

const folderMessage = (at: number): string => `config.json: places[${at}].folder must be a folder inside this home, given relative to it.`

/** A place's real path, strictly inside the home's; or why the run cannot start. Fails closed. */
async function placeReal(io: Io, home: string, homeReal: string, places: readonly Place[], place: Place): Promise<{ real: string } | { error: string }> {
  const at = places.indexOf(place)
  const path = `${home}/${trimmed(place.folder)}`
  if (!(await io.exists(path))) return { error: `No run was started. places[${at}].folder, ${place.folder}, is no folder in this home: correct config.json, or make the folder.` }
  const real = await io.real(path)
  if (real === undefined || !isWithin(homeReal, real)) return { error: folderMessage(at) }

  return { real }
}

const homeUnread = (home: string): string => `No run was started. The real path of this home, ${home}, could not be read.`
const joined = (names: readonly string[]): string => (names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

/**
 * The workspaces a ticket of `team` may be worked in: every git or Lore root in
 * the places that take the team. The first place that is not safely inside
 * the home refuses the run; so does a team no place takes, and places that
 * hold no workspace.
 */
export async function candidatesFor(io: Io, home: string, places: readonly Place[], team: string): Promise<{ candidates: Candidate[]; left: string[] } | { error: string }> {
  const ours = places.filter(place => place.teams.includes(team))
  if (ours.length === 0) return { error: `No run was started. No place in .claude/conductor/config.json takes team ${team}: add ${team} to a place's teams.` }
  const homeReal = await io.real(home)
  if (homeReal === undefined) return { error: homeUnread(home) }
  const candidates: Candidate[] = []
  const left: string[] = []
  for (const place of ours) {
    const where = await placeReal(io, home, homeReal, places, place)
    if ('error' in where) return where
    const inside = await workspacesIn(io, where.real)
    candidates.push(...inside.found.map(one => ({ ...one, place: place.folder, about: place.about })))
    left.push(...inside.left)
  }
  if (candidates.length === 0) {
    const names = ours.map(place => place.folder)

    return {
      error: `No run was started. ${joined(names)} ${names.length === 1 ? 'holds' : 'hold'} no git or Lore workspace. Put the folder the work needs into Lore or git first, then give /conduct again.`,
    }
  }

  return { candidates, left }
}

/**
 * The workspace a spec lies in: the nearest git or Lore root of a place that
 * holds it. Its Linear tickets go to the place's first team.
 */
export async function workspaceOfSpec(io: Io, home: string, places: readonly Place[], spec: string): Promise<{ candidate: Candidate; team: string } | { error: string }> {
  const nowhere = { error: `No run was started. ${spec} lies in no workspace of a place in .claude/conductor/config.json.` }
  const path = spec.startsWith('/') ? spec : `${home}/${spec}`
  const folder = await io.real(parentOf(path))
  if (folder === undefined) return nowhere
  const homeReal = await io.real(home)
  if (homeReal === undefined) return { error: homeUnread(home) }
  for (const place of places) {
    const where = await placeReal(io, home, homeReal, places, place)
    if ('error' in where) return where
    if (!holds(where.real, folder)) continue
    const nearest = (await workspacesIn(io, where.real)).found.filter(one => holds(one.root, folder)).sort((one, other) => other.root.length - one.root.length)[0]
    if (nearest === undefined) return nowhere

    return { candidate: { ...nearest, place: place.folder, about: place.about }, team: place.teams[0] ?? '' }
  }

  return nowhere
}
