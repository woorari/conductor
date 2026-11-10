import type { Ledger, Task } from '../types'
import { fillBrief, forTask } from './posts'

/**
 * What can be known about a Codex worker without Claude Code: the argv of a
 * turn, the reader of Codex's JSON events, the worker's brief and what to do
 * after a turn. Pure: it spawns nothing and touches no file.
 */

/** Codex's last message is cut to this many characters before it is stored or posted. */
export const LAST_WORDS_MAX = 20_000

export type CodexTurn = { cwd: string; servers: readonly string[]; model?: string; effort?: string; thread?: string }

const BARE = /^[A-Za-z0-9_-]+$/
/** A TOML key: bare when it can be, else quoted with its backslashes and quotes escaped. */
const key = (name: string): string => (BARE.test(name) ? name : `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)

/**
 * The argv of one turn. The sandbox is fixed (workspace-write, no network),
 * Codex's own sub-agents are off, and every server in `servers` is switched
 * off by name. The brief is never an element: the last one is `-`, which
 * makes Codex read it from stdin. `codex exec resume` takes neither `-C` nor
 * `-s`, so the runner spawns both forms with the worktree as the child's cwd
 * and a resumed turn sets the sandbox with `-c`.
 */
export function codexArgv(turn: CodexTurn): string[] {
  const options = [
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'agents.enabled=false',
    ...turn.servers.flatMap(name => ['-c', `mcp_servers.${key(name)}.enabled=false`]),
    ...(turn.model === undefined ? [] : ['-m', turn.model]),
    ...(turn.effort === undefined ? [] : ['-c', `model_reasoning_effort=${turn.effort}`]),
  ]

  return turn.thread === undefined
    ? ['codex', 'exec', '-C', turn.cwd, '-s', 'workspace-write', '--json', ...options, '-']
    : ['codex', 'exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', ...options, turn.thread, '-']
}

const KEY_PART = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*/

/** A dotted TOML key at the start of `from`: its parts, and what follows it. */
function keyPath(from: string): { parts: string[]; rest: string } | undefined {
  const parts: string[] = []
  let rest = from
  for (;;) {
    const match = KEY_PART.exec(rest)
    if (match === null) return undefined
    parts.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : (match[2] ?? match[3]!))
    rest = rest.slice(match[0].length)
    if (!rest.startsWith('.')) return { parts, rest }
    rest = rest.slice(1)
  }
}

/**
 * The names of the MCP servers a Codex config.toml declares, line by line:
 * a header `[mcp_servers.<name>]` (a sub-table such as `.env` not repeating
 * its server), a key under `[mcp_servers]` itself, or a dotted key
 * `mcp_servers.<name>...` at the top level. A key inside any other table is
 * not one. A line inside a multi-line value may be taken for a key: a server
 * found too many costs nothing, a server missed stays switched on.
 */
export function serversIn(toml: string | undefined): string[] {
  const found: string[] = []
  const add = (name: string | undefined): void => {
    if (name !== undefined && !found.includes(name)) found.push(name)
  }
  let table: 'root' | 'servers' | 'other' = 'root'

  for (const line of (toml ?? '').split(/\r?\n/)) {
    const header = /^\s*\[\[?(.*)$/.exec(line)
    if (header !== null) {
      const path = keyPath(header[1]!)
      if (path === undefined) {
        table = 'other'
        continue
      }
      if (path.parts[0] === 'mcp_servers') add(path.parts[1])
      table = path.parts[0] === 'mcp_servers' && path.parts.length === 1 ? 'servers' : 'other'
      continue
    }
    if (table === 'other' || line.trim() === '' || line.trim().startsWith('#')) continue
    const path = keyPath(line)
    if (path === undefined || !path.rest.startsWith('=')) continue
    if (table === 'servers') add(path.parts[0])
    else if (path.parts[0] === 'mcp_servers') add(path.parts[1])
  }

  return found
}

/** The servers to switch off: all that were found except the ones the project keeps. */
export const serversOff = (found: readonly string[], kept: readonly string[] | undefined): string[] =>
  found.filter(name => !(kept ?? []).includes(name))

export type CodexEvent =
  | { is: 'thread'; id: string }
  | { is: 'files'; paths: string[] }
  | { is: 'said'; text: string }
  | { is: 'ran'; command: string }
  | { is: 'ended'; ok: boolean; error?: string }

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** One JSON line as an event, or nothing when it is not one Codex's stream is known for. */
function eventOf(line: string): CodexEvent | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  const one = record(parsed)
  const type = text(one?.type)
  if (one === undefined || type === undefined) return undefined

  if (type === 'thread.started') {
    const id = text(one.thread_id)
    return id === undefined ? undefined : { is: 'thread', id }
  }
  if (type === 'turn.completed') return { is: 'ended', ok: true }
  if (type === 'turn.failed') {
    const error = text(record(one.error)?.message)
    return error === undefined ? { is: 'ended', ok: false } : { is: 'ended', ok: false, error }
  }
  if (type === 'error') {
    const error = text(one.message)
    return error === undefined ? { is: 'ended', ok: false } : { is: 'ended', ok: false, error }
  }
  if (type === 'item.started' || type === 'item.completed') {
    const item = record(one.item)
    const kind = text(item?.type)
    if (item === undefined) return undefined
    if (kind === 'command_execution') {
      const command = text(item.command)
      return command === undefined ? undefined : { is: 'ran', command }
    }
    if (type === 'item.completed' && kind === 'agent_message') {
      const said = text(item.text)
      return said === undefined ? undefined : { is: 'said', text: said.slice(0, LAST_WORDS_MAX) }
    }
    if (type === 'item.completed' && kind === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const paths = changes.map(change => text(record(change)?.path)).filter((path): path is string => path !== undefined)
      return { is: 'files', paths }
    }
  }

  return undefined
}

/**
 * Codex's `--json` stdout, line by line. A piece of the stream may end in the
 * middle of a line: the half line waits for the next piece. A line that is
 * not an event (a warning, a blank, a half-written one) is skipped.
 */
export function reader(): { feed(text: string): CodexEvent[]; rest(): CodexEvent[] } {
  let held = ''
  const read = (lines: readonly string[]): CodexEvent[] =>
    lines.flatMap(line => {
      const one = line.endsWith('\r') ? line.slice(0, -1) : line
      const event = one.trim() === '' ? undefined : eventOf(one)
      return event === undefined ? [] : [event]
    })

  return {
    feed(piece) {
      const lines = (held + piece).split('\n')
      held = lines.pop() ?? ''
      return read(lines)
    },
    rest() {
      const last = held
      held = ''
      return read([last])
    },
  }
}

/** What a Codex worker is told as its first turn: no board tools, only its task, its rules and how to end. */
export function codexBrief(ledger: Ledger, task: Task, project?: { brief: string; slot: number }): string {
  const files = task.files ?? []
  const known = forTask(ledger, task)
  const rules = project === undefined ? '' : fillBrief(project.brief, ledger, task, project.slot)

  return [
    `You build task \`${task.id}\` ("${task.title}") of run \`${ledger.run.id}\`. You work alone in this folder, which is your own copy of the repository.`,
    '',
    'Do not commit, do not push, do not open a pull request, and do not touch anything outside this folder: the conductor does all of that when you end.',
    '',
    'If there is a `CLAUDE.md` at the root of this folder, read it first: it holds the project\'s instructions.',
    '',
    files.length > 0 ? `Your task is expected to change: ${files.join(', ')}.` : 'Change only what the task needs.',
    ...(known.length > 0 ? ['', 'What the run board holds for you:', ...known] : []),
    ...(rules === '' ? [] : ['', rules]),
    '',
    'End with a short report of what you changed and what you could not do. It becomes the pull request\'s description.',
  ].join('\n')
}

/** The second turn's prompt: what went wrong, and what to do about it. */
export function again(why: { error?: string; check?: string; rulings?: string }): string {
  return [
    'Your last turn did not finish the task.',
    ...(why.error === undefined ? [] : ['', `Codex stopped with: ${why.error}`]),
    ...(why.check === undefined ? [] : ['', 'The project\'s check failed:', why.check]),
    ...(why.rulings === undefined ? [] : ['', 'New on the run board since you began:', why.rulings]),
    '',
    'Go on from where you stopped, fix what is wrong, and end with a short report of what you changed and what you could not do. Still do not commit or push.',
  ].join('\n')
}

export type After = 'again' | 'open' | 'fail'

/** What follows a turn: one more turn, once, when it failed or the check did; else the pull request, if anything changed. */
export function after(turn: { number: 1 | 2; ok: boolean; check: 'passed' | 'failed' | 'none'; changed: boolean }): After {
  if (!turn.ok || turn.check === 'failed') return turn.number === 1 ? 'again' : 'fail'

  return turn.changed ? 'open' : 'fail'
}
