/**
 * Where a run started in a home that is not a repository works, host-neutral:
 * the workspace of its spec, the one workspace its ticket's team has, or the
 * candidates the orchestrator picks from; fixing a workspace; the pick itself.
 * The disk, the session and the programs come through a `PlaceHost`; the
 * ledger is not touched here.
 */

import type { Candidate, Ledger, Place, RunWorkspace } from '../types'
import { candidatesFor, workspaceOfSpec } from './home'
import type { Io } from './home'
import { repositoryInfoOf } from './lore'
import type { Conducting } from './plan'
import { LORE_DEFAULTS, PLACEHOLDER_SNIPPET, hasPlaceholder, homeConfigProblem, placeConfig } from './project'
import type { ProjectConfig } from './project'
import { runBranchOf } from './workspace'

/** What the placement needs from the host. `lore` and `run` never throw: they answer a non-zero exit with why. */
export type PlaceHost = {
  io(): Promise<Io>
  /** Whether the session's folder is inside a git repository. */
  isInGit(): Promise<boolean>
  /** The folder the session started in. */
  cwd(): Promise<string>
  /** A file's text, or undefined when it is not there or cannot be read. */
  read(path: string): Promise<string | undefined>
  /** Whether a `lore` program is found for a folder. */
  hasLore(cwd: string): Promise<boolean>
  /** What is said when it is not. */
  loreMissing: string
  /** Runs `lore --non-interactive <args>` in a folder. */
  lore(args: string[], cwd: string): Promise<{ exitCode: number; out: string }>
  run(argv: string[]): Promise<{ exitCode: number; stdout: string }>
  /** The mod's base branch option. */
  baseBranch: string
}

/** What a run in a home that is not a repository starts with: its workspace once fixed, or the ones the orchestrator picks from. */
export type Placed = { config: ProjectConfig; workspace?: RunWorkspace; candidates?: Candidate[]; lore?: Ledger['run']['lore'] }

export type Fixed = { workspace: RunWorkspace; config: ProjectConfig; lore?: Ledger['run']['lore'] }

export const ISSUE_IN_FOLDER =
  "No run was started. In a home that is not a repository, tickets are Linear: give the ticket's key, like /conduct ABC-12. A GitHub issue is run from a session in its own repository."

/** A Linear key's team: the part before the dash. */
export const teamOfKey = (key: string): string => key.slice(0, key.indexOf('-'))

/** Whether the folder the session started in declares the WorktreeCreate placeholder: Claude Code reads project settings there. */
async function placeholderHere(host: PlaceHost): Promise<{ isThere: boolean; folder: string }> {
  const folder = (await host.cwd()).replace(/\/+$/, '')

  return { isThere: hasPlaceholder([await host.read(`${folder}/.claude/settings.json`), await host.read(`${folder}/.claude/settings.local.json`)]), folder }
}

const placeholderMissing = (folder: string): string =>
  `No run was started. Outside git, Claude Code lets the mod make each worker's workspace only when the project declares a WorktreeCreate hook, in the folder the session started in. Add this to ${folder}/.claude/settings.local.json (or ${folder}/.claude/settings.json), then give /conduct again; if a worker still cannot start, start a new session:\n\n${PLACEHOLDER_SNIPPET}`

/**
 * Fixes the workspace a run works in, doing what /conduct does for its kind:
 * for Lore, the repository's info and the run's branch; for git, its origin.
 * Either way the session's folder must declare the placeholder when it is not
 * inside git. The run keeps its place's settings, with the ticket's team.
 */
