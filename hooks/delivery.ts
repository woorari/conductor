import type { Ledger } from '../types'
import type { Raw, Outcome } from './signals'
import { changed, refused } from './signals'

/** Owner approval is pinned to a task's PR, reviewed head and target base. */
export function approveMerge(raw: Raw, taskId: string, head: string, base: string): Outcome {
  const task = raw.tasks.find(one => one.id === taskId)
  if (!task || task.status !== 'green' || !Number.isInteger(task.pr)) return refused('Approve a reviewed green task with a recorded PR.')
  if (typeof head !== 'string' || !/^[a-f0-9]{40}$/i.test(head)) return refused('Approval needs the full reviewed PR head SHA.')
  const run = raw.run as Record<string, unknown>
  const approvals = (run.mergeApprovals ??= {}) as Record<string, unknown>
  approvals[taskId] = { pr: task.pr, head: head.toLowerCase(), base }
  return changed(`Main-branch merge approved for ${taskId}, PR ${task.pr}, at ${head.toLowerCase()} into ${base}.`)
}

export function planDeliversMain(ledger: Ledger, base: string): boolean {
  return (ledger.run.plan === 'approved' || ledger.run.plan === undefined) && ledger.run.delivery === 'complete' && ledger.run.deliveryBase === base && ledger.run.pausedAt === undefined
}

export function mergeApproved(ledger: Ledger, taskId: string, head: string, base: string): boolean {
  const task = ledger.tasks.find(one => one.id === taskId)
  if (planDeliversMain(ledger, base) && task?.status === 'green' && Number.isInteger(task.pr) && /^[a-f0-9]{40}$/i.test(head)) return true
  const approval = ledger.run.mergeApprovals?.[taskId]
  return approval !== undefined && approval.pr === ledger.tasks.find(one => one.id === taskId)?.pr && approval.head === head && approval.base === base
}

export const DELIVERY = 'Plan approval authorizes the approved deliverable through implementation, necessary file changes, follow-up fixes, tests, commits, pushes, PR creation, reviewed PR merges into the approved base branch, and post-merge verification. Continue until all of it is delivered; do not stop at a hand-back, green task or open PR. Expected files and task decomposition are implementation planning, not separate consent boundaries: the orchestrator adjusts them with task_update (files/dependsOn plus scopeReason) or adds in-scope follow-up tasks without asking again. Security-related code and tests needed for the approved outcome are in scope; granting new access or disabling protections is a separate action. Honor explicit owner limits such as review-only. New unrelated outcomes, permanent deletion and ~/Library access need actual authorization. Move obsolete project files into _deleted; never delete or quarantine system files.'
export const ORCHESTRATOR_ROLE = 'The main session is the single orchestrator: it plans, delegates to isolated workers, reviews results and manages the board; it never edits implementation code. Fixes and merge conflicts go back to a worker. Workers implement, test, commit, push and open PRs within the approved scope. Workers never approve plans or merge into the base branch.'
