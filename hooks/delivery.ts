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

export function mergeApproved(ledger: Ledger, taskId: string, head: string, base: string): boolean {
  const approval = ledger.run.mergeApprovals?.[taskId]
  return approval !== undefined && approval.pr === ledger.tasks.find(one => one.id === taskId)?.pr && approval.head === head && approval.base === base
}

export const DELIVERY = 'Complete the approved work through implementation, tests, commits, pushes and pull-request creation without seeking another publishing approval. A merge into the project base branch (main) needs the owner’s separate approval for the reviewed PR head. Do not delete files without explicit deletion approval: move removed project files into _deleted instead. Never delete or quarantine system files. Do not access ~/Library, directly or through a link, without explicit owner approval for that access.'
export const ORCHESTRATOR_ROLE = 'The main session is the single orchestrator: it plans, delegates to isolated workers, reviews results and manages the board; it never edits implementation code. Fixes and merge conflicts go back to a worker. Workers implement, test, commit, push and open PRs within the approved scope. Workers never approve plans or merge into the base branch.'
