import type { Activity, ModelTier, ProblemSeverity, TaskStatus, Ticket, WorkerKind, WorkerNote } from '../types'
import { WORKER_KINDS as KINDS, LINEAR_KEY, RUN_ID, STATUSES, TIERS } from './ledger'
import { REVISION } from './lore'
import { LOOK_AGAIN_MIN, afterDone, dueForLook, isUnderway, lostWith, named, standing, standingText } from './problems'

/**
 * Every change the mod makes to a ledger, as a pure edit of the file's own
 * JSON. The edits work on the parsed file and not on a validated copy, so a
 * field this version does not know survives a rewrite; the store validates
 * the result before it writes.
 */

export { KINDS }

/** The kind of worker a task has: `claude` when none is recorded. */
export const kindOf = (task: { kind?: WorkerKind }): WorkerKind => task.kind ?? 'claude'

export type RawTask = Record<string, unknown> & { id: string; status: TaskStatus }

export type RawProblem = Record<string, unknown> & { id: string }
export type RawPost = Record<string, unknown> & { id: string }
export type Raw = Record<string, unknown> & {
  tasks: RawTask[]
  problems?: RawProblem[]
  posts?: RawPost[]
  rulings?: RawPost[]
}

/**
 * Who is asking for a change: the main conversation, a task's worker (or its
 * subagent), another agent, or the person at the pane or the prompt.
 */
export type Caller =
  | { kind: 'orchestrator' }
  | { kind: 'worker'; taskId: string }
  | { kind: 'stranger' }
  | { kind: 'owner' }

/** Where on the board a message comes from, so that handing it over can be written there. */
export type Source = { list: 'posts' | 'rulings'; id: string }

/**
 * Something a task's worker is to read. The mod sends no messages: a worker
 * is handed what waits for it with the result of its own next tool call.
 */
export type Delivery = { taskId: string; text: string; source?: Source }

/**
 * What a change answers: the line its caller reads, whether the ledger is to
 * be written, and who is to read what once it is: workers (`deliveries`),
 * and the orchestrator by a prompt that wakes it (`wake`) or a note with its
 * next tool result (`tell`).
 */
export type Outcome = {
  isChanged: boolean
  isError: boolean
  text: string
  deliveries?: Delivery[]
  wake?: string
  tell?: string
  /** The question this change asked: `wake` is what the orchestrator is told about it. */
  asks?: string
  /** The question this change answered, which nobody needs to be told about any more. */
  answered?: string
}

/** Writes on posts and rulings which workers were handed them. Answers whether anything changed. */
export function markRead(raw: Raw, read: readonly { source: Source; taskId: string }[]): boolean {
  let isChanged = false
  for (const { source, taskId } of read) {
    const entry = (raw[source.list] ?? []).find(one => one.id === source.id)
    if (entry === undefined) continue
    const known = Array.isArray(entry.deliveredTo) ? (entry.deliveredTo as unknown[]).filter(one => typeof one === 'string') : []
    if (known.includes(taskId)) continue
    entry.deliveredTo = [...known, taskId]
    isChanged = true
  }

  return isChanged
}

export const refused = (text: string): Outcome => ({ isChanged: false, isError: true, text })
export const changed = (text: string): Outcome => ({ isChanged: true, isError: false, text })

/** A worker may say where its own task stands; only the orchestrator queues, readies or finishes one. */
const WORKER_STATUSES: readonly TaskStatus[] = ['review', 'blocked', 'failed']
const SEVERITIES: readonly ProblemSeverity[] = ['blocker', 'warning', 'note']
const NOTE_MAX = 200
const PROBLEM_MAX = 500
const FILES_MAX = 40
/** The most files or folders one task may be expected to change (proposed, not measured). */
const TICKET_HELP = 'ticket is the issue’s number, a whole number from 1, or its Linear key, like ABC-12.'

/** A GitHub issue's number or a Linear issue's key. */
export const isTicket = (value: unknown): value is Ticket =>
  (typeof value === 'number' && Number.isInteger(value) && value >= 1) || (typeof value === 'string' && LINEAR_KEY.test(value))

/** How a ticket is named in what the board says: `#391` on GitHub, `ABC-12` in Linear. */
export const ticketName = (ticket: Ticket): string => (typeof ticket === 'number' ? `#${ticket}` : ticket)

export const FILES_PER_TASK = 12

/** A path as the board compares it: no `./` in front, no `/` behind, single slashes. */
export const normalise = (path: string): string =>
  tidy(path)
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')

/** A list of files or folders from a tool's input: normalised, without repeats; undefined when it is no such list. */
export function fileList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some(one => typeof one !== 'string' || normalise(one) === '')) return undefined
  const all = [...new Set((value as string[]).map(normalise))]

  return all.length > FILES_MAX ? undefined : all
}

/** True when one names the other, or a folder the other lies in. */
export const overlap = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

export const covers = (files: readonly string[], file: string): boolean => files.some(one => overlap(one, file))

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(one => typeof one === 'string') : [])

export const tidy = (text: string): string =>
  text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const baseName = (path: unknown): string => (typeof path === 'string' ? (path.split('/').pop() ?? '') : '')

/**
 * One short line for a tool call, safe to keep in a file: the tool and what
 * it names (a file's name, the model's own description of a command), never a
 * command's text, a pattern or a message, which can carry a secret.
 */
