/**
 * A project's own settings for conductor, `.claude/conductor/config.json`,
 * and what a Lore project needs before a run can start. Pure.
 */

import type { Place, ProjectConfig } from '../types'
import { ignoreRules, isIgnored } from './lore'

export type { Place, ProjectConfig }

export const CONFIG_PATH = '.claude/conductor/config.json'

/** What a Lore run uses where the project says nothing. */
export const LORE_DEFAULTS = { branchPrefix: 'conductor/', minFreeGB: 20, carry: [] as string[] }

const TOP = ['tickets', 'linear', 'lore', 'check'] as const
const LINEAR = ['team'] as const
// Which program runs is never a project's to say: a repository could name any program. That is the mod's
// Lore program option, or LORE_BIN, both the person's own.
const LORE = ['branchPrefix', 'workspaces', 'carry', 'minFreeGB', 'lockPatterns'] as const
const CHECK = ['argv', 'timeoutMin'] as const
const WORKERS = ['codex', 'notes', 'models', 'mcp'] as const
const PLACE_WORKERS = ['notes'] as const
const WORKER_NOTE = ['kind', 'for', 'proven'] as const
const WORKER_MODEL = ['model', 'effort'] as const
const TIERS = ['opus', 'sonnet', 'haiku'] as const
const PLACE = ['folder', 'teams', 'about', 'base', 'lore', 'check'] as const
const TEAM_KEY = /^[A-Z][A-Z0-9]{0,9}$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

class Wrong extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** `quiet` keys are taken without being named in the message: `places` is only for a home that is not a repository; `workers` is opt-in. */
function keysOf(value: unknown, where: string, allowed: readonly string[], quiet: readonly string[] = []): Record<string, unknown> {
  if (!isObject(value)) throw new Wrong(`config.json: ${where === '' ? 'the file' : where} is an object.`)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key) && !quiet.includes(key)) throw new Wrong(`config.json: "${where === '' ? key : `${where}.${key}`}" is no setting here (${allowed.join(', ')}).`)
  }

  return value
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(one => typeof one === 'string' && one !== '')

/**
 * Reads the file's text: undefined (no file) is an empty config. Answers the
 * config as written, or the first thing wrong with it, named.
 */
export function parseConfig(text: string | undefined): { config: ProjectConfig } | { error: string } {
  if (text === undefined) return { config: {} }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { error: 'config.json is not valid JSON.' }
  }
  try {
    const top = keysOf(json, '', TOP, ['places', 'workers'])
    if (top.tickets !== undefined && top.tickets !== 'github' && top.tickets !== 'linear') throw new Wrong('config.json: tickets is "github" or "linear".')
    if (top.linear !== undefined) {
      const linear = keysOf(top.linear, 'linear', LINEAR)
      if (linear.team !== undefined && (typeof linear.team !== 'string' || !TEAM_KEY.test(linear.team))) {
        throw new Wrong('config.json: linear.team is a Linear team key, like ABC.')
      }
    }
    if (top.lore !== undefined) checkLore(top.lore, 'lore')
    if (top.check !== undefined) checkCheck(top.check, 'check')
    if (top.workers !== undefined) checkWorkers(top.workers, 'workers', false)
    if (top.places !== undefined) checkPlaces(top.places)

    return { config: json as ProjectConfig }
  } catch (cause) {
    if (cause instanceof Wrong) return { error: cause.message }
    throw cause
  }
}

function checkLore(value: unknown, where: string): void {
  const lore = keysOf(value, where, LORE)
  for (const key of ['branchPrefix', 'workspaces'] as const) {
    if (lore[key] !== undefined && typeof lore[key] !== 'string') throw new Wrong(`config.json: ${where}.${key} is a string.`)
  }
  if (typeof lore.workspaces === 'string' && (!lore.workspaces.startsWith('/') || lore.workspaces.replace(/\/+$/, '') === '')) throw new Wrong(`config.json: ${where}.workspaces is an absolute path.`)
  // A branch name reaches lore as an argument: one that starts with a dash would be read as an option.
  if (typeof lore.branchPrefix === 'string' && !/^(?:[A-Za-z0-9][A-Za-z0-9._/-]*)?$/.test(lore.branchPrefix)) {
    throw new Wrong(`config.json: ${where}.branchPrefix is letters, digits and . _ / -, starting with a letter or digit.`)
  }
  for (const key of ['carry', 'lockPatterns'] as const) {
    if (lore[key] !== undefined && !strings(lore[key])) throw new Wrong(`config.json: ${where}.${key} is a list of paths or patterns.`)
  }
  if (lore.minFreeGB !== undefined && (typeof lore.minFreeGB !== 'number' || !Number.isInteger(lore.minFreeGB) || lore.minFreeGB < 0)) {
    throw new Wrong(`config.json: ${where}.minFreeGB is a whole number of gigabytes from 0.`)
  }
}

