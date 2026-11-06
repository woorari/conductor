/**
 * A project's own settings for conductor, `.claude/conductor/config.json`,
 * and what a Lore project needs before a run can start. Pure.
 */

import type { ProjectConfig } from '../types'
import { ignoreRules, isIgnored } from './lore'

export type { ProjectConfig }

export const CONFIG_PATH = '.claude/conductor/config.json'

/** What a Lore run uses where the project says nothing. */
export const LORE_DEFAULTS = { branchPrefix: 'conductor/', minFreeGB: 20, carry: [] as string[] }

const TOP = ['tickets', 'linear', 'lore', 'check'] as const
const LINEAR = ['team'] as const
// Which program runs is never a project's to say: a repository could name any program. That is the mod's
// Lore program option, or LORE_BIN, both the person's own.
const LORE = ['branchPrefix', 'workspaces', 'carry', 'minFreeGB', 'lockPatterns'] as const
const CHECK = ['argv', 'timeoutMin'] as const

class Wrong extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function keysOf(value: unknown, where: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isObject(value)) throw new Wrong(`config.json: ${where === '' ? 'the file' : where} is an object.`)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Wrong(`config.json: "${where === '' ? key : `${where}.${key}`}" is no setting here (${allowed.join(', ')}).`)
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
    const top = keysOf(json, '', TOP)
    if (top.tickets !== undefined && top.tickets !== 'github' && top.tickets !== 'linear') throw new Wrong('config.json: tickets is "github" or "linear".')
    if (top.linear !== undefined) {
      const linear = keysOf(top.linear, 'linear', LINEAR)
      if (linear.team !== undefined && (typeof linear.team !== 'string' || !/^[A-Z][A-Z0-9]{0,9}$/.test(linear.team))) {
        throw new Wrong('config.json: linear.team is a Linear team key, like ABC.')
      }
    }
    if (top.lore !== undefined) {
      const lore = keysOf(top.lore, 'lore', LORE)
      for (const key of ['branchPrefix', 'workspaces'] as const) {
        if (lore[key] !== undefined && typeof lore[key] !== 'string') throw new Wrong(`config.json: lore.${key} is a string.`)
      }
      if (typeof lore.workspaces === 'string' && (!lore.workspaces.startsWith('/') || lore.workspaces.replace(/\/+$/, '') === '')) throw new Wrong('config.json: lore.workspaces is an absolute path.')
      // A branch name reaches lore as an argument: one that starts with a dash would be read as an option.
      if (typeof lore.branchPrefix === 'string' && !/^(?:[A-Za-z0-9][A-Za-z0-9._/-]*)?$/.test(lore.branchPrefix)) {
        throw new Wrong('config.json: lore.branchPrefix is letters, digits and . _ / -, starting with a letter or digit.')
      }
      for (const key of ['carry', 'lockPatterns'] as const) {
        if (lore[key] !== undefined && !strings(lore[key])) throw new Wrong(`config.json: lore.${key} is a list of paths or patterns.`)
      }
      if (lore.minFreeGB !== undefined && (typeof lore.minFreeGB !== 'number' || !Number.isInteger(lore.minFreeGB) || lore.minFreeGB < 0)) {
        throw new Wrong('config.json: lore.minFreeGB is a whole number of gigabytes from 0.')
      }
    }
    if (top.check !== undefined) {
      const check = keysOf(top.check, 'check', CHECK)
      if (!strings(check.argv) || check.argv.length === 0) throw new Wrong('config.json: check.argv is a non-empty list of strings: the program and its arguments.')
      if (typeof check.timeoutMin !== 'number' || !Number.isInteger(check.timeoutMin) || check.timeoutMin < 1 || check.timeoutMin > 240) {
        throw new Wrong('config.json: check.timeoutMin is a whole number of minutes from 1 to 240.')
      }
    }

    return { config: json as ProjectConfig }
  } catch (cause) {
    if (cause instanceof Wrong) return { error: cause.message }
    throw cause
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
