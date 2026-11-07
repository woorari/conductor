import { REVISION } from './lore'
import type {
  Activity,
  CheckRecord,
  Ledger,
  Merge,
  ModelTier,
  Orchestrator,
  Post,
  Problem,
  ProblemSeverity,
  Ruling,
  ProjectConfig,
  Task,
  TaskStatus,
  Ticket,
} from '../types'

export const TIERS: readonly ModelTier[] = ['opus', 'sonnet', 'haiku']
export const STATUSES: readonly TaskStatus[] = [
  'queued',
  'building',
  'returned',
  'review',
  'green',
  'done',
  'blocked',
  'failed',
]
const SEVERITIES: readonly ProblemSeverity[] = ['blocker', 'warning', 'note']

/** A run's folder name: it becomes part of a path, so no separator and no dot-dot. */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export type Parsed = { ledger: Ledger; error?: undefined } | { ledger?: undefined; error: string }

type Fields = Record<string, unknown>

class Refused extends Error {}

/** A Linear issue's key, as Linear writes it: the team's key, a dash, the issue's number. */
export const LINEAR_KEY = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$/

/** A commit as a person writes it: the whole id or its first digits. */
export const COMMIT = /^[0-9a-f]{7,40}$/

function show(value: unknown): string {
  if (value === undefined) return 'nothing'
  const text = JSON.stringify(value) ?? String(value)

  return text.length > 40 ? `${text.slice(0, 40)}...` : text
}

function refuse(where: string, expected: string, got: unknown): never {
  throw new Refused(`${where}: expected ${expected}, got ${show(got)}`)
}

function fields(value: unknown, where: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse(where, 'an object', value)
  }

  return value as Fields
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) refuse(where, 'a list', value)

  return value
}

function text(from: Fields, key: string, where: string): string {
  const value = from[key]
  if (typeof value !== 'string' || value.trim() === '') {
    refuse(`${where}.${key}`, 'a non-empty string', value)
  }

  return value
}

function optionalText(from: Fields, key: string, where: string): string | undefined {
  return from[key] === undefined ? undefined : text(from, key, where)
}

function optionalTime(from: Fields, key: string, where: string): string | undefined {
  const value = optionalText(from, key, where)
  if (value !== undefined && Number.isNaN(Date.parse(value))) {
    refuse(`${where}.${key}`, 'an ISO 8601 time', value)
  }

  return value
}

function optionalNumber(from: Fields, key: string, where: string): number | undefined {
  const value = from[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    refuse(`${where}.${key}`, 'a whole number from 1', value)
  }

  return value
}

/** An optional whole number from 0: a count or a percentage. */
function optionalCount(from: Fields, key: string, where: string): number | undefined {
  const value = from[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    refuse(`${where}.${key}`, 'a whole number from 0', value)
  }

  return value
}

function oneOf<T extends string>(from: Fields, key: string, where: string, allowed: readonly T[]): T {
  const value = from[key]
  const found = allowed.find(one => one === value)
  if (found === undefined) refuse(`${where}.${key}`, allowed.join(', ').replace(/, ([^,]*)$/, ' or $1'), value)

  return found
}

/** An optional list of non-empty strings. */
function texts(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined

  return list(value, where).map((one, at) => {
    if (typeof one !== 'string' || one === '') refuse(`${where}[${at}]`, 'a non-empty string', one)

    return one
  })
}

/** A GitHub issue's number or a Linear issue's key. */
function optionalTicket(from: Fields, key: string, where: string): Ticket | undefined {
  const value = from[key]
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
  if (typeof value === 'string' && LINEAR_KEY.test(value)) return value
  refuse(`${where}.${key}`, 'a whole number from 1 or an issue key like ABC-12', value)
}

function optionalKey(from: Fields, key: string, where: string): string | undefined {
  const value = optionalText(from, key, where)
  if (value !== undefined && !LINEAR_KEY.test(value)) refuse(`${where}.${key}`, 'an issue key like ABC-12', value)

  return value
}