export function activityText(call: { tool: string } & Record<string, unknown>): string {
  const tool = String(call.tool)
  const said = typeof call.description === 'string' ? tidy(call.description) : ''
  let text = tool
  if (tool === 'Bash') text = said === '' ? 'Bash' : `Bash: ${said}`
  else if (tool === 'Edit' || tool === 'Write' || tool === 'Read' || tool === 'NotebookEdit') {
    const name = baseName(call.file_path ?? call.notebook_path)
    text = name === '' ? tool : `${tool} ${name}`
  } else if (tool === 'Agent' || tool === 'Task') text = said === '' ? 'Subagent' : `Subagent: ${said}`
  else if (tool === 'Skill' && typeof call.skill === 'string') text = `Skill ${tidy(call.skill)}`
  else if (tool.startsWith('mcp__')) text = tool.split('__').slice(1).join(' ')
  text = tidy(text)

  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

/** The task an agent of this name works on: named after the task, or after the worker the task names. */
function taskFor(raw: Raw, name: string): RawTask | undefined {
  return raw.tasks.find(task => task.id === name) ?? raw.tasks.find(task => task.worker === name)
}

/** A worker started: its task is building from now. Answers the task's id, or undefined when the name is no task's. */
export function spawned(
  raw: Raw,
  at: string,
  spawn: { name: string; agentId: string; model: string; slot?: number },
): string | undefined {
  const task = taskFor(raw, spawn.name)
  if (task === undefined || task.status === 'done') return undefined
  task.status = 'building'
  task.worker = spawn.name
  task.agentId = spawn.agentId
  task.model = spawn.model
  if (spawn.slot !== undefined) task.slot = spawn.slot
  task.startedAt ??= at
  delete task.finishedAt
  task.activity = { at, text: 'started' } satisfies Activity

  return task.id
}

/**
 * A worker is about to start: its task counts as building from now, before
 * the engine has started anything, so that the next worker asked for in the
 * same moment is judged against a board that already holds this one. Answers
 * the task as it stood, to put back if the start fails; undefined when the
 * run has no such task.
 */
export function reserved(raw: Raw, at: string, claim: { taskId: string; name: string; slot: number; builtOn?: string }): RawTask | undefined {
  const task = raw.tasks.find(one => one.id === claim.taskId)
  if (task === undefined) return undefined
  const before = JSON.parse(JSON.stringify(task)) as RawTask
  task.status = 'building'
  task.worker = claim.name
  task.slot = claim.slot
  if (claim.builtOn !== undefined) task.builtOn = claim.builtOn
  task.startedAt ??= at
  delete task.finishedAt
  task.activity = { at, text: 'starting' } satisfies Activity

  return before
}

/** The start failed: the task stands again as it stood before it was reserved. */
export function released(raw: Raw, before: RawTask): boolean {
  const at = raw.tasks.findIndex(one => one.id === before.id)
  if (at === -1) return false
  raw.tasks[at] = before

  return true
}

/**
 * A worker was seen acting. A worker whose turn had ended is one that was
 * resumed, so its task is building again. Answers whether anything changed.
 */
export function acted(raw: Raw, taskId: string, activity: Activity): boolean {
  const task = raw.tasks.find(one => one.id === taskId)
  if (task === undefined || task.status === 'done') return false
  // Taken back and not started again: what was seen came from the retired worker, and does not count.
  if (task.agentId === undefined && Array.isArray(task.retired) && task.retired.length > 0) return false
  if (task.finishedAt !== undefined) {
    delete task.finishedAt
    if (task.status === 'returned' || task.status === 'blocked' || task.status === 'failed') task.status = 'building'
  }
  task.activity = activity

  return true
}

/** How full the orchestrator's context is, as just measured. Written when the whole percent changed. */
export function gauge(raw: Raw, at: string, percent: number): boolean {
  const own = (raw.orchestrator ??= {}) as Record<string, unknown>
  const whole = Math.max(0, Math.round(percent))
  if (own.contextPercent === whole) return false
  // A context only shrinks by a compaction, whoever asked for it: none is held up any more.
  if (typeof own.contextPercent === 'number' && whole < own.contextPercent) delete own.held
  own.contextPercent = whole
  own.measuredAt = at

  return true
}

const REASON_MAX = 240

/**
 * A compaction that was due did not go through. The engine's own reason is
 * kept, with the moment it was first given: before this the mod tried again
 * every half minute and said nothing (measured 2026-10-09: refused for a
 * quarter of an hour in the first real run, the reason unknown to anyone).
 * Written when the reason is new; answers whether it was.
 */
export function heldUp(raw: Raw, at: string, reason: string): boolean {
  const own = (raw.orchestrator ??= {}) as Record<string, unknown>
  const text = tidy(reason).slice(0, REASON_MAX) || 'no reason given'
  const was = own.held as { reason?: unknown } | undefined
  if (was?.reason === text) return false
  own.held = { since: at, reason: text }

  return true
}

/** The session was compacted with the run's handover. */
export function rotated(raw: Raw, at: string): void {
  const own = (raw.orchestrator ??= {}) as Record<string, unknown>
  own.rotations = (typeof own.rotations === 'number' ? own.rotations : 0) + 1
  own.rotatedAt = at
  delete own.held
}

/**
 * How many tokens a worker's context holds, from its last model request.
 * Written when it moved by a thousand or more, to keep the file quiet.
 */
export function weigh(raw: Raw, taskId: string, tokens: number): boolean {
  const task = raw.tasks.find(one => one.id === taskId)
  if (task === undefined || task.status === 'done') return false
  const was = typeof task.contextTokens === 'number' ? task.contextTokens : 0
  if (Math.abs(tokens - was) < 1000) return false
  task.contextTokens = Math.round(tokens)

  return true
}

/**
 * A worker whose context passed the run's own limit is asked to hand back.
 * Undefined when the run sets no limit, the task is not building, or it is under.
 */
export function overweight(raw: Raw, taskId: string, tokens: number): Delivery | undefined {
  const limit = (raw.run as Record<string, unknown> | undefined)?.workerHandbackTokens
  const task = raw.tasks.find(one => one.id === taskId)
  if (typeof limit !== 'number' || task === undefined || task.status !== 'building' || tokens < limit) return undefined

  return {
    taskId,
    text: `Run board: your context holds about ${Math.round(tokens / 1000)} thousand tokens, past this run's limit for a worker. At your next green step, commit and push, write in your task's note where you stopped, and hand back by ending your turn. A fresh worker goes on from your branch.`,
  }
}

/** A worker's turn ended: a building task is handed back, and its bar stops here. */
export function turnEnded(raw: Raw, at: string, agentId: string, reason: string): string | undefined {
  const task = raw.tasks.find(one => one.agentId === agentId)
  if (task === undefined || task.status === 'done') return undefined
  task.finishedAt = at
  if (task.status === 'building') task.status = 'returned'
  const text = reason === 'answer' ? 'handed back' : reason === 'aborted' ? 'stopped: interrupted' : `stopped: ${tidy(reason)}`
  task.activity = { at, text } satisfies Activity

  return task.id
}

const describe = (caller: Caller): string =>
  caller.kind === 'worker' ? `the worker of ${caller.taskId}` : 'an agent that is no task’s worker'

const TITLE_MAX = 120

/**
 * A task's tier is set before it starts. The orchestrator gives its reason
 * and leaves a tier the owner set alone; the owner's word needs no reason.
 */
function retier(task: RawTask, caller: Caller, tier: unknown, reason: unknown): Outcome | undefined {
  const next = TIERS.find(one => one === tier)
  if (next === undefined) return refused(`tier is one of ${TIERS.join(', ')}: opus for architecture and design, sonnet for challenging development, haiku for easy jobs.`)
  if (caller.kind !== 'orchestrator' && caller.kind !== 'owner') return refused('Only the orchestrator and the owner set a task’s tier.')
  if (task.status !== 'queued') {
    return refused(`${task.id} is ${task.status}; a tier is set before a task starts.`)
  }
  if (caller.kind === 'owner') {
    task.tier = next
    task.tierBy = 'owner'

    return undefined
  }
  if (next === 'opus' && task.kind === 'codex' && task.kindWhy === 'spread') return refused(OPUS_STAYS)
  if (task.tierBy === 'owner') return refused(`The owner set ${task.id} to ${String(task.tier)}; only they change it.`)
  if (typeof reason !== 'string' || tidy(reason) === '') return refused('Say in one line why the task has this tier: {"tier": "...", "tierReason": "..."}.')
  task.tier = next
  task.tierReason = tidy(reason).slice(0, NOTE_MAX)

  return undefined
}

const OPUS_STAYS = 'Architecture and design stay on Claude unless a suitability note says otherwise.'

/**
 * Decides a new or changed kind of worker for a queued task, and sets it. `kindNote` is the
 * 1-based index into the run's `workers.notes`. Answers a refusal text, or undefined.
 */
export function rekind(
  raw: Raw,
  task: RawTask,
  caller: Caller,
  kind: WorkerKind,
  reason: string | undefined,
  kindNote: number | undefined,
): string | undefined {
  if (caller.kind !== 'orchestrator' && caller.kind !== 'owner') return 'Only the orchestrator and the owner set a task’s kind of worker.'
  if (task.status !== 'queued') return `${task.id} has started; its kind of worker is fixed.`
  const run = planOf(raw) as { codex?: { ready?: boolean; why?: string }; config?: { workers?: { notes?: WorkerNote[] } } }
  if (kind === 'codex' && run.codex?.ready !== true) {
    return `Codex workers are off for this run${run.codex?.why === undefined ? '' : `: ${run.codex.why}`}.`
  }
  const why = reason === undefined ? undefined : tidy(reason).slice(0, NOTE_MAX)
  if (caller.kind === 'owner') {
    task.kind = kind
    task.kindWhy = 'owner'
    if (why !== undefined && why !== '') task.kindReason = why
    else delete task.kindReason

    return undefined
  }
  if (task.kindWhy === 'owner') return `The owner chose ${kindOf({ kind: task.kind as WorkerKind | undefined })} for ${task.id}; only they change it.`
  if (why === undefined || why === '') return 'Say in one line why the task has this kind of worker: {"kind": "...", "kindReason": "..."}.'
  let kindWhy: 'note' | 'trial' | 'design' | 'spread'
  if (kindNote !== undefined) {
    const found = run.config?.workers?.notes?.[kindNote - 1]
    if (found === undefined || found.kind !== kind) return `kindNote ${kindNote} names no suitability note for ${kind} workers in this run.`
    kindWhy = found.proven ? 'note' : 'trial'
  } else if (task.tier === 'opus') {
    if (kind === 'codex') return OPUS_STAYS
    kindWhy = 'design'
  } else kindWhy = 'spread'
  task.kind = kind
  task.kindReason = why
  task.kindWhy = kindWhy

  return undefined
}

/** `/worker`: the owner sets a queued task's kind of worker. */
export function ownerSetsKind(raw: Raw, taskId: string, kind: string): Outcome {
  const task = raw.tasks.find(one => one.id === taskId)
  if (task === undefined) return refused(`There is no task ${taskId} in this run.`)
  const next = KINDS.find(one => one === kind)
  if (next === undefined) return refused(`kind is one of ${KINDS.join(', ')}.`)
  const was = kindOf({ kind: task.kind as WorkerKind | undefined })
  const no = rekind(raw, task, { kind: 'owner' }, next, undefined, undefined)
  if (no !== undefined) return refused(no)

  return changed(was === next ? `${taskId} stays on ${next}, now by your word.` : `${taskId}: ${was} to ${next}.`)
}

const planOf = (raw: Raw): Record<string, unknown> => raw.run as Record<string, unknown>

/** In a home that is not a repository: the run lists workspaces and none is picked yet. */
const isPickOpen = (run: Record<string, unknown>): boolean => run.candidates !== undefined && run.workspace === undefined
const PICK_FIRST = "Pick the run's workspace first: run_workspace takes one of the workspaces this run lists."

/** `run_plan`: the orchestrator says the plan is ready for the owner, and may name the run. */
export function proposePlan(raw: Raw, caller: Caller, input: Record<string, unknown>): Outcome {
  if (caller.kind !== 'orchestrator') return refused('Only the orchestrator proposes the run’s plan.')
  const run = planOf(raw)
  if (run.plan === 'approved' || run.plan === undefined) return refused('The plan of this run is approved already.')
  if (isPickOpen(run)) return refused(PICK_FIRST)
  if (raw.tasks.length === 0) return refused('A plan needs tasks: add them with task_add first.')
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || tidy(input.title) === '') return refused('title names the run in a few words.')
    run.title = tidy(input.title).slice(0, TITLE_MAX)
  }
  run.plan = 'proposed'

  return changed(
    `The plan is proposed: ${raw.tasks.length} ${raw.tasks.length === 1 ? 'task' : 'tasks'}. No worker starts before the owner approves it with /approve. Tell them the plan in a few lines now, and stop.`,
  )
}

