/**
 * A project's own settings for conductor, `.claude/conductor/config.json`,
 * and what a Lore project needs before a run can start. Pure.
 */

import type { Place, ProjectConfig, RunWorkspace } from '../types'
import { TIERS } from './ledger'
import { ignoreRules, isIgnored } from './lore'

export type { Place, ProjectConfig }

export const CONFIG_PATH = '.claude/conductor/config.json'

/** What a Lore run uses where the project says nothing. */
export const LORE_DEFAULTS = { branchPrefix: 'conductor/', minFreeGB: 20, carry: [] as string[] }

const TOP = ['tickets', 'linear', 'lore', 'check', 'staffing'] as const
const LINEAR = ['team'] as const
// Which program runs is never a project's to say: a repository could name any program. That is the mod's
// Lore program option, or LORE_BIN, both the person's own.
const LORE = ['branchPrefix', 'workspaces', 'carry', 'minFreeGB', 'lockPatterns'] as const
const CHECK = ['argv', 'timeoutMin'] as const
const STAFFING = ['efforts', 'agents'] as const
const PLACE = ['folder', 'teams', 'about', 'base', 'lore', 'check', 'staffing'] as const
const TEAM_KEY = /^[A-Z][A-Z0-9]{0,9}$/
const EFFORT = /^[a-z][a-z0-9-]{0,23}$/
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

class Wrong extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** `quiet` keys are taken without being named in the message: `places` is only for a home that is not a repository. */
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
    const top = keysOf(json, '', TOP, ['places'])
    if (top.tickets !== undefined && top.tickets !== 'github' && top.tickets !== 'linear') throw new Wrong('config.json: tickets is "github" or "linear".')
    if (top.linear !== undefined) {
      const linear = keysOf(top.linear, 'linear', LINEAR)
      if (linear.team !== undefined && (typeof linear.team !== 'string' || !TEAM_KEY.test(linear.team))) {
        throw new Wrong('config.json: linear.team is a Linear team key, like ABC.')
      }
    }
    if (top.lore !== undefined) checkLore(top.lore, 'lore')
    if (top.check !== undefined) checkCheck(top.check, 'check')
    if (top.staffing !== undefined) checkStaffing(top.staffing, 'staffing')
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

/** What a project offers: the efforts each tier may run at and the agents a task may be given to. */
function checkStaffing(value: unknown, where: string): void {
  const staffing = keysOf(value, where, STAFFING)
  if (Object.keys(staffing).length === 0) throw new Wrong(`config.json: ${where} offers nothing: name efforts or agents, or leave staffing out.`)
  if (staffing.efforts !== undefined) {
    if (!isObject(staffing.efforts)) throw new Wrong(`config.json: ${where}.efforts names tiers: ${TIERS.join(', ')}.`)
    const efforts = staffing.efforts
    if (Object.keys(efforts).length === 0) throw new Wrong(`config.json: ${where}.efforts names no tier: name one of ${TIERS.join(', ')}, or leave efforts out.`)
    if (Object.keys(efforts).some(key => !(TIERS as readonly string[]).includes(key))) throw new Wrong(`config.json: ${where}.efforts names tiers: ${TIERS.join(', ')}.`)
    for (const tier of TIERS) {
      const list = efforts[tier]
      if (list === undefined) continue
      if (!Array.isArray(list) || list.length < 1 || list.length > 8 || !list.every(one => typeof one === 'string' && EFFORT.test(one)) || new Set(list).size !== list.length) {
        throw new Wrong(`config.json: ${where}.efforts.${tier} is 1 to 8 different effort names, like "high".`)
      }
    }
  }
  if (staffing.agents !== undefined) {
    const agents = staffing.agents
    if (Array.isArray(agents) && agents.length === 0) throw new Wrong(`config.json: ${where}.agents is empty: name an agent, or leave agents out.`)
    const one = (agent: unknown): boolean =>
      isObject(agent) && Object.keys(agent).every(key => key === 'id' || key === 'about') &&
      typeof agent.id === 'string' && AGENT_ID.test(agent.id) &&
      typeof agent.about === 'string' && agent.about.length >= 1 && agent.about.length <= 200 && !/[\r\n]/.test(agent.about)
    if (!Array.isArray(agents) || agents.length > 64 || !agents.every(one)) {
      throw new Wrong(`config.json: ${where}.agents holds { "id", "about" }: an id like "builder" and one line on what the agent is for.`)
    }
    const ids = (agents as { id: string }[]).map(agent => agent.id)
    const twice = ids.find((id, at) => ids.indexOf(id) !== at)
    if (twice !== undefined) throw new Wrong(`config.json: ${where}.agents names "${twice}" twice.`)
  }
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
    const place = keysOf(one, where, PLACE)
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
    if (place.staffing !== undefined) checkStaffing(place.staffing, `${where}.staffing`)
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
  for (const key of ['lore', 'check', 'linear', 'staffing'] as const) {
    if (config[key] !== undefined) return `config.json: in a home that is not a repository, ${key} belongs in a place: move it into the place it is for.`
  }
  if (config.tickets === 'github') return 'config.json: in a home that is not a repository, tickets are Linear: remove "tickets": "github".'

  return undefined
}