function optionalRevision(from: Fields, key: string, where: string): string | undefined {
  const value = optionalText(from, key, where)
  if (value !== undefined && !REVISION.test(value)) refuse(`${where}.${key}`, 'a Lore revision (64 hex)', value)

  return value
}

function revisionOf(from: Fields, key: string, where: string): string {
  const value = optionalRevision(from, key, where)
  if (value === undefined) refuse(`${where}.${key}`, 'a Lore revision (64 hex)', from[key])

  return value
}

function timeOf(from: Fields, key: string, where: string): string {
  const value = optionalTime(from, key, where)
  if (value === undefined) refuse(`${where}.${key}`, 'an ISO 8601 time', from[key])

  return value
}

function checkRecord(value: unknown, where: string): CheckRecord | undefined {
  if (value === undefined) return undefined
  const from = fields(value, where)

  return {
    revision: revisionOf(from, 'revision', where),
    verdict: oneOf(from, 'verdict', where, ['running', 'passed', 'failed'] as const),
    at: timeOf(from, 'at', where),
    line: optionalText(from, 'line', where),
  }
}

/** An absolute path: a workspace is always named by where it is, never relative to anything. */
function absolute(from: Fields, key: string, where: string): string {
  const value = text(from, key, where)
  if (!value.startsWith('/')) refuse(`${where}.${key}`, 'an absolute path', value)

  return value
}

const KINDS = ['git', 'lore'] as const

function runWorkspace(value: unknown): Ledger['run']['workspace'] {
  if (value === undefined) return undefined
  const where = 'run.workspace'
  const from = fields(value, where)
  const remote = optionalText(from, 'remote', where)

  return {
    kind: oneOf(from, 'kind', where, KINDS),
    root: absolute(from, 'root', where),
    place: text(from, 'place', where),
    base: text(from, 'base', where),
    ...(remote === undefined ? {} : { remote }),
  }
}

function candidates(value: unknown): Ledger['run']['candidates'] {
  if (value === undefined) return undefined

  return list(value, 'run.candidates').map((one, at) => {
    const where = `run.candidates[${at}]`
    const from = fields(one, where)

    return { kind: oneOf(from, 'kind', where, KINDS), root: absolute(from, 'root', where), place: text(from, 'place', where), about: text(from, 'about', where) }
  })
}

function loreRun(value: unknown): Ledger['run']['lore'] {
  if (value === undefined) return undefined
  const where = 'run.lore'
  const from = fields(value, where)

  return {
    remote: text(from, 'remote', where),
    repository: text(from, 'repository', where),
    base: text(from, 'base', where),
    branch: text(from, 'branch', where),
    workspace: optionalText(from, 'workspace', where),
    baseAt: optionalRevision(from, 'baseAt', where),
    head: optionalRevision(from, 'head', where),
  }
}

function approval(value: unknown): Ledger['run']['approval'] {
  if (value === undefined) return undefined
  const where = 'run.approval'
  const from = fields(value, where)

  return { revision: revisionOf(from, 'revision', where), base: revisionOf(from, 'base', where), at: timeOf(from, 'at', where) }
}

function mergedRun(value: unknown): Ledger['run']['merged'] {
  if (value === undefined) return undefined
  const where = 'run.merged'
  const from = fields(value, where)

  return { revision: revisionOf(from, 'revision', where), at: timeOf(from, 'at', where) }
}

function post(value: unknown, where: string): Post {
  const from = fields(value, where)
  const at = text(from, 'at', where)
  if (Number.isNaN(Date.parse(at))) refuse(`${where}.at`, 'an ISO 8601 time', at)

  return {
    id: text(from, 'id', where),
    kind: oneOf(from, 'kind', where, ['finding', 'question'] as const),
    text: text(from, 'text', where),
    from: text(from, 'from', where),
    at,
    files: texts(from.files, `${where}.files`),
    for: texts(from.for, `${where}.for`),
    deliveredTo: texts(from.deliveredTo, `${where}.deliveredTo`),
    answeredBy: optionalText(from, 'answeredBy', where),
  }
}

