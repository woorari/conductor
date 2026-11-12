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
  /** Folders outside the home folder the user chose to trust (the `trustedRoots` option), as `trustedRootsOf` read them. */
  trustedRoots?: readonly string[]
}

/** A repository home is its own workspace, as before; a folder home holds places. */
export type Home = { kind: 'repository' | 'folder'; root: string }

const CONDUCTOR = '.claude/conductor'

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))
const trimmed = (path: string): string => path.replace(/\/+$/, '')

/** Whether `inner` lies strictly inside `outer`. */
const isWithin = (outer: string, inner: string): boolean => inner.startsWith(`${outer}/`)

/**
 * The folders given in the `trustedRoots` option, which holds absolute folders
 * separated by `:` or `,`. Anything odd is ignored: a value that is no string,
 * a path that is not absolute or has a `.` or `..` part, and `/` itself, which
 * would trust the whole disk. Trailing slashes are trimmed.
 */
export function trustedRootsOf(options: unknown): string[] {
  const given = typeof options === 'object' && options !== null && !Array.isArray(options) ? (options as Record<string, unknown>).trustedRoots : undefined
  if (typeof given !== 'string') return []
  const roots = given
    .split(/[:,]/)
    .map(one => trimmed(one.trim()))
    .filter(one => one.startsWith('/') && !one.split('/').some(part => part === '.' || part === '..') && !one.includes('//'))

  return [...new Set(roots)]
}

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
 * programs that run. The one exception is a folder the user named in the
 * `trustedRoots` option (a work volume they own): a folder home may also lie
 * strictly inside one of those or the home folder by its path, with its real
 * path inside the real path of one of them (a home folder path may lead by a
 * symlink onto a trusted volume). `/` is never trusted, whatever it is given as
 * or resolves to. With no home folder known and no trusted root there is no
 * folder home.
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
  const trusted = [...new Set((io.trustedRoots ?? []).map(trimmed).filter(one => one.startsWith('/') && one !== ''))]
  const roots = [...(userHome === undefined || userHome === '' ? [] : [userHome]), ...trusted.filter(one => one !== userHome)]
  const isFolderHome = async (dir: string): Promise<boolean> => {
    if (roots.length === 0 || (await isRoot(dir)) || (await insideRepository(dir))) return false
    // Real paths are asked for only here: a repository home runs no program to be found.
    const real = await io.real(dir)
    if (real === undefined) return false
    // The path and the real path may each lie in a different root: the home folder's path can lead by a symlink onto
    // a trusted volume (/Users/me/Work -> /Volumes/Work/Work). What protects is the real path: it must lie inside one.
    if (!roots.some(root => isWithin(root, dir))) return false
    for (const root of roots) {
      const rootReal = await io.real(root)
      if (rootReal !== undefined && rootReal !== '/' && isWithin(rootReal, real)) return true
    }

    return false
  }
  // The session's own git repository is its home whenever its root holds `.claude/conductor`, as before: git names
  // the main working tree's root from a linked worktree, and the real path from a folder reached through a symlink.
  if (gitRoot !== null && (await io.exists(`${gitRoot}/${CONDUCTOR}`))) return { kind: 'repository', root: gitRoot }
  for (let dir = trimmed(cwd); dir !== ''; dir = parentOf(dir)) {
    if (dir === userHome || trusted.includes(dir) || !(await io.exists(`${dir}/${CONDUCTOR}`))) continue
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

/**
 * The workspace a root lies inside, between it and the home, or undefined.
 * Its workers' copies are made beside it, so they would land inside that one.
 */
async function enclosingRoot(io: Io, homeReal: string, root: string): Promise<string | undefined> {
  for (let above = parentOf(root); above !== '' && isWithin(homeReal, above); above = parentOf(above)) {
    if ((await kindOf(io, above)) !== undefined) return above
  }

  return undefined
}

/** A place's workspaces, without those nested in another workspace: said in `left`. */
async function ownWorkspaces(io: Io, homeReal: string, placeReal: string): Promise<{ found: { kind: WorkspaceKind; root: string }[]; left: string[] }> {
  const inside = await workspacesIn(io, placeReal)
  const found: { kind: WorkspaceKind; root: string }[] = []
  const left = [...inside.left]
  for (const one of inside.found) {
    const outer = await enclosingRoot(io, homeReal, one.root)
    if (outer === undefined) found.push(one)
    else left.push(`${one.root} lies inside the workspace ${outer}, so its workers' copies would land inside that one`)
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
    const inside = await ownWorkspaces(io, homeReal, where.real)
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
    const nearest = (await ownWorkspaces(io, homeReal, where.real)).found.filter(one => holds(one.root, folder)).sort((one, other) => other.root.length - one.root.length)[0]
    if (nearest === undefined) return nowhere

    return { candidate: { ...nearest, place: place.folder, about: place.about }, team: place.teams[0] ?? '' }
  }

  return nowhere
}