/** `/approve`: the owner lets the workers start. */
export function approvePlan(raw: Raw): Outcome {
  const run = planOf(raw)
  if (run.plan === 'approved' || run.plan === undefined) return refused('The plan of this run is approved already.')
  if (isPickOpen(run)) return refused(PICK_FIRST)
  if (run.plan !== 'proposed') return refused('The orchestrator has not proposed a plan yet: there is nothing to approve.')
  run.plan = 'approved'

  return changed(`Plan approved: ${raw.tasks.length} ${raw.tasks.length === 1 ? 'task' : 'tasks'} may start.`)
}

/** `/tier` and the pane's picker: the owner sets a queued task's tier. */
export function ownerSetsTier(raw: Raw, taskId: string, tier: ModelTier): Outcome {
  const task = raw.tasks.find(one => one.id === taskId)
  if (task === undefined) return refused(`There is no task ${taskId} in this run.`)
  const was = String(task.tier)
  const no = retier(task, { kind: 'owner' }, tier, undefined)
  if (no !== undefined) return no

  return changed(was === tier ? `${taskId} stays on ${tier}, now by your word.` : `${taskId}: ${was} to ${tier}.`)
}

/** The kind, reason and note of a tool's input, checked and handed to `rekind`. */
function kindFrom(raw: Raw, task: RawTask, caller: Caller, kind: unknown, reason: unknown, kindNote: unknown): string | undefined {
  const next = KINDS.find(one => one === kind)
  if (next === undefined) return `kind is one of ${KINDS.join(', ')}.`
  if (reason !== undefined && typeof reason !== 'string') return 'kindReason is one line of text.'
  if (kindNote !== undefined && (typeof kindNote !== 'number' || !Number.isInteger(kindNote) || kindNote < 1)) return 'kindNote is the number of a suitability note, from 1.'

  return rekind(raw, task, caller, next, reason, kindNote)
}