function ruling(value: unknown, where: string): Ruling {
  const from = fields(value, where)
  const at = text(from, 'at', where)
  if (Number.isNaN(Date.parse(at))) refuse(`${where}.at`, 'an ISO 8601 time', at)

  return {
    id: text(from, 'id', where),
    text: text(from, 'text', where),
    at,
    answers: optionalText(from, 'answers', where),
    tasks: texts(from.tasks, `${where}.tasks`),
    for: texts(from.for, `${where}.for`),
    deliveredTo: texts(from.deliveredTo, `${where}.deliveredTo`),
  }
}

function orchestrator(value: unknown): Orchestrator | undefined {
  if (value === undefined) return undefined
  const from = fields(value, 'orchestrator')
  const held = from.held === undefined ? undefined : fields(from.held, 'orchestrator.held')
  const since = held === undefined ? undefined : optionalTime(held, 'since', 'orchestrator.held')
  if (held !== undefined && since === undefined) refuse('orchestrator.held.since', 'an ISO 8601 time', held.since)

  return {
    ...(held === undefined || since === undefined ? {} : { held: { since, reason: text(held, 'reason', 'orchestrator.held') } }),
    contextPercent: optionalCount(from, 'contextPercent', 'orchestrator'),
    measuredAt: optionalTime(from, 'measuredAt', 'orchestrator'),
    rotations: optionalCount(from, 'rotations', 'orchestrator'),
    rotatedAt: optionalTime(from, 'rotatedAt', 'orchestrator'),
  }
}

function activity(value: unknown, where: string): Activity | undefined {
  if (value === undefined) return undefined
  const from = fields(value, where)
  const at = text(from, 'at', where)
  if (Number.isNaN(Date.parse(at))) refuse(`${where}.at`, 'an ISO 8601 time', at)

  return { at, text: text(from, 'text', where) }
}

function task(value: unknown, where: string): Task {
  const from = fields(value, where)
  const dependsOn = texts(from.dependsOn, `${where}.dependsOn`)
  // A task's id becomes part of a folder's path (its Lore workspace) and of a branch's name: a plain name only.
  if (typeof from.id !== 'string' || !RUN_ID.test(from.id)) refuse(`${where}.id`, 'letters, digits, _ and - (at most 64)', from.id)

  return {
    id: text(from, 'id', where),
    title: text(from, 'title', where),
    tier: oneOf(from, 'tier', where, TIERS),
    tierReason: optionalText(from, 'tierReason', where),
    tierBy: from.tierBy === undefined ? undefined : oneOf(from, 'tierBy', where, ['owner'] as const),
    status: oneOf(from, 'status', where, STATUSES),
    ticket: optionalTicket(from, 'ticket', where),
    dependsOn,
    files: texts(from.files, `${where}.files`),
    touched: texts(from.touched, `${where}.touched`),
    worker: optionalText(from, 'worker', where),
    agentId: optionalText(from, 'agentId', where),
    model: optionalText(from, 'model', where),
    builtOn: optionalText(from, 'builtOn', where),
    slot: optionalNumber(from, 'slot', where),
    activity: activity(from.activity, `${where}.activity`),
    contextTokens: optionalCount(from, 'contextTokens', where),
    branch: optionalText(from, 'branch', where),
    pr: optionalNumber(from, 'pr', where),
    revision: optionalRevision(from, 'revision', where),
    workspace: optionalText(from, 'workspace', where),
    check: checkRecord(from.check, `${where}.check`),
    startedAt: optionalTime(from, 'startedAt', where),
    finishedAt: optionalTime(from, 'finishedAt', where),
    note: optionalText(from, 'note', where),
    mergeCommit: optionalText(from, 'mergeCommit', where),
    mergedAt: optionalTime(from, 'mergedAt', where),
  }
}

