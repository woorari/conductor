import type { Ledger, Orchestrator, Post, Problem, ProblemSeverity, Task, TaskStatus } from '../types'
import { needsTask, standing, standingText } from './problems'
import type { Standing } from './problems'
import { readiness } from './router'

/** How many finished tasks the board lists before it says how many more there are. */
export const DONE_SHOWN = 8
/** Minutes without a sign of life after which a building worker is called silent (proposed, not measured). */
export const SILENT_AFTER_MIN = 10

export type TaskRow = Task & {
  /** Whole minutes since a building task started; absent without a start time. */
  minutes?: number
  /** Whole minutes since a building task's worker was last seen acting, once that is long enough to say. */
  silentMinutes?: number
  /** Whole minutes since a handed-back task's worker stopped. */
  sinceMinutes?: number
  /** The tasks a queued one still waits for; empty when it could start now. */
  waitsFor: string[]
  /** Where its merge stands while one is in flight, and whole minutes since it was claimed. */
  merging?: 'merging'
  mergeMinutes?: number
}

/** An open problem with what stands behind it: the task that deals with it, if any, and where that stands. */
export type ProblemRow = Problem & { standing: Standing }

/** A ledger sorted into what the pane shows, top to bottom. */
export type Board = {
  title: string
  total: number
  /** Open problems, blockers first, each severity in the ledger's order. */
  problems: ProblemRow[]
  resolved: number
  /** Blocked and failed tasks: they wait for a decision. */
  attention: TaskRow[]
  /** Workers' questions the orchestrator has not ruled on yet, oldest first. */
  questions: Post[]
  /** How much the board holds: findings posted, rulings made. */
  findings: number
  rulings: number
  /** The orchestrator's own context and its compactions, once measured. */
  orchestrator?: Orchestrator
  /** Where the plan stands when workers may not start yet. */
  plan?: 'draft' | 'proposed'
  /** Since when the owner holds the run, when they do. */
  pausedAt?: string
  /** In a home that is not a repository: the workspace the run works in, relative to the home. */
  workspace?: string
  building: TaskRow[]
  /** Handed back by their workers and not yet judged by the orchestrator. */
  returned: TaskRow[]
  /** Ready to merge first, then in review. */
  review: TaskRow[]
  /** Queued with nothing left to wait for, in the ledger's order. */
  next: TaskRow[]
  /** Queued behind unfinished tasks. */
  waiting: TaskRow[]
  /** Newest first by `finishedAt`; those without one keep the ledger's order, last. */
  done: TaskRow[]
}

/** A run's workspace as the board shows it: from its place's folder on, which is relative to the home. */
function shownWorkspace(workspace: { root: string; place: string } | undefined): string | undefined {
  if (workspace === undefined) return undefined
  const place = workspace.place.replace(/\/+$/, '')
  const at = workspace.root.lastIndexOf(`/${place}`)

  return at === -1 ? workspace.root : workspace.root.slice(at + 1)
}

const SEVERITY_ORDER: Record<ProblemSeverity, number> = { blocker: 0, warning: 1, note: 2 }

function minutesSince(startedAt: string | undefined, nowMs: number): number | undefined {
  if (startedAt === undefined || nowMs <= 0) return undefined
  const started = Date.parse(startedAt)
  if (Number.isNaN(started) || started > nowMs) return undefined

  return Math.floor((nowMs - started) / 60_000)
}

