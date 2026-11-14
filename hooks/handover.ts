import type { Ledger, Merge, Problem, Task } from '../types'
import { DELIVERY, ORCHESTRATOR_ROLE } from './delivery'
import { short } from './merge'
import { standing, standingText } from './problems'
import { preflight } from './router'

/**
 * The orchestrator's fresh start. When its context is this full, the session
 * is compacted, and what the run needs afterwards comes from the ledger and
 * not from the summary: every task still going and its worker, the done ones
 * by name, the open problems and questions, the rulings that bind anyone at
 * work. The same text is written to disk as the handover.
 */

/** Percent of the orchestrator's context window at which the session is compacted. */
export const ROTATE_AT = 70

/** What the summarizer is told to keep: only what the board does not hold. */
export const KEEP = [
  'This conversation is the orchestrator of a run of parallel workers. The run\'s state (its tasks, their workers, problems, questions, rulings and findings) is kept on disk by the conductor mod and is added back after this summary, so leave all of it out.',
  'Keep, briefly: what the owner asked for and decided in this conversation, in their own words where the wording matters; what the orchestrator was doing and was about to do next; and what it learned that is not on the board as a task note, a problem or a ruling.',
].join(' ')

export type Moment = {
  /** ISO 8601. */
  at: string
  /** How full the context was, in percent, when known. */
  percent?: number
  /** The repository's origin is not on GitHub: the board merges nothing here, and a task with a pull request is done on the owner's word. */
  isElsewhere?: boolean
}

const taskLine = (task: Task): string => {
  const who = task.worker === undefined ? '' : ` · worker ${task.worker}${task.agentId === undefined ? '' : ` (agent ${task.agentId})`}`
  const more = [
    task.branch === undefined ? '' : `branch ${task.branch}`,
    task.builtOn === undefined ? '' : `built on ${task.builtOn}`,
    task.pr === undefined ? '' : `PR ${task.pr}`,
    task.ticket === undefined ? '' : `ticket ${task.ticket}`,
    (task.dependsOn ?? []).length === 0 ? '' : `after ${(task.dependsOn ?? []).join(', ')}`,
    task.note === undefined ? '' : `note: ${task.note}`,
  ].filter(one => one !== '')

  return `- ${task.id} [${task.status}, ${task.tier}] ${task.title}${who}${more.length > 0 ? ` · ${more.join(' · ')}` : ''}`
}

/** `P2 blocker (t391-1), no task: …`: who found it or what it holds up, and who deals with it. */
const problemLine = (ledger: Ledger, one: Problem): string => {
  const deals = standingText(standing(one, ledger.tasks))

  return `- ${one.id} ${one.severity}${one.taskId === undefined ? '' : ` (${one.taskId})`}${deals === undefined ? '' : `, ${deals}`}: ${one.text}`
}

const flightLine = (flight: Merge): string =>
  `A merge is in flight: ${flight.task} (PR ${flight.pr}), pinned to ${short(flight.head)}, ${flight.state} since ${flight.startedAt}. The mod settles it with GitHub, marks the task done and tells you; merge nothing else meanwhile.`