/** `task_add`: the orchestrator adds a task to the run, tagged with a tier and why. */
export function addTask(raw: Raw, caller: Caller, input: Record<string, unknown>): Outcome {
  if (caller.kind !== 'orchestrator') return refused('Only the orchestrator adds a task to the run.')
  const id = input.id
  if (typeof id !== 'string' || !RUN_ID.test(id)) return refused('id is the task’s short name: letters, digits, _ and -, e.g. t391-2.')
  if (raw.tasks.some(one => one.id === id || one.worker === id)) return refused(`${id} is already a task or a worker of this run.`)
  if (typeof input.title !== 'string' || tidy(input.title) === '') return refused('title says in a few words what the task delivers.')
  const title = tidy(input.title)
  if (title.length > TITLE_MAX) return refused(`title is at most ${TITLE_MAX} characters; this one has ${title.length}.`)
  const dependsOn = input.dependsOn ?? []
  if (!Array.isArray(dependsOn) || dependsOn.some(one => typeof one !== 'string')) return refused('dependsOn is a list of task ids.')
  const missing = (dependsOn as string[]).find(one => !raw.tasks.some(task => task.id === one))
  if (missing !== undefined) return refused(`dependsOn names ${missing}, which is no task of this run.`)
  if (input.ticket !== undefined && !isTicket(input.ticket)) return refused(TICKET_HELP)
  const files = input.files === undefined ? [] : fileList(input.files)
  if (files === undefined) return refused(`files is a list of at most ${FILES_MAX} files or folders, relative to the repository.`)
  // One task is one change a single worker can finish without filling its context.
  if (files.length > FILES_PER_TASK) {
    return refused(`${files.length} files is more than one worker should take on (${FILES_PER_TASK}): slice this into smaller tasks, ordered with dependsOn.`)
  }
  // The problems this task is added to deal with: all of them are checked before anything is written.
  const addresses = input.addresses ?? []
  if (!Array.isArray(addresses) || addresses.some(one => typeof one !== 'string')) {
    return refused('addresses is a list of problem ids, e.g. ["P3"].')
  }
  const loose = (addresses as string[]).find(one => !(raw.problems ?? []).some(problem => problem.id === one && problem.status === 'open'))
  if (loose !== undefined) return refused(`addresses names ${loose}, which is no open problem of this run.`)
  const task: RawTask = { id, title, tier: 'sonnet', status: 'queued' }
  const no = retier(task, caller, input.tier, input.tierReason)
  if (no !== undefined) return no
  const run = planOf(raw) as { codex?: { ready?: boolean } }
  if (input.kind === undefined) {
    if (run.codex?.ready === true) return refused('Say which kind of worker builds it: claude or codex, with kindReason: {"kind": "...", "kindReason": "..."}.')
  } else {
    const noKind = kindFrom(raw, task, caller, input.kind, input.kindReason, input.kindNote)
    if (noKind !== undefined) return refused(noKind)
  }
  if (input.ticket !== undefined) task.ticket = input.ticket
  if (dependsOn.length > 0) task.dependsOn = dependsOn
  if (files.length > 0) task.files = files
  // Two open tasks expected to change the same file is the orchestrator's to know before either starts.
  const shared = raw.tasks
    .filter(one => one.status !== 'done')
    .map(one => ({ id: one.id, on: files.filter(file => covers(strings(one.files), file)) }))
    .filter(one => one.on.length > 0)
    .map(one => `${one.id} on ${one.on.join(', ')}`)
  raw.tasks.push(task)
  for (const problem of raw.problems ?? []) if ((addresses as string[]).includes(problem.id)) problem.addressedBy = id
  const after = dependsOn.length > 0 ? `, after ${(dependsOn as string[]).join(', ')}` : ''
  const warns = shared.length > 0 ? ` It shares files with ${shared.join('; ')}: order them with dependsOn, or split the files.` : ''
  const deals = addresses.length > 0 ? ` It addresses ${named([...new Set(addresses as string[])])}.` : ''

  return changed(`${id} added: ${String(task.tier)}, queued${after}.${deals}${warns}`)
}