export async function fixWorkspace(
  host: PlaceHost,
  run: { id: string; source: string; title?: string },
  candidate: Candidate,
  place: Place,
  team: string,
): Promise<Fixed | { error: string }> {
  const base = place.base ?? host.baseBranch
  const settings = placeConfig(place, team)
  const isInGit = await host.isInGit()
  if (!isInGit) {
    const here = await placeholderHere(host)
    if (!here.isThere) return { error: placeholderMissing(here.folder) }
  }
  if (candidate.kind === 'lore') {
    if (!(await host.hasLore(candidate.root))) return { error: `No run was started. ${host.loreMissing}` }
    const asked = await host.lore(['repository', 'info'], candidate.root)
    const info = asked.exitCode === 0 ? repositoryInfoOf(asked.out) : undefined
    if (info === undefined) return { error: `No run was started. lore could not read the repository of ${candidate.root}: ${asked.out.trim() || `exit ${asked.exitCode}`}` }

    return {
      workspace: { kind: 'lore', root: candidate.root, place: place.folder, base },
      config: settings,
      lore: { remote: info.remote, repository: info.name, base, branch: runBranchOf(place.lore?.branchPrefix ?? LORE_DEFAULTS.branchPrefix, run.source, run.id, run.title) },
    }
  }
  const ran = await host.run(['git', '-C', candidate.root, 'remote', 'get-url', 'origin'])
  const remote = ran.exitCode === 0 ? ran.stdout.trim() : ''

  return { workspace: { kind: 'git', root: candidate.root, place: place.folder, base, ...(remote === '' ? {} : { remote }) }, config: settings }
}

/**
 * Where a run started in a home that is not a repository works: the
 * workspace of its spec, the one workspace its ticket's team has, or the
 * candidates the orchestrator picks from.
 */
export async function placeRun(host: PlaceHost, homeRoot: string, asked: Conducting, project: ProjectConfig): Promise<Placed | { error: string }> {
  const problem = homeConfigProblem(project, 'folder')
  if (problem !== undefined) return { error: `No run was started: ${problem}` }
  if (asked.kind === 'issue') return { error: ISSUE_IN_FOLDER }
  const places = project.places ?? []
  const io = await host.io()
  const placeOf = (candidate: Candidate): Place | undefined => places.find(one => one.folder === candidate.place)
  if (asked.kind === 'spec') {
    const found = await workspaceOfSpec(io, homeRoot, places, asked.source)
    if ('error' in found) return found
    const place = placeOf(found.candidate)

    return place === undefined ? { error: 'No run was started: the spec\'s place is not in config.json.' } : await fixWorkspace(host, asked, found.candidate, place, found.team)
  }
  const team = teamOfKey(asked.source)
  const found = await candidatesFor(io, homeRoot, places, team)
  if ('error' in found) return found
  const only = found.candidates.length === 1 ? found.candidates[0] : undefined
  const place = only === undefined ? undefined : placeOf(only)
  if (only !== undefined && place !== undefined) return await fixWorkspace(host, asked, only, place, team)

  return { config: { places: places.filter(one => one.teams.includes(team)) }, candidates: found.candidates }
}

/**
 * `run_workspace`, up to the write: the workspace the orchestrator named,
 * looked up again in the places frozen at /conduct (never the live config) and
 * fixed; or why it cannot be.
 */
export async function pickWorkspace(
  host: PlaceHost,
  ledger: Ledger,
  homeRoot: string,
  given: unknown,
): Promise<{ error: string } | { chosen: Candidate; places: Place[]; fixed: Fixed }> {
  const asked = typeof given === 'string' ? given.replace(/\/+$/, '') : ''
  const places = ledger.run.config?.places ?? []
  const source = ledger.run.source ?? ledger.run.id
  const team = teamOfKey(source)
  const fresh = await candidatesFor(await host.io(), homeRoot, places, team)
  if ('error' in fresh) return fresh
  const chosen = fresh.candidates.find(one => one.root === asked)
  const place = chosen === undefined ? undefined : places.find(one => one.folder === chosen.place)
  if (chosen === undefined || place === undefined) return { error: `${asked || 'That'} is not one of the workspaces this run lists: ${fresh.candidates.map(one => one.root).join(', ')}.` }
  const title = ledger.run.title === `Run ${ledger.run.id}` ? undefined : ledger.run.title
  const fixed = await fixWorkspace(host, { id: ledger.run.id, source, ...(title === undefined ? {} : { title }) }, chosen, place, team)
  if ('error' in fixed) return fixed

  return { chosen, places, fixed }
}