export function boardView(ledger: Ledger, nowMs: number): Board {
  const silent = (one: Task): number | undefined => {
    const quiet = one.status === 'building' ? minutesSince(one.activity?.at, nowMs) : undefined

    return quiet !== undefined && quiet >= SILENT_AFTER_MIN ? quiet : undefined
  }
  const rows: TaskRow[] = ledger.tasks.map(one => ({
    ...one,
    minutes: one.status === 'building' ? minutesSince(one.startedAt, nowMs) : undefined,
    silentMinutes: silent(one),
    sinceMinutes: one.status === 'returned' ? minutesSince(one.finishedAt, nowMs) : undefined,
    waitsFor: one.status === 'queued' ? readiness(ledger, one).waitsFor : [],
    ...(ledger.merge?.task === one.id ? { merging: ledger.merge.state, mergeMinutes: minutesSince(ledger.merge.startedAt, nowMs) } : {}),
  }))
  const open = ledger.problems.filter(one => one.status === 'open').map((one): ProblemRow => ({ ...one, standing: standing(one, ledger.tasks) }))
  const finishedAt = (row: TaskRow): number => (row.finishedAt === undefined ? 0 : Date.parse(row.finishedAt))

  return {
    title: ledger.run.title,
    ...(ledger.run.workspace === undefined ? {} : { workspace: shownWorkspace(ledger.run.workspace) }),
    total: rows.length,
    problems: [...open].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    resolved: ledger.problems.length - open.length,
    attention: rows.filter(row => row.status === 'blocked' || row.status === 'failed'),
    questions: ledger.posts.filter(one => one.kind === 'question' && one.answeredBy === undefined),
    findings: ledger.posts.filter(one => one.kind === 'finding').length,
    rulings: ledger.rulings.length,
    orchestrator: ledger.orchestrator,
    plan: ledger.run.plan === 'draft' || ledger.run.plan === 'proposed' ? ledger.run.plan : undefined,
    pausedAt: ledger.run.pausedAt,
    building: rows.filter(row => row.status === 'building'),
    returned: rows.filter(row => row.status === 'returned'),
    review: [
      ...rows.filter(row => row.status === 'green' && row.merging !== undefined),
      ...rows.filter(row => row.status === 'green' && row.merging === undefined),
      ...rows.filter(row => row.status === 'review'),
    ],
    next: rows.filter(row => row.status === 'queued' && row.waitsFor.length === 0),
    waiting: rows.filter(row => row.status === 'queued' && row.waitsFor.length > 0),
    done: rows.filter(row => row.status === 'done').sort((a, b) => finishedAt(b) - finishedAt(a)),
  }
}

