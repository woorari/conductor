/**
 * The claims of Lore's long steps and the check, as pure decisions: how long a
 * claim may stand before it is let go, which claims of other runs a merge
 * waits for, whether a check is still running, and the blocker a base left
 * unprotected leaves behind. The host reads the ledgers and runs the steps.
 */

import type { Ledger } from '../types'
import { LONG_MS, LORE_LONG_MS } from './lore-steps'

const MINUTE = 60_000

/**
 * How long a claim stands before it is taken as left by a crashed call: the
 * longest a claimed call can take (three long Lore steps and three shorter
 * ones), in minutes. Past it the claim blocks nobody.
 */
export const LORE_CLAIM_STALE_MIN = (3 * LORE_LONG_MS + 3 * LONG_MS) / MINUTE

/** A claim of another run that a merge waits for. */
export type Held = { run: string; task: string; startedAt: string }

/** Whether a claim started at a time is older than the limit (a time that does not read is old: it holds nobody). */
export const isStale = (startedAt: string, nowMs: number): boolean => {
  const age = nowMs - Date.parse(startedAt)

  return !(age >= 0 && age < LORE_CLAIM_STALE_MIN * MINUTE)
}

/** The claim this run holds, when it is too old to be a call that is still running. */
export const staleOwn = (ledger: Ledger, nowMs: number): Ledger['merge'] =>
  ledger.merge !== undefined && isStale(ledger.merge.startedAt, nowMs) ? ledger.merge : undefined

/** The claims the other runs of a home hold that are young enough to be calls still running. An old one is ignored, so a crashed call never blocks for good. */
export const claimsAcross = (ledgers: readonly Ledger[], own: string, nowMs: number): Held[] =>
  ledgers.flatMap(one => (one.merge === undefined || one.run.id === own || isStale(one.merge.startedAt, nowMs) ? [] : [{ run: one.run.id, task: one.merge.task, startedAt: one.merge.startedAt }]))

/** A check that is running and may still end: it has run no longer than its own limit and a minute of slack. */
export const checkRunning = (record: { verdict: string; at: string } | undefined, timeoutMin: number, nowMs: number): boolean => {
  if (record?.verdict !== 'running') return false
  const age = nowMs - Date.parse(record.at)

  return age >= 0 && age <= (timeoutMin + 1) * MINUTE
}

/** What a blocker says when `lore branch protect` failed after a run's merge. The start of the text is how a later run finds it. */
export const unprotectedStart = (base: string): string => `${base} is not protected:`
export const unprotectedText = (base: string, line: string): string =>
  `${unprotectedStart(base)} lore branch protect ${base} failed after the run's merge (${line.replace(/\s+/g, ' ').slice(0, 200)}). Protect it by hand.`

/** The other runs whose merge left the base unprotected and not settled: no run merges into that base until each is dealt with. */
export const unprotectedBy = (ledgers: readonly Ledger[], own: string, base: string): string[] =>
  ledgers.filter(one => one.run.id !== own && (one.problems ?? []).some(problem => problem.status === 'open' && problem.severity === 'blocker' && problem.text.startsWith(unprotectedStart(base)))).map(one => one.run.id)

/** What a claim let go for its age says, and the blocker that asks for a look before anything else merges. */
export const stuckWhy = `nobody heard how it ended for ${LORE_CLAIM_STALE_MIN} minutes (the session may have stopped mid-merge)`
export const stuckText = (task: string, into: string): string =>
  `The merge of ${task} into ${into} was let go unheard after ${LORE_CLAIM_STALE_MIN} minutes. Check lore history --branch ${into} to see whether it landed before anything else merges.`