/** The settings a run in a place keeps, in the shape a repository's config has: its Linear team is the ticket's own. */
export function placeConfig(place: Place, team: string): ProjectConfig {
  return {
    tickets: 'linear',
    linear: { team },
    ...(place.lore === undefined ? {} : { lore: place.lore }),
    ...(place.check === undefined ? {} : { check: place.check }),
    ...(place.staffing === undefined ? {} : { staffing: place.staffing }),
  }
}

/**
 * What a run started from outside the mod keeps of its home: the whole config
 * for a repository home, or for a home that is not a repository (it lists
 * places) the workspace of the named place and that place's settings, with the
 * place's first team as its ticket's team. `look` reads the disk: where the
 * place's folder is, and whether it is there and what it holds (a folder that
 * is no repository yet counts as git). `base` is the run's one base branch: the
 * place's own, else the one asked for. Pure otherwise; answers the error text
 * when no run may start.
 */
export function runSetup(
  config: ProjectConfig,
  ask: { place?: string; base: string; look: (folder: string) => { root: string; kind: 'missing' | 'plain' | 'git' | 'lore' } },
): { base: string; config?: ProjectConfig; workspace?: RunWorkspace } | { error: string } {
  const refused = (reason: string) => ({ error: `No run was started. ${reason}` })
  const badBase = (base: string): string | undefined =>
    /^[^\s\u0000-\u001f\u007f-][^\s\u0000-\u001f\u007f]*$/.test(base) && !base.includes('..')
      ? undefined
      : `The base branch ${JSON.stringify(base)} is not a branch name: no leading "-", no spaces or control characters, no "..".`
  if (config.places === undefined) {
    if (ask.place !== undefined) return refused('This home is a repository and lists no places: the run works in it, so do not name a place.')
    const problem = homeConfigProblem(config, 'repository')
    if (problem !== undefined) return refused(problem)
    const wrong = badBase(ask.base)
    if (wrong !== undefined) return refused(wrong)

    return Object.keys(config).length === 0 ? { base: ask.base } : { base: ask.base, config }
  }
  const problem = homeConfigProblem(config, 'folder')
  if (problem !== undefined) return refused(problem)
  const bare = (folder: string): string => folder.replace(/\/+$/, '')
  const names = config.places.map(one => bare(one.folder)).join(', ')
  if (ask.place === undefined) return refused(`This home is not a repository: name the place the run works in, one of ${names}.`)
  const place = config.places.find(one => bare(one.folder) === bare(ask.place ?? ''))
  if (place === undefined) return refused(`"${ask.place}" is no place of this home: one of ${names}.`)
  const found = ask.look(place.folder)
  if (found.kind === 'missing') return refused(`The folder of the place ${bare(place.folder)}, ${place.folder}, is no folder in this home: correct config.json, or make the folder.`)

  const base = place.base ?? ask.base
  const wrong = badBase(base)
  if (wrong !== undefined) return refused(wrong)

  return {
    base,
    config: placeConfig(place, place.teams[0] ?? ''),
    workspace: { kind: found.kind === 'lore' ? 'lore' : 'git', root: found.root, place: place.folder, base },
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