function mainRun(value: unknown): Ledger['main'] {
  if (value === undefined) return undefined
  const from = fields(value, 'main')
  const since = optionalTime(from, 'since', 'main')
  if (since === undefined) refuse('main.since', 'an ISO 8601 time', from.since)

  return { since, commit: optionalText(from, 'commit', 'main'), failed: optionalText(from, 'failed', 'main') }
}

function merge(value: unknown): Merge | undefined {
  if (value === undefined) return undefined
  const where = 'merge'
  const from = fields(value, where)
  const pr = optionalNumber(from, 'pr', where)
  const revision = optionalRevision(from, 'revision', where)
  if (pr === undefined && revision === undefined) refuse(`${where}.pr`, 'a whole number from 1', from.pr)
  const startedAt = optionalTime(from, 'startedAt', where)
  if (startedAt === undefined) refuse(`${where}.startedAt`, 'an ISO 8601 time', from.startedAt)
  const closes = from.closes === undefined ? undefined : list(from.closes, `${where}.closes`).map((one, at) => {
    if (typeof one !== 'number' || !Number.isInteger(one) || one < 1) refuse(`${where}.closes[${at}]`, 'a whole number from 1', one)

    return one
  })
  const common = {
    task: text(from, 'task', where),
    state: oneOf(from, 'state', where, ['merging'] as const),
    startedAt,
    told: from.told === undefined ? undefined : list(from.told, `${where}.told`).map(String),
    closes,
  }
  if (pr !== undefined) return { ...common, pr, head: text(from, 'head', where) }

  // A Lore merge: the revision it is pinned to, and where it goes.
  return { ...common, revision: revision as string, target: oneOf(from, 'target', where, ['run', 'base'] as const) }
}

function problem(value: unknown, where: string): Problem {
  const from = fields(value, where)

  return {
    id: text(from, 'id', where),
    text: text(from, 'text', where),
    severity: oneOf(from, 'severity', where, SEVERITIES),
    status: oneOf(from, 'status', where, ['open', 'resolved'] as const),
    taskId: optionalText(from, 'taskId', where),
    addressedBy: optionalText(from, 'addressedBy', where),
    foundAt: optionalTime(from, 'foundAt', where),
    askedAt: optionalTime(from, 'askedAt', where),
    resolution: optionalText(from, 'resolution', where),
  }
}

/** The first id that appears twice, or undefined. */
function repeated(ids: readonly string[]): string | undefined {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) return id
    seen.add(id)
  }

  return undefined
}

/** A chain of tasks that wait on each other, e.g. `t1 -> t2 -> t1`, or undefined. */
function cycle(tasks: readonly Task[]): string | undefined {
  const after = new Map(tasks.map(one => [one.id, one.dependsOn ?? []]))
  const settled = new Set<string>()
  const walk = (id: string, path: readonly string[]): string | undefined => {
    if (path.includes(id)) return [...path.slice(path.indexOf(id)), id].join(' -> ')
    if (settled.has(id)) return undefined
    for (const next of after.get(id) ?? []) {
      const found = walk(next, [...path, id])
      if (found !== undefined) return found
    }
    settled.add(id)

    return undefined
  }
  for (const one of tasks) {
    const found = walk(one.id, [])
    if (found !== undefined) return found
  }

  return undefined
}