/** `under 1 min`, `12 min`, `1 h 05 min`. */
export function elapsed(minutes: number): string {
  if (minutes < 1) return 'under 1 min'
  if (minutes < 60) return `${minutes} min`

  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** `182k` for a worker's context in tokens. */
export const thousands = (tokens: number): string => `${Math.round(tokens / 1000)}k`

/** The orchestrator's own state in a few words: `Orchestrator 43% full · compacted twice`; undefined before a first reading. */
export function orchestratorLine(own: Orchestrator | undefined): string | undefined {
  if (own === undefined || (own.contextPercent === undefined && (own.rotations ?? 0) === 0 && own.held === undefined)) return undefined
  const times = own.rotations ?? 0
  const parts = [
    own.contextPercent === undefined ? 'Orchestrator' : `Orchestrator ${own.contextPercent}% full`,
    own.held === undefined ? '' : 'compaction waits',
    times === 0 ? '' : `compacted ${times === 1 ? 'once' : times === 2 ? 'twice' : `${times} times`}`,
  ].filter(one => one !== '')

  return parts.join(' · ')
}

/** One line for the whole run: `2 building · 1 to merge · 3 next · 5 of 12 done`. */
export function summary(board: Board): string {
  const flight = board.review.find(row => row.merging !== undefined)
  const ready = board.review.filter(row => row.status === 'green' && row.merging === undefined).length
  const parts: string[] = []
  if (board.workspace !== undefined) parts.push(`in ${board.workspace}`)
  if (board.pausedAt !== undefined) parts.push('paused')
  if (board.plan === 'proposed') parts.push('plan waits for your approval')
  if (board.plan === 'draft') parts.push('plan is being drafted')
  if (board.problems.length > 0) {
    const bare = board.problems.filter(one => needsTask(one.standing)).length
    parts.push(`${board.problems.length} ${board.problems.length === 1 ? 'problem' : 'problems'} open${bare === 0 ? '' : ` (${bare} without a task)`}`)
  }
  if (board.attention.length > 0) parts.push(`${board.attention.length} waiting for a decision`)
  if (board.questions.length > 0) {
    parts.push(`${board.questions.length} ${board.questions.length === 1 ? 'question' : 'questions'} open`)
  }
  if (board.building.length > 0) parts.push(`${board.building.length} building`)
  if (board.returned.length > 0) parts.push(`${board.returned.length} handed back`)
  if (flight?.merging !== undefined) parts.push(`1 ${flight.merging}`)
  if (ready > 0) parts.push(`${ready} to merge`)
  const waiting = board.review.filter(row => row.status === 'review').length
  if (waiting > 0) parts.push(`${waiting} in review`)
  if (board.next.length > 0) parts.push(`${board.next.length} next`)
  parts.push(`${board.done.length} of ${board.total} done`)

  return parts.join(' · ')
}

/** The dim second line under a problem: its severity, the task it holds up, and who deals with it. */
export function problemDetail(row: ProblemRow): string {
  return [row.severity, row.taskId, standingText(row.standing)].filter(one => one !== undefined).join(' · ')
}

/** The dim second line under a task's title: what matters for the section it is in. */
export function detail(row: TaskRow): string {
  const parts: string[] = []
  if (row.status === 'blocked' || row.status === 'failed') parts.push(row.status)
  if (row.status === 'returned') parts.push('handed back')
  if (row.merging !== undefined) parts.push(row.mergeMinutes === undefined ? row.merging : `${row.merging} ${elapsed(row.mergeMinutes)}`)
  else if (row.status === 'green') parts.push('ready to merge')
  if (row.status === 'review') parts.push('in review')
  if (row.status !== 'done') parts.push(row.tier)
  if (row.worker !== undefined && row.status !== 'queued' && row.status !== 'done') parts.push(row.worker)
  if (row.minutes !== undefined) parts.push(elapsed(row.minutes))
  if (row.silentMinutes !== undefined) parts.push(`silent ${elapsed(row.silentMinutes)}`)
  if (row.contextTokens !== undefined && row.status === 'building') parts.push(`${thousands(row.contextTokens)} tokens`)
  if (row.builtOn !== undefined && row.status !== 'done') parts.push(`built on ${row.builtOn}`)
  if (row.pr !== undefined) parts.push(`PR ${row.pr}`)
  // A Lore task stands at a revision, and its check on it, where a GitHub task has a pull request.
  else if (row.revision !== undefined && row.status !== 'done') parts.push(`rev ${row.revision.slice(0, 7)}`)
  if (row.check !== undefined && row.status !== 'done') parts.push(`check ${row.check.verdict}`)
  if (row.ticket !== undefined) parts.push(`ticket ${row.ticket}`)
  if (row.waitsFor.length > 0) parts.push(`after ${row.waitsFor.join(', ')}`)
  const doing = row.note ?? row.activity?.text
  if (doing !== undefined && row.status !== 'done') parts.push(doing)

  return parts.join(' · ')
}

/** How many worker lanes the timeline draws before it says how many more there are. */
export const LANES_SHOWN = 8

const MINUTE = 60_000
/** Tick spacings the time axis may use, in minutes. */
const STEPS = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440]

/** One stretch of work on a task, as fractions of the time axis (0 = its start, 1 = its end). */
export type LaneBar = { taskId: string; status: TaskStatus; from: number; to: number }

/** Everything one worker did in the run, oldest first. */
export type Lane = { worker: string; isBuilding: boolean; bars: LaneBar[] }

export type Tick = { at: number; label: string }

/** The run on a time axis: one lane per worker, a bar per task it worked on. */
export type Timeline = {
  startMs: number
  endMs: number
  ticks: Tick[]
  /** Workers building now first (longest running on top), then the most recently active. */
  lanes: Lane[]
  /** Lanes left out because more than the limit exist. */
  hidden: number
}

/** `HH:MM` on the wall clock `tzOffsetMin` minutes east of UTC. */
export function clock(ms: number, tzOffsetMin: number): string {
  const local = new Date(ms + tzOffsetMin * MINUTE)

  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
}