/** `task_update`: where a task stands, what it is doing, its pull request and branch. */
export function updateTask(raw: Raw, at: string, caller: Caller, input: Record<string, unknown>): Outcome {
  if (caller.kind === 'stranger') return refused('Only the orchestrator and a task’s own worker update a task.')
  const id = input.task
  if (typeof id !== 'string' || id === '') return refused('Name the task: {"task": "<task id>", ...}.')
  const task = raw.tasks.find(one => one.id === id)
  if (task === undefined) {
    return refused(`There is no task ${id} in this run. Its tasks: ${raw.tasks.map(one => one.id).join(', ')}.`)
  }
  if (caller.kind === 'worker' && caller.taskId !== id) {
    return refused(`You are ${describe(caller)} and may only update that task, not ${id}.`)
  }
  const said: string[] = []
  // A green task whose revision moved: its judgement no longer covers it.
  let movedFromGreen = false
  // What the status change does to the problems that hang on this task: said once the change is made.
  let isNowDone = false
  let isNowFailed = false
  // Said when the orchestrator took the task back from a worker that was building.
  let retiredNote = ''

  if (input.status !== undefined) {
    const status = STATUSES.find(one => one === input.status)
    if (status === undefined) return refused(`status is one of ${STATUSES.join(', ')}.`)
    if (caller.kind === 'worker' && !WORKER_STATUSES.includes(status)) {
      return refused(`A worker sets its task to ${WORKER_STATUSES.join(', ')}; ${status} is the orchestrator's to set.`)
    }
    // A Lore task is handed back with the revision its worker pushed: what its merge is pinned to.
    const isLore = typeof (raw.run as Record<string, unknown> | undefined)?.lore === 'object'
    if (status === 'review' && isLore && (input.revision ?? task.revision) === undefined) {
      return refused(`${id} is handed back with the revision it pushed: {"task": "${id}", "status": "review", "revision": "<64 hex>"}. lore branch info shows it as Remote Latest once lore push went through.`)
    }
    if (status === 'done' && task.status !== 'done' && (input.revision ?? task.revision) !== undefined) {
      return refused(`${id} has a branch with code on it, so it is done once that is merged into the run branch: call mcp__conductor__merge for it.`)
    }
    // A task with a pull request is done once that is merged: the merge loop's to say, not a claim.
    if (status === 'done' && task.status !== 'done' && (input.pr ?? task.pr) !== undefined) {
      return refused(`${id} has a pull request, so it is done once that is merged: call mcp__conductor__merge for it (a pull request already merged by hand is taken over). The owner can also say so with /merged ${id}.`)
    }
    isNowDone = status === 'done' && task.status !== 'done'
    isNowFailed = status === 'failed' && task.status !== 'failed'
    // The orchestrator takes a building task back from its worker: that worker is retired, alive or not.
    const takenFrom = caller.kind === 'orchestrator' && status === 'returned' && task.status === 'building' && typeof task.agentId === 'string' ? task.agentId : undefined
    task.status = status
    if (status === 'building') {
      task.startedAt ??= at
      delete task.finishedAt
    }
    if (status === 'done') task.finishedAt ??= at
    said.push(`status ${status}`)
    if (takenFrom !== undefined) {
      task.retired = [...(Array.isArray(task.retired) ? (task.retired as string[]) : []), takenFrom]
      delete task.agentId
      task.finishedAt = at
      task.activity = { at, text: 'taken back by the orchestrator' } satisfies Activity
      retiredNote = ` Its worker ${takenFrom} is retired: the mod refuses its tool calls from now on, so an attempt that still runs cannot change the workspace or the board. Start a worker again with ${id} as its name: it works in the same workspace and is told to look at what is there first.`
    }
  }
  if (input.tier !== undefined) {
    const no = retier(task, caller, input.tier, input.tierReason)
    if (no !== undefined) return no
    said.push(`tier ${String(task.tier)}`)
  }
  if (input.kind !== undefined) {
    const no = kindFrom(raw, task, caller, input.kind, input.kindReason, input.kindNote)
    if (no !== undefined) return refused(no)
    said.push(`kind ${String(task.kind)}`)
  }
  if (input.note !== undefined) {
    if (typeof input.note !== 'string') return refused('note is a line of text; an empty one clears it.')
    const note = tidy(input.note)
    if (note.length > NOTE_MAX) return refused(`note is one line of at most ${NOTE_MAX} characters; this one has ${note.length}.`)
    if (note === '') delete task.note
    else task.note = note
    said.push(note === '' ? 'note cleared' : 'note set')
  }
  if (input.ticket !== undefined) {
    if (caller.kind !== 'orchestrator') return refused('Only the orchestrator sets a task’s ticket.')
    if (!isTicket(input.ticket)) return refused(TICKET_HELP)
    task.ticket = input.ticket
    said.push(`ticket ${input.ticket}`)
  }
  if (input.pr !== undefined) {
    if (typeof input.pr !== 'number' || !Number.isInteger(input.pr) || input.pr < 1) {
      return refused('pr is the pull request’s number, a whole number from 1.')
    }
    task.pr = input.pr
    said.push(`PR ${input.pr}`)
  }
  const inLore = typeof (raw.run as Record<string, unknown> | undefined)?.lore === 'object'
  if (input.branch !== undefined && inLore && caller.kind === 'worker') {
    return refused(`The mod names a task's branch in a Lore run: ${id}'s is ${String(task.branch ?? 'made when its worker starts')}. Hand back with the revision you pushed.`)
  }
  if (input.branch !== undefined) {
    if (typeof input.branch !== 'string' || tidy(input.branch) === '') return refused('branch is the branch’s name.')
    task.branch = tidy(input.branch)
    said.push(`branch ${task.branch}`)
  }
  if (input.revision !== undefined) {
    if (typeof input.revision !== 'string' || !REVISION.test(input.revision)) return refused('revision is the Lore revision its branch was pushed at: 64 hex characters.')
    // A new revision is a new change: a check run on another one says nothing of it, and a judgement of another
    // one does not cover it. A green task whose revision moves is back in review until it is judged again.
    const isNew = task.revision !== input.revision
    if (isNew) delete task.check
    task.revision = input.revision
    said.push(`revision ${input.revision.slice(0, 7)}`)
    if (isNew && task.status === 'green' && input.status === undefined) {
      task.status = 'review'
      said.push('back in review')
      movedFromGreen = true
    }
  }
  if (said.length === 0) return refused('Nothing to change: give status, tier, note, ticket, pr, branch or revision.')

  const base = `${id}: ${said.join(', ')}.${retiredNote}`
  const lost = isNowFailed ? lostWith(raw, id) : []
  const lostText = lost.length === 0 ? '' : `${named(lost)} ${lost.length === 1 ? 'has' : 'have'} no task now.`
  // A worker that gives its task up is told no more than it did; the orchestrator hears what that leaves loose.
  const movedText = movedFromGreen ? `Run board: ${id}'s branch moved to a revision nobody judged: it is back in review, so judge it again before it is merged.` : ''
  if (caller.kind === 'worker') {
    const tell = [lostText === '' ? '' : `Run board: ${id} failed. ${lostText}`, movedText].filter(one => one !== '').join(' ')

    return { ...changed(base), ...(tell === '' ? {} : { tell }) }
  }

  return changed([base, isNowDone ? afterDone(raw, id) : '', lostText].filter(one => one !== '').join(' '))
}