function check(ledger: Ledger): void {
  const ids = ledger.tasks.map(one => one.id)
  const twice = repeated(ids)
  if (twice !== undefined) throw new Refused(`tasks: the id ${show(twice)} is used twice`)
  const twiceProblem = repeated(ledger.problems.map(one => one.id))
  if (twiceProblem !== undefined) {
    throw new Refused(`problems: the id ${show(twiceProblem)} is used twice`)
  }
  const known = new Set(ids)
  for (const one of ledger.tasks) {
    const missing = (one.dependsOn ?? []).find(id => !known.has(id))
    if (missing !== undefined) {
      throw new Refused(`task ${one.id}: dependsOn names ${show(missing)}, which is no task of this run`)
    }
    if (one.builtOn !== undefined && !known.has(one.builtOn)) {
      throw new Refused(`task ${one.id}: builtOn names ${show(one.builtOn)}, which is no task of this run`)
    }
  }
  for (const one of ledger.problems) {
    if (one.taskId !== undefined && !known.has(one.taskId)) {
      throw new Refused(`problem ${one.id}: taskId names ${show(one.taskId)}, which is no task of this run`)
    }
    if (one.addressedBy !== undefined && !known.has(one.addressedBy)) {
      throw new Refused(`problem ${one.id}: addressedBy names ${show(one.addressedBy)}, which is no task of this run`)
    }
  }
  for (const [what, all] of [['posts', ledger.posts], ['rulings', ledger.rulings]] as const) {
    const twiceSaid = repeated(all.map(one => one.id))
    if (twiceSaid !== undefined) throw new Refused(`${what}: the id ${show(twiceSaid)} is used twice`)
  }
  for (const one of ledger.posts) {
    if (one.from !== 'orchestrator' && !known.has(one.from)) {
      throw new Refused(`post ${one.id}: from names ${show(one.from)}, which is neither a task of this run nor the orchestrator`)
    }
  }
  // A Lore merge into the base branch is the run's own: its task names the run.
  if (ledger.merge !== undefined && ledger.merge.target !== 'base' && !known.has(ledger.merge.task)) {
    throw new Refused(`merge: task names ${show(ledger.merge.task)}, which is no task of this run`)
  }
  const loop = cycle(ledger.tasks)
  if (loop !== undefined) throw new Refused(`tasks wait on each other and can never start: ${loop}`)
}

/**
 * Reads a ledger file's text. Answers the ledger, or the first thing wrong
 * with it, said so a person can fix the file; never throws.
 */
export function parseLedger(source: string): Parsed {
  let json: unknown
  try {
    json = JSON.parse(source)
  } catch {
    return { error: 'the file is not valid JSON (it may be half written)' }
  }
  try {
    const from = fields(json, 'ledger')
    if (from.version !== 1) refuse('version', '1', from.version)
    const run = fields(from.run, 'run')
    const id = text(run, 'id', 'run')
    if (!RUN_ID.test(id)) refuse('run.id', 'letters, digits, _ and - (at most 64)', id)
    const ledger: Ledger = {
      version: 1,
      run: {
        id,
        title: text(run, 'title', 'run'),
        source: optionalText(run, 'source', 'run'),
        startedAt: optionalTime(run, 'startedAt', 'run'),
        plan: run.plan === undefined ? undefined : oneOf(run, 'plan', 'run', ['draft', 'proposed', 'approved'] as const),
        maxParallel: optionalNumber(run, 'maxParallel', 'run'),
        workerHandbackTokens: optionalNumber(run, 'workerHandbackTokens', 'run'),
        pausedAt: optionalTime(run, 'pausedAt', 'run'),
        tickets: run.tickets === undefined ? undefined : oneOf(run, 'tickets', 'run', ['github', 'linear'] as const),
        issue: optionalKey(run, 'issue', 'run'),
        config: run.config === undefined ? undefined : (fields(run.config, 'run.config') as ProjectConfig),
        workspace: runWorkspace(run.workspace),
        candidates: candidates(run.candidates),
        lore: loreRun(run.lore),
        approval: approval(run.approval),
        merged: mergedRun(run.merged),
        check: checkRecord(run.check, 'run.check'),
      },
      orchestrator: orchestrator(from.orchestrator),
      tasks: list(from.tasks, 'tasks').map((one, at) => task(one, `tasks[${at}]`)),
      problems: list(from.problems ?? [], 'problems').map((one, at) => problem(one, `problems[${at}]`)),
      posts: list(from.posts ?? [], 'posts').map((one, at) => post(one, `posts[${at}]`)),
      rulings: list(from.rulings ?? [], 'rulings').map((one, at) => ruling(one, `rulings[${at}]`)),
      merge: merge(from.merge),
      main: mainRun(from.main),
    }
    check(ledger)

    return { ledger }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}
