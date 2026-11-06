/**
 * Who takes care of a problem.
 *
 * A blocker or a warning is the run's to deal with: it stands until a task
 * of the run that still goes on has dealt with it, and a run with one open is
 * not delivered. A note is for the record and needs nobody.
 *
 * The mod keeps the link between a problem and its task, says when it is
 * loose (no task, or the task was given up) and holds the run's end until
 * every blocker and warning is settled. Whether a task's work really fixes
 * the problem is not something it can read: that is the orchestrator's to
 * judge, and it says so with `problem_resolve`.
 *
 * These functions read a parsed ledger and a ledger's raw JSON alike, so the
 * edits (which work on the raw file) and the board (which works on a parsed
 * one) share one rule.
 */

type TaskLike = { id: string; status: string }
type ProblemLike = {
  id: string
  severity?: unknown
  status?: unknown
  addressedBy?: unknown
  taskId?: unknown
  text?: unknown
  foundAt?: unknown
  askedAt?: unknown
}

/** A run as far as problems go: its tasks and its problems, parsed or raw. */
export type Book = { tasks: readonly TaskLike[]; problems?: readonly ProblemLike[] }

/**
 * What stands behind a problem. `note`: for the record, nobody is needed.
 * `nobody`: a blocker or a warning that no task deals with. `failed`: the
 * task that dealt with it was given up, so it is back to nobody. `going`: its
 * task is not done yet. `done`: its task is done, and the orchestrator is to
 * check that the fix holds.
 */
export type Standing =
  | { kind: 'note' }
  | { kind: 'nobody' }
  | { kind: 'failed'; task: string }
  | { kind: 'going'; task: string; status: string }
  | { kind: 'done'; task: string }

export function standing(problem: ProblemLike, tasks: readonly TaskLike[]): Standing {
  const task = typeof problem.addressedBy === 'string' ? tasks.find(one => one.id === problem.addressedBy) : undefined
  if (task?.status === 'done') return { kind: 'done', task: task.id }
  if (task !== undefined && task.status !== 'failed') return { kind: 'going', task: task.id, status: task.status }
  if (problem.severity === 'note') return { kind: 'note' }

  return task === undefined ? { kind: 'nobody' } : { kind: 'failed', task: task.id }
}

/** A blocker or a warning that has no task going on it. */
export const needsTask = (one: Standing): boolean => one.kind === 'nobody' || one.kind === 'failed'

/** The few words for a problem's second line on the board and in the handover; undefined for a note nobody deals with. */
export function standingText(one: Standing): string | undefined {
  if (one.kind === 'nobody') return 'no task'
  if (one.kind === 'failed') return `${one.task} failed, no task`
  if (one.kind === 'going') return `fix ${one.task} ${one.status}`
  if (one.kind === 'done') return `${one.task} done, check the fix`

  return undefined
}

/** The open blockers and warnings: what keeps a run from being delivered. */
export const unsettled = (book: Book): ProblemLike[] =>
  (book.problems ?? []).filter(one => one.status === 'open' && one.severity !== 'note')

/** The ids of the open problems a task is to deal with, of any severity. */
export const heldBy = (book: Book, taskId: string): string[] =>
  (book.problems ?? []).filter(one => one.status === 'open' && one.addressedBy === taskId).map(one => one.id)

/** `P3`, `P3 and P4`, `P3, P4 and P5`. */
export function named(ids: readonly string[]): string {
  const last = ids.at(-1)
  if (last === undefined || ids.length === 1) return last ?? ''

  return `${ids.slice(0, -1).join(', ')} and ${last}`
}

/**
 * What a task's becoming done leaves to say, to be added to the line that
 * says it is done: the problems that waited for it, and, once nothing else is
 * going on, the blockers and warnings that are still open. Empty when nothing
 * hangs on it.
 */
export function afterDone(book: Book, taskId: string): string {
  const waiting = heldBy(book, taskId)
  const open = unsettled(book).map(one => one.id)
  const rest = open.filter(id => !waiting.includes(id))
  const isEverythingDone = book.tasks.every(one => one.status === 'done')
  const waits = waiting.length === 0 ? '' : `${named(waiting)} ${waiting.length === 1 ? 'was' : 'were'} waiting for it.`
  const ends = isEverythingDone && open.length > 0 ? `Everything is done${rest.length === 0 ? '' : `; still open: ${rest.join(', ')}`}.` : ''

  return [waits, ends].filter(one => one !== '').join(' ')
}

/** The open blockers and warnings a task was to deal with: what has no task once it is given up. */
export const lostWith = (book: Book, taskId: string): string[] =>
  unsettled(book)
    .filter(one => one.addressedBy === taskId)
    .map(one => one.id)

/**
 * A blocker or a warning that waits for the orchestrator to look at it again:
 * nobody deals with it, the task that was to was given up, or that task is
 * done and the fix is not checked. Either it still holds, and then it gets a
 * task, or it does not, and then it is resolved: it is not left open.
 */
export const needsLook = (one: Standing): boolean => one.kind === 'nobody' || one.kind === 'failed' || one.kind === 'done'

const TEXT_SHOWN = 90

/**
 * What a task that is about to merge still owes the problems found under it,
 * one line each. A problem that a task still goes on with is not one of them:
 * it has an owner, and a task that waits for its own fix would never merge.
 */
export function lookLines(book: Book, taskId: string): string[] {
  return (book.problems ?? []).flatMap(one => {
    if (one.status !== 'open' || one.severity === 'note' || one.taskId !== taskId) return []
    const now = standing(one, book.tasks)
    if (!needsLook(now)) return []
    const said = typeof one.text === 'string' && one.text !== '' ? `: "${one.text.length > TEXT_SHOWN ? `${one.text.slice(0, TEXT_SHOWN - 1)}…` : one.text}"` : ''
    const what = `${one.id} (${String(one.severity)}${said}) was found under ${taskId}`
    if (now.kind === 'done') {
      return [`${what}, and ${now.task}, the task that was to deal with it, is done: check that the fix holds and resolve it; if it does not, give it a new task.`]
    }
    const why = now.kind === 'failed' ? `, and ${now.task}, the task that was to deal with it, was given up` : ' and no task deals with it'

    return [`${what}${why}: check that it still holds. If it does, give it a task (mcp__conductor__task_add with addresses, or mcp__conductor__problem_assign); if it does not, resolve it.`]
  })
}

/**
 * How long a blocker or a warning that nobody deals with may stand before the
 * orchestrator is asked to look at it again, and again after that (proposed,
 * not measured: a worker takes about half an hour over a task).
 */
export const LOOK_AGAIN_MIN = 30

/** The blockers and warnings nobody deals with that were last looked at, or found, that long ago or longer. */
export function dueForLook(book: Book, nowMs: number): ProblemLike[] {
  return unsettled(book).filter(one => {
    if (standing(one, book.tasks).kind !== 'nobody') return false
    const since = Date.parse(String(one.askedAt ?? one.foundAt))

    // A problem recorded with no time cannot be said to have stood for any.
    return !Number.isNaN(since) && nowMs - since >= LOOK_AGAIN_MIN * 60_000
  })
}

/** A run that is going on: its plan approved, not held by the owner, and something not done yet. */
export const isUnderway = (run: { plan?: unknown; pausedAt?: unknown }, tasks: readonly TaskLike[]): boolean =>
  (run.plan === undefined || run.plan === 'approved') && run.pausedAt === undefined && tasks.some(one => one.status !== 'done')