/**
 * Lays the tasks that have a worker and a start time on a time axis from the
 * run's start to now. A task with no `finishedAt` runs on to now. Undefined
 * when no task can be drawn.
 */
export function timeline(
  ledger: Ledger,
  nowMs: number,
  tzOffsetMin: number,
  shown: number = LANES_SHOWN,
): Timeline | undefined {
  const spans: { task: Task; worker: string; start: number; end: number }[] = []
  for (const task of ledger.tasks) {
    if (task.worker === undefined || task.startedAt === undefined) continue
    const start = Date.parse(task.startedAt)
    if (Number.isNaN(start)) continue
    const stopped = task.finishedAt === undefined ? Number.NaN : Date.parse(task.finishedAt)
    spans.push({
      task,
      worker: task.worker,
      start,
      end: Number.isNaN(stopped) ? Math.max(nowMs, start) : Math.max(stopped, start),
    })
  }
  if (spans.length === 0) return undefined

  const runStart = ledger.run.startedAt === undefined ? Number.NaN : Date.parse(ledger.run.startedAt)
  const firstStart = Math.min(...spans.map(one => one.start))
  const startMs = Number.isNaN(runStart) ? firstStart : Math.min(runStart, firstStart)
  const endMs = Math.max(nowMs, ...spans.map(one => one.end), startMs + 10 * MINUTE)
  const length = endMs - startMs

  const stepMs = (STEPS.find(step => length / (step * MINUTE) <= 4) ?? 1440) * MINUTE
  const offsetMs = tzOffsetMin * MINUTE
  const ticks: Tick[] = []
  for (let at = Math.ceil((startMs + offsetMs) / stepMs) * stepMs - offsetMs; at < endMs; at += stepMs) {
    ticks.push({ at: (at - startMs) / length, label: clock(at, tzOffsetMin) })
  }

  const byWorker = new Map<string, typeof spans>()
  for (const one of spans) byWorker.set(one.worker, [...(byWorker.get(one.worker) ?? []), one])
  const lanes = [...byWorker.entries()].map(([worker, own]) => {
    const sorted = [...own].sort((a, b) => a.start - b.start)

    return {
      worker,
      isBuilding: sorted.some(one => one.task.status === 'building'),
      firstStart: sorted[0]?.start ?? 0,
      lastEnd: Math.max(...sorted.map(one => one.end)),
      bars: sorted.map(one => ({
        taskId: one.task.id,
        status: one.task.status,
        from: (one.start - startMs) / length,
        to: (one.end - startMs) / length,
      })),
    }
  })
  lanes.sort((a, b) => {
    if (a.isBuilding !== b.isBuilding) return a.isBuilding ? -1 : 1

    return a.isBuilding ? a.firstStart - b.firstStart : b.lastEnd - a.lastEnd
  })
  const kept = lanes.slice(0, Math.max(shown, lanes.filter(lane => lane.isBuilding).length))

  return {
    startMs,
    endMs,
    ticks,
    lanes: kept.map(({ worker, isBuilding, bars }) => ({ worker, isBuilding, bars })),
    hidden: lanes.length - kept.length,
  }
}

/** Whole minutes the run has been going, from its start (or its first task's) to now. */
export function runMinutes(ledger: Ledger, nowMs: number): number | undefined {
  const starts = [ledger.run.startedAt, ...ledger.tasks.map(one => one.startedAt)]
    .map(at => (at === undefined ? Number.NaN : Date.parse(at)))
    .filter(at => !Number.isNaN(at))
  if (starts.length === 0 || nowMs <= 0) return undefined
  const first = Math.min(...starts)

  return first > nowMs ? undefined : Math.floor((nowMs - first) / MINUTE)
}

/** `under 1 min`, `12 min`, `1 h 05`: the short form the dashboard's right column has room for. */
export function elapsedShort(minutes: number): string {
  if (minutes < 60) return elapsed(minutes)

  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}