/** `problem_report`: a problem found, numbered after the last one. */
export function reportProblem(raw: Raw, at: string, caller: Caller, input: Record<string, unknown>): Outcome {
  if (caller.kind === 'stranger') return refused('Only the orchestrator and a task’s own worker report a problem.')
  if (typeof input.text !== 'string' || tidy(input.text) === '') return refused('Say what the problem is: {"text": "...", "severity": "..."}.')
  const text = tidy(input.text)
  if (text.length > PROBLEM_MAX) return refused(`text is at most ${PROBLEM_MAX} characters; this one has ${text.length}.`)
  const severity = SEVERITIES.find(one => one === input.severity)
  if (severity === undefined) {
    return refused(`severity is one of ${SEVERITIES.join(', ')}: a blocker stops a task, a warning may bite later, a note is for the record.`)
  }
  const taskId = input.task ?? (caller.kind === 'worker' ? caller.taskId : undefined)
  if (taskId !== undefined && !raw.tasks.some(one => one.id === taskId)) {
    return refused(`There is no task ${String(taskId)} in this run.`)
  }
  const problems = (raw.problems ??= [])
  // The same thing said again under the same task is the problem already open, not a new one (and wakes nobody twice).
  const again = problems.find(one => one.status === 'open' && one.text === text && one.taskId === taskId)
  if (again !== undefined) return { isChanged: false, isError: false, text: `${again.id} says the same and is open still.` }
  const last = Math.max(0, ...problems.map(one => Number(/^P(\d+)$/.exec(one.id)?.[1] ?? 0)))
  const id = `P${last + 1}`
  // Only the mod's own reports name who deals with a problem at once (the tool's schema has no such field): the
  // blocker of a merge that was not verified is dealt with by verifying that very task.
  const fixer = typeof input.addressedBy === 'string' && raw.tasks.some(one => one.id === input.addressedBy) ? input.addressedBy : undefined
  problems.push({
    id,
    text,
    severity,
    status: 'open',
    ...(taskId === undefined ? {} : { taskId }),
    ...(fixer === undefined ? {} : { addressedBy: fixer }),
    foundAt: at,
  })

  const recorded = changed(`${id} recorded (${severity}${taskId === undefined ? '' : `, ${String(taskId)}`}).`)
  // A blocker or a warning a worker found is the orchestrator's to take care of: it is told, and a blocker wakes it when it is idle.
  if (caller.kind !== 'worker' || severity === 'note') return recorded
  const said = `Run board: ${caller.taskId} reports ${id}, a ${severity}: ${text}`

  return severity === 'blocker' ? { ...recorded, wake: said, asks: `problem ${id}` } : { ...recorded, tell: said }
}

