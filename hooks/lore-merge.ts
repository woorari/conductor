/**
 * The rules of a Lore run's merges, as pure edits of the ledger: a judged task
 * into the run branch, and the run branch into the base branch on the owner's
 * approval. The hooks module runs `lore`; here is what may merge and what the
 * board then holds.
 */

import type { Ledger, Task } from '../types'
import type { Flight } from './merge'
import { afterDone, lookLines } from './problems'
import { changed, refused } from './signals'
import type { Caller, Outcome, Raw } from './signals'

/** A revision as people read it: its first seven characters. */
export const rev7 = (revision: string): string => revision.slice(0, 7)

type Loose = Record<string, unknown>
const flightOf = (raw: Raw): Loose | undefined => (raw as { merge?: Loose }).merge
const isPausedRaw = (raw: Raw): boolean => typeof (raw.run as Loose | undefined)?.pausedAt === 'string'

/** What a Lore merge of a task was asked with, once the board's own side holds: and what still stands in its way. */
export type LoreAsked = { task: Task; branch: string; revision: string; blocks: string[] }

/**
 * Whether a task may be merged into the run branch, as far as the board
 * says: the same refusals as GitHub's merge for who asks, which task and what
 * is in flight, then what stands in the way (not green, paused, waits for an
 * unmerged task, a problem found under it, a check not passed on its revision).
 */
export function loreReady(ledger: Ledger, caller: Caller, input: Record<string, unknown>, others: readonly Flight[]): LoreAsked | { error: string } {
  if (caller.kind !== 'orchestrator') return { error: 'Only the orchestrator merges. A worker never does: set your task to review with its revision and hand back.' }
  const task = ledger.tasks.find(one => one.id === input.task)
  if (task === undefined) return { error: `There is no task ${String(input.task)} in this run. Its tasks: ${ledger.tasks.map(one => one.id).join(', ')}.` }
  if (task.status === 'done') return { error: `${task.id} is done already.` }
  if (task.branch === undefined || task.revision === undefined) {
    return { error: `${task.id} has no branch and revision on the board: its worker sets it to review with the revision it pushed (task_update with revision).` }
  }
  const flight = ledger.merge
  if (flight !== undefined) {
    return { error: flight.task === task.id ? `${task.id} is merging already. The board settles it and tells you.` : `${flight.task} is still merging: one merge at a time. The board settles it and tells you.` }
  }
  const other = others[0]
  if (other !== undefined) return { error: `Run ${other.run} is merging ${other.task} since ${other.startedAt}: one merge at a time, across runs too. Try again once it is settled.` }
  const blocks: string[] = []
  if (task.status !== 'green') blocks.push(`${task.id} is ${task.status}: only a task you judged green (its change reviewed, its check passed) is merged.`)
  if (ledger.run.pausedAt !== undefined) blocks.push(`The run is paused by the owner since ${ledger.run.pausedAt}: nothing is merged until they type /unpause.`)
  const unmerged = (task.dependsOn ?? []).flatMap(id => {
    const one = ledger.tasks.find(each => each.id === id)

    return one === undefined || one.status === 'done' ? [] : [`${one.id} (${one.status})`]
  })
  if (unmerged.length > 0) blocks.push(`${task.id} waits for ${unmerged.join(', ')}: what a task waits for is merged first, in that order.`)
  blocks.push(...lookLines(ledger, task.id))
  const check = ledger.run.config?.check
  if (check !== undefined && (task.check?.revision !== task.revision || task.check.verdict !== 'passed')) {
    const now = task.check?.revision === task.revision ? ` (it is ${task.check.verdict})` : ''
    blocks.push(`the check (${check.argv.join(' ')}) has not passed on ${rev7(task.revision)}${now}.`)
  }

  return { task, branch: task.branch, revision: task.revision, blocks }
}

/** Claims a Lore merge: one at a time, pinned to a revision. */
export function startLoreMerge(raw: Raw, at: string, claim: { task: string; revision: string; target: 'run' | 'base' }): Outcome {
  const flight = flightOf(raw)
  if (flight !== undefined) return refused(`${String(flight.task)} is merging already: one merge at a time.`)
  if (claim.target === 'run') {
    const task = raw.tasks.find(one => one.id === claim.task)
    if (task === undefined || task.status === 'done') return refused(`${claim.task} is no open task of this run any more.`)
  }
  ;(raw as { merge?: Loose }).merge = { task: claim.task, revision: claim.revision, target: claim.target, state: 'merging', startedAt: at }

  return changed(`${claim.task} claimed for merging.`)
}

/** The task's branch is on the run branch: the task is done. */
export function onRunBranch(raw: Raw, at: string, taskId: string, revision: string, runBranch: string, workspace: string): Outcome {
  const task = raw.tasks.find(one => one.id === taskId)
  if (task === undefined) return refused(`There is no task ${taskId} in this run.`)
  task.status = 'done'
  task.finishedAt ??= at
  task.mergeCommit = revision
  task.mergedAt = at
  delete (raw as { merge?: Loose }).merge
  const left = afterDone(raw, task.id)
  const next = isPausedRaw(raw) ? 'The run is paused: nothing starts or merges until the owner types /unpause.' : 'Go on at once: start what can start and merge the next green task.'

  return changed(`Merged: ${task.id} is on ${runBranch} as ${rev7(revision)}, and the task is done. ${workspace} ${next}${left === '' ? '' : ` ${left}`}`)
}

/** The merge met a conflict and was aborted: nothing merged, and the task goes back to its worker. */
export function conflicted(raw: Raw, at: string, taskId: string, files: readonly string[]): Outcome {
  delete (raw as { merge?: Loose }).merge
  const task = raw.tasks.find(one => one.id === taskId)
  const named = files.length === 0 ? 'files lore did not name' : files.join(', ')
  if (task !== undefined) {
    task.status = 'blocked'
    task.note = `Conflicts with the run branch in: ${named}. Bring the run branch into the task's branch and resolve.`.slice(0, 200)
    task.finishedAt ??= at
  }
  const text = `Not merged: ${taskId}'s branch conflicts with the run branch in: ${named}. Nothing was merged. Have its worker bring the run branch into its own branch and resolve (never by picking one side of a binary file), then judge it again.`

  return { ...changed(text), tell: `Run board: ${text}` }
}

/** The merge did not go through: the claim is let go, and the task stands where it stood. */
export function letGo(raw: Raw, why: string): Outcome {
  const flight = flightOf(raw)
  if (flight === undefined) return refused('No merge is in flight.')
  delete (raw as { merge?: Loose }).merge
  const text = `Run board: ${String(flight.task)} was not merged: ${why}. The claim is let go; it stands where it stood.`

  return { ...changed(text), tell: text }
}