function checkCheck(value: unknown, where: string): void {
  const check = keysOf(value, where, CHECK)
  if (!strings(check.argv) || check.argv.length === 0) throw new Wrong(`config.json: ${where}.argv is a non-empty list of strings: the program and its arguments.`)
  if (typeof check.timeoutMin !== 'number' || !Number.isInteger(check.timeoutMin) || check.timeoutMin < 1 || check.timeoutMin > 240) {
    throw new Wrong(`config.json: ${where}.timeoutMin is a whole number of minutes from 1 to 240.`)
  }
}

/** The `workers` settings: a place keeps only its notes, the switch, models and servers are the home's. */
function checkWorkers(value: unknown, where: string, inPlace: boolean): void {
  const workers = keysOf(value, where, inPlace ? PLACE_WORKERS : WORKERS)
  if (workers.codex !== undefined && typeof workers.codex !== 'boolean') throw new Wrong(`config.json: ${where}.codex is true or false.`)
  if (workers.notes !== undefined) {
    if (!Array.isArray(workers.notes)) throw new Wrong(`config.json: ${where}.notes is a list of notes.`)
    workers.notes.forEach((one, at) => {
      const here = `${where}.notes[${at}]`
      const note = keysOf(one, here, WORKER_NOTE)
      if (note.kind !== 'claude' && note.kind !== 'codex') throw new Wrong(`config.json: ${here}.kind is "claude" or "codex".`)
      if (typeof note.for !== 'string' || note.for.trim() === '') throw new Wrong(`config.json: ${here}.for says, in a line, what kind of work this note is about.`)
      if (typeof note.proven !== 'boolean') throw new Wrong(`config.json: ${here}.proven is true or false.`)
    })
  }
  if (workers.models !== undefined) {
    const models = keysOf(workers.models, `${where}.models`, TIERS)
    for (const tier of Object.keys(models)) {
      const one = keysOf(models[tier], `${where}.models.${tier}`, WORKER_MODEL)
      if (typeof one.model !== 'string' || one.model.trim() === '') throw new Wrong(`config.json: ${where}.models.${tier}.model is a model name.`)
      if (one.effort !== undefined && one.effort !== 'low' && one.effort !== 'medium' && one.effort !== 'high') {
        throw new Wrong(`config.json: ${where}.models.${tier}.effort is "low", "medium" or "high".`)
      }
    }
  }
  if (workers.mcp !== undefined && !strings(workers.mcp)) throw new Wrong(`config.json: ${where}.mcp is a list of server names.`)
}

/** A place's folder as its segments, a trailing slash dropped: undefined for one that is not a plain path inside the home. */
function segmentsOf(folder: unknown): string[] | undefined {
  if (typeof folder !== 'string') return undefined
  const trimmed = folder.replace(/\/+$/, '')
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.startsWith('~') || /[\\\u0000]/.test(trimmed)) return undefined
  const segments = trimmed.split('/')

  return segments.every(one => one !== '' && one !== '.' && one !== '..') ? segments : undefined
}

/** What is wrong with a place's folder, or undefined: a plain path relative to the home, never a way out of it. */
export function folderProblem(folder: unknown, at: number): string | undefined {
  return segmentsOf(folder) === undefined ? `config.json: places[${at}].folder must be a folder inside this home, given relative to it.` : undefined
}

/** Whether one folder is the other, or lies inside it. */
const overlaps = (one: readonly string[], other: readonly string[]): boolean => one.slice(0, Math.min(one.length, other.length)).every((part, at) => part === other[at])