/** `problem_resolve`: the orchestrator settles a problem and says how. */
export function resolveProblem(raw: Raw, caller: Caller, input: Record<string, unknown>): Outcome {
  if (caller.kind !== 'orchestrator') {
    return refused('Only the orchestrator resolves a problem. Report what you found with problem_report, or in your task’s note.')
  }
  const problem = (raw.problems ?? []).find(one => one.id === input.problem)
  if (problem === undefined) return refused(`There is no problem ${String(input.problem)} in this run.`)
  if (typeof input.resolution !== 'string' || tidy(input.resolution) === '') return refused('Say how it was settled: {"resolution": "..."}.')
  if (problem.status === 'resolved') return refused(`${problem.id} is already resolved.`)
  // A problem whose task is still going is not settled by a word: that would call it fixed before the work is done.
  const fixer = typeof problem.addressedBy === 'string' ? raw.tasks.find(one => one.id === problem.addressedBy) : undefined
  if (fixer !== undefined && fixer.status !== 'done' && fixer.status !== 'failed' && input.dismiss !== true) {
    return refused(
      `${problem.id} is addressed by ${fixer.id}, which is ${fixer.status}: it is resolved once that task is done and the fix holds. If it turned out to be no problem, say so with dismiss: true.`,
    )
  }
  problem.status = 'resolved'
  problem.resolution = tidy(input.resolution)

  return changed(`${problem.id} resolved.`)
}

/**
 * The orchestrator is asked, once for the lot, to look again at the blockers
 * and warnings that nobody deals with and that nobody has looked at for a
 * while: a precaution that did not come true, or a fact that is no longer one,
 * stands on the board as it was found. Each is asked about again no sooner
 * than `LOOK_AGAIN_MIN` minutes after (`askedAt`, kept in the ledger, so a
 * restart does not ask twice).
 *
 * Only while the run goes on, and never while the owner holds it: a run
 * that is over has its end said once, and an idle orchestrator is not woken
 * for it every half hour.
 */
export function askAgain(raw: Raw, at: string): Outcome {
  const none: Outcome = { isChanged: false, isError: false, text: '' }
  if (!isUnderway(raw.run as Record<string, unknown>, raw.tasks)) return none
  const due = dueForLook(raw, Date.parse(at))
  if (due.length === 0) return none
  const lines: string[] = []
  for (const one of due) {
    const problem = (raw.problems ?? []).find(each => each.id === one.id)
    if (problem === undefined) continue
    problem.askedAt = at
    lines.push(`${one.id} (${String(one.severity)}, ${standingText(standing(one, raw.tasks)) ?? 'no task'})`)
  }
  const text = `Run board: still open and not looked at for ${LOOK_AGAIN_MIN} minutes or more: ${lines.join('; ')}.`

  return { ...changed(text), wake: text, asks: 'look again' }
}

/**
 * Minutes a building worker may show no sign of life before the orchestrator
 * is told: proposed, not measured. A worker's own command may run ten minutes
 * in the foreground, and a wait on its background work longer.
 */
export const STALL_MIN = 30

type TaskLike = Record<string, unknown> & { id: string; status: TaskStatus }

/** A building worker's last sign of life: its last tool call, or its start. */
function lastSign(task: TaskLike): { at: string; text?: string } | undefined {
  const activity = task.activity as { at?: unknown; text?: unknown } | undefined
  if (typeof activity?.at === 'string') return { at: activity.at, text: typeof activity.text === 'string' ? activity.text : undefined }

  return typeof task.startedAt === 'string' ? { at: task.startedAt } : undefined
}

function stallOf(task: TaskLike): { at: string; problem: string } | undefined {
  const mark = task.stall as { at?: unknown; problem?: unknown } | undefined

  return typeof mark?.at === 'string' && typeof mark.problem === 'string' ? { at: mark.at, problem: mark.problem } : undefined
}

/** How a stall the mod said is over, or undefined while it lasts. */
function stallOver(task: TaskLike, said: { at: string }): string | undefined {
  if (task.status !== 'building') return `${task.id} is ${task.status} now.`
  const last = lastSign(task)
  if (last !== undefined && Date.parse(last.at) > Date.parse(said.at)) {
    return `${task.id}'s worker showed life again at ${last.at}${last.text === undefined ? '' : ` (${last.text})`}.`
  }

  return undefined
}

/**
 * Minutes a building task's worker has been silent at `nowMs`; undefined for a
 * task nobody builds, a worker the mod did not see start (no agent id: nothing
 * it does is heard, so its silence says nothing) or a time that does not read.
 */
function silence(task: TaskLike, nowMs: number): number | undefined {
  if (task.status !== 'building' || typeof task.agentId !== 'string') return undefined
  const last = lastSign(task)
  const sinceMs = last === undefined ? Number.NaN : Date.parse(last.at)

  return Number.isNaN(sinceMs) ? undefined : Math.floor((nowMs - sinceMs) / 60_000)
}

/** Whether a watch on the building workers has anything to say or settle now: the timer asks before it writes. */
export function stallsDue(book: { tasks: readonly object[] }, nowMs: number): boolean {
  return (book.tasks as readonly TaskLike[]).some(task => {
    const said = stallOf(task)
    if (said !== undefined) return stallOver(task, said) !== undefined
    const minutes = silence(task, nowMs)

    return minutes !== undefined && minutes >= STALL_MIN
  })
}

/**
 * The watch on building workers. A worker's sign of life is its last tool
 * call, or its start. One that has shown none for `STALL_MIN` minutes is said
 * once for that silence: a warning on the board under its task, and a prompt
 * that wakes the orchestrator, or rides on its next tool result while it
 * works. A worker on a long command and one whose wait ran out with nothing to
 * wake it look the same from here; the orchestrator can tell. `loops` is what
 * the engine said of each agent's loop, by agent id, when it could be asked.
 *
 * The mod resolves the warning once the worker is heard from again or its
 * task leaves building, and tells the orchestrator so; until then the
 * periodic look at problems nobody deals with asks about it again.
 */