/** The run as the ledger has it, for an orchestrator that remembers nothing of it. */
export function handover(ledger: Ledger, moment: Moment): string {
  const open = ledger.problems.filter(one => one.status === 'open')
  const questions = ledger.posts.filter(one => one.kind === 'question' && one.answeredBy === undefined)
  // What waits for a worker whose task is finished will never be read, and is not the orchestrator's to chase.
  const finished = new Set(ledger.tasks.filter(one => one.status === 'done').map(one => one.id))
  const unread = [...ledger.posts.filter(one => one.kind === 'finding'), ...ledger.rulings].flatMap(one =>
    (one.for ?? [])
      .filter(taskId => !(one.deliveredTo ?? []).includes(taskId) && !finished.has(taskId))
      .map(taskId => `${one.id} for ${taskId}`),
  )
  const section = (title: string, lines: readonly string[]): string[] => (lines.length === 0 ? [] : ['', `## ${title}`, ...lines])
  // A done task is finished, and its name is enough; a ruling that binds only done tasks binds nobody at work. Each is a name on one line.
  const doneLine = finished.size === 0 ? [] : [`- Done: ${[...finished].join(', ')}`]
  const isSettled = (one: Ledger['rulings'][number]): boolean => (one.tasks ?? []).length > 0 && (one.tasks ?? []).every(taskId => finished.has(taskId))
  const settled = ledger.rulings.filter(isSettled).map(one => one.id)
  const settledLine = settled.length === 0 ? [] : [`- ${settled.join(', ')} ${settled.length === 1 ? 'binds' : 'bind'} only done tasks.`]

  return [
    `# Run ${ledger.run.id}: ${ledger.run.title}`,
    `State of the run on ${moment.at}${moment.percent === undefined ? '' : `, with the orchestrator's context ${moment.percent}% full`}.${ledger.run.source === undefined ? '' : ` Started from ${ledger.run.source}.`}`,
    ...(ledger.run.plan === 'draft'
      ? ['The plan is a draft: no worker starts before it is proposed with mcp__conductor__run_plan and the owner approves it.']
      : ledger.run.plan === 'proposed'
        ? ["The plan waits for the owner's approval (/approve): no worker starts before that."]
        : []),
    ...(ledger.run.pausedAt === undefined
      ? []
      : [`The run is paused by the owner since ${ledger.run.pausedAt}: no worker starts and nothing is merged until they type /unpause. Workers that are building finish and hand back.`]),
    ...(ledger.merge === undefined ? [] : [flightLine(ledger.merge)]),
    ...(ledger.orchestrator?.held === undefined
      ? []
      : [
          `This session is due for a compaction that has not gone through since ${ledger.orchestrator.held.since}. The engine's reason: ${ledger.orchestrator.held.reason}. The mod tries again, and the owner can type /compact; until it is through, put what matters on the board.`,
        ]),
    ...section('Tasks', [...ledger.tasks.filter(one => one.status !== 'done').map(taskLine), ...doneLine]),
    ...section('Plan check', ledger.run.plan === 'approved' || ledger.run.plan === undefined ? [] : preflight(ledger).map(one => `- ${one}`)),
    ...section('Open problems', open.map(one => problemLine(ledger, one))),
    ...section('Open questions', questions.map(one => `- ${one.id} from ${one.from}: ${one.text}`)),
    ...section('Rulings', [
      ...ledger.rulings.filter(one => !isSettled(one)).map(one => `- ${one.id}${one.answers === undefined ? '' : ` (answers ${one.answers})`}: ${one.text}`),
      ...settledLine,
    ]),
    ...section('Not read yet', unread.length === 0 ? [] : [`- ${unread.join('; ')}`]),
    '',
    '## How to go on',
    ORCHESTRATOR_ROLE,
    DELIVERY,
    '- When another host takes over, resolve future worker models on that host: Claude uses the task’s tier alias, Codex inherits its current session model unless the owner supplied a Codex mapping. Recorded worker models describe past or running workers; do not copy them as future assignments.',
    '- The board is the source of truth. mcp__conductor__board_read gives this state again; the tools of the mod change it.',
    '- A stopped worker is started again with a message to its name. After the session itself restarted, names no longer resolve: use the agent id listed with the task.',
    '- A task that was handed back waits for your judgement: review, green, blocked or failed, or done for a task with no pull request.',
    '- An open blocker or warning is yours until a task of the run has dealt with it: one without a task gets one (mcp__conductor__task_add with addresses, or mcp__conductor__problem_assign to a task or ticket the run still conducts); one whose task is done is checked, then mcp__conductor__problem_resolve. The run is not delivered while one is open. Look whether it still holds before you give it a task: if it does not, resolve it. A task is not merged while a problem found under it waits for that decision.',
    '- A task starts once everything it waits for is green or done; it need not wait for the merge. It is merged only after what it waits for is done.',
    ledger.run.lore !== undefined
      ? `- In this Lore run a green task is merged into ${ledger.run.lore.branch} with mcp__conductor__merge, pinned to its revision, one at a time. Workers commit and push their branches. ${ledger.run.delivery === 'complete' ? 'Complete delivery includes the base merge: once all tasks/checks/problems are settled, use mcp__conductor__run_merge_main, syncing and reviewing the base first if it moved. No repeat approval is needed.' : 'This legacy/review-only run retains the owner’s /approve-main exact-revision path.'}`
      : moment.isElsewhere === true
      ? "- The board merges nothing in this repository, whose origin is not on GitHub. A green task's pull request is merged by the repository's own path, one at a time; the task is then done on the owner's word, /merged <task>."
      : '- A green task is merged with mcp__conductor__merge, one at a time; the mod marks it done once GitHub has merged it, and then watches the checks on the base branch. mcp__conductor__merge_check says what stands in the way.',
  ].join('\n')
}

/** The handover as it is carried into the compacted conversation. */
export const carried = (text: string): string =>
  `The conductor mod carried the run's state over this compaction. It was read from the ledger just now and replaces whatever the summary above says about tasks, workers, problems or rulings.\n\n${text}`