function checkPlaces(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) throw new Wrong('config.json: places is a list of one or more places.')
  const seen: string[][] = []
  value.forEach((one, at) => {
    const where = `places[${at}]`
    const place = keysOf(one, where, PLACE, ['workers'])
    const problem = folderProblem(place.folder, at)
    if (problem !== undefined) throw new Wrong(problem)
    const segments = segmentsOf(place.folder) ?? []
    const other = seen.findIndex(them => overlaps(them, segments))
    if (other !== -1) throw new Wrong(`config.json: ${where}.folder lies inside, above or on places[${other}].folder: places may not overlap.`)
    seen.push(segments)
    if (!Array.isArray(place.teams) || place.teams.length === 0 || !place.teams.every(team => typeof team === 'string' && TEAM_KEY.test(team))) {
      throw new Wrong(`config.json: ${where}.teams is a list of one or more Linear team keys, like ["ABC"].`)
    }
    if (typeof place.about !== 'string' || place.about.trim() === '' || /[\r\n]/.test(place.about)) throw new Wrong(`config.json: ${where}.about is one line that says what belongs there.`)
    if (place.base !== undefined && (typeof place.base !== 'string' || !BRANCH.test(place.base))) {
      throw new Wrong(`config.json: ${where}.base is a branch name: letters, digits and . _ / -, starting with a letter or digit.`)
    }
    if (place.lore !== undefined) checkLore(place.lore, `${where}.lore`)
    if (place.check !== undefined) checkCheck(place.check, `${where}.check`)
    if (place.workers !== undefined) checkWorkers(place.workers, `${where}.workers`, true)
  })
}

/**
 * What a home's config lacks or holds that does not belong there, or
 * undefined. A repository home is its own workspace and lists no places; a
 * home that is not a repository lists them, and keeps the settings of each
 * workspace in its place.
 */
export function homeConfigProblem(config: ProjectConfig, kind: 'repository' | 'folder'): string | undefined {
  if (kind === 'repository') {
    return config.places === undefined ? undefined : 'config.json: places is for a home that is not itself a repository. Here the repository is the workspace: remove places.'
  }
  if (config.places === undefined) {
    return 'config.json: this home is not a repository, so it lists its places, for example {"places": [{"folder": "studio", "teams": ["ABC"], "about": "what belongs there"}]}.'
  }
  for (const key of ['lore', 'check', 'linear'] as const) {
    if (config[key] !== undefined) return `config.json: in a home that is not a repository, ${key} belongs in a place: move it into the place it is for.`
  }
  if (config.tickets === 'github') return 'config.json: in a home that is not a repository, tickets are Linear: remove "tickets": "github".'

  return undefined
}

/**
 * The settings a run in a place keeps, in the shape a repository's config has: its Linear team is the ticket's own.
 * The home's `workers` apply to every place, the place's own notes after them.
 */
export function placeConfig(place: Place, team: string, home?: ProjectConfig): ProjectConfig {
  const notes = [...(home?.workers?.notes ?? []), ...(place.workers?.notes ?? [])]
  const workers = home?.workers === undefined && place.workers === undefined ? undefined : { ...home?.workers, ...(notes.length === 0 ? {} : { notes }) }

  return {
    tickets: 'linear',
    linear: { team },
    ...(place.lore === undefined ? {} : { lore: place.lore }),
    ...(place.check === undefined ? {} : { check: place.check }),
    ...(workers === undefined ? {} : { workers }),
  }
}

/**
 * The settings entry a Lore project declares so Claude Code lets the mod make
 * a worker's workspace (Claude Code asks for a WorktreeCreate hook outside
 * git). The mod answers first; this command runs only without the mod.
 */
export const PLACEHOLDER_SNIPPET = JSON.stringify(
  {
    hooks: {
      WorktreeCreate: [
        { hooks: [{ type: 'command', command: "echo 'Worker workspaces here are made by the conductor mod. Install or enable conductor.' >&2; exit 1" }] },
      ],
    },
  },
  null,
  2,
)

/** Whether `.claude/settings.json` or `.claude/settings.local.json` declares a WorktreeCreate command hook. */
export function hasPlaceholder(settings: readonly (string | undefined)[]): boolean {
  return settings.some(text => {
    if (text === undefined) return false
    try {
      const json = JSON.parse(text) as unknown
      if (!isObject(json) || !isObject(json.hooks)) return false
      const entries = json.hooks.WorktreeCreate

      return Array.isArray(entries) && entries.some(entry => isObject(entry) && Array.isArray(entry.hooks) && entry.hooks.some(hook => isObject(hook) && hook.type === 'command'))
    } catch {
      return false
    }
  })
}

/** Whether `.loreignore` keeps the run ledgers out of Lore: they are rewritten every few seconds. */
export const runsIgnored = (loreignore: string | undefined): boolean =>
  loreignore !== undefined && isIgnored(ignoreRules(loreignore), '.claude/conductor/runs/x/ledger.json', false)