export function sayStalls(raw: Raw, at: string, loops?: ReadonlyMap<string, string>): Outcome {
  const nowMs = Date.parse(at)
  const said: { taskId: string; line: string }[] = []
  const over: { taskId: string; line: string }[] = []
  let isChanged = false
  for (const task of raw.tasks) {
    const mark = stallOf(task)
    if (mark !== undefined) {
      const how = stallOver(task, mark)
      if (how === undefined) continue
      delete task.stall
      isChanged = true
      const warning = (raw.problems ?? []).find(one => one.id === mark.problem)
      if (warning !== undefined && warning.status === 'open') {
        warning.status = 'resolved'
        warning.resolution = how
        over.push({ taskId: task.id, line: `${warning.id} resolved: ${how}` })
      }
      continue
    }
    const minutes = silence(task, nowMs)
    if (minutes === undefined || minutes < STALL_MIN) continue
    const last = lastSign(task)
    const since =
      last?.text === undefined ? `it started at ${String(task.startedAt)} and made no tool call since` : `its last tool call was ${last.text}, at ${last.at}`
    const loop = loops === undefined ? undefined : typeof task.agentId === 'string' ? loops.get(task.agentId) : undefined
    const engine = loops === undefined ? '' : loop === undefined ? ' The engine no longer lists it.' : ` The engine lists its loop as ${loop}.`
    const text = `${task.id}'s worker has shown no sign of life for ${minutes} minutes: ${since}.${engine} It may be on a long command, or its wait ran out and nothing woke it.`
    const problems = (raw.problems ??= [])
    const id = `P${Math.max(0, ...problems.map(one => Number(/^P(\d+)$/.exec(one.id)?.[1] ?? 0))) + 1}`
    problems.push({ id, text, severity: 'warning', status: 'open', taskId: task.id, foundAt: at })
    task.stall = { at, problem: id }
    isChanged = true
    said.push({ taskId: task.id, line: `${id}, a warning: ${text}` })
  }
  if (!isChanged) return { isChanged: false, isError: false, text: '' }
  const wake =
    said.length === 0
      ? undefined
      : `Run board: ${said.map(one => one.line).join(' ')} Look at it (ListAgents shows who runs). Leave a busy worker alone. One that is gone: set the task to returned with mcp__conductor__task_update, then start a worker again with the task's id as its name.`
  const tell = over.length === 0 ? undefined : `Run board: ${over.map(one => one.line).join(' ')}`

  return {
    ...changed([wake, tell].filter(one => one !== undefined).join('\n') || 'Stalls settled.'),
    ...(wake === undefined ? {} : { wake, asks: `stall ${said.map(one => one.taskId).join(', ')}` }),
    ...(tell === undefined ? {} : { tell, answered: `stall ${over.map(one => one.taskId).join(', ')}` }),
  }
}

/**
 * `problem_assign`: the orchestrator ties a problem to the task of the run
 * that deals with it, by the task's id or by the ticket it carries. A task
 * that is done or given up deals with nothing, and a ticket counts only while
 * a task of this run still carries it: a problem is not parked where nobody
 * conducts it.
 */
export function assignProblem(raw: Raw, caller: Caller, input: Record<string, unknown>): Outcome {
  if (caller.kind !== 'orchestrator') return refused('Only the orchestrator gives a problem its task.')
  const problem = (raw.problems ?? []).find(one => one.id === input.problem)
  if (problem === undefined) return refused(`There is no problem ${String(input.problem)} in this run.`)
  if (problem.status === 'resolved') return refused(`${problem.id} is resolved already.`)
  if ((input.task === undefined) === (input.ticket === undefined)) {
    return refused('Name the task that deals with it or the ticket it is under, one of them: {"problem": "P3", "task": "t391-2"} or {"problem": "P3", "ticket": 391}.')
  }
  const goes = (one: RawTask): boolean => one.status !== 'done' && one.status !== 'failed'
  let task: RawTask | undefined
  if (input.task !== undefined) {
    task = raw.tasks.find(one => one.id === input.task)
    if (task === undefined) return refused(`There is no task ${String(input.task)} in this run. Its tasks: ${raw.tasks.map(one => one.id).join(', ')}.`)
    if (!goes(task)) {
      return refused(
        task.status === 'done'
          ? `${task.id} is done: if it fixed ${problem.id}, resolve it; if not, add a task for it with task_add and addresses.`
          : `${task.id} was given up and deals with nothing: give ${problem.id} another task, or add one with task_add and addresses.`,
      )
    }
  } else {
    if (!isTicket(input.ticket)) return refused(TICKET_HELP)
    const carrying = raw.tasks.filter(one => one.ticket === input.ticket && goes(one))
    if (carrying.length === 0) {
      return refused(`No task of this run that still goes on carries ticket ${ticketName(input.ticket)}, so the run does not conduct it. Add a task for it with task_add (ticket, addresses): a problem is not left with a ticket nobody here conducts.`)
    }
    if (carrying.length > 1) {
      return refused(`Ticket ${ticketName(input.ticket)} is carried by ${carrying.map(one => one.id).join(', ')}: name the task that deals with ${problem.id}.`)
    }
    task = carrying[0]
  }
  if (task === undefined) return refused('There is no such task.')
  if (problem.addressedBy === task.id) return refused(`${problem.id} is addressed by ${task.id} already.`)
  problem.addressedBy = task.id

  return changed(`${problem.id} is addressed by ${task.id} (${task.status}${isTicket(task.ticket) ? `, ticket ${ticketName(task.ticket)}` : ''}).`)
}
