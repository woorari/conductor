/**
 * The owner's approvals, host-neutral: the checks on a plan approval (the
 * owner, the preflight, the plan's hash), approving a run's plan, and the
 * owner's `/approve-main`. The ledger, the Lore workspace and the merge are
 * an `ApprovalHost`'s (the mod's `$`); nothing here touches the engine. The
 * Codex script calls `approvalGate`; the rest is the mod's.
 */

import type { GateDecision, Ledger } from '../types'
import { parseLedger } from './ledger'
import { canonicalPlan, planGate } from './plan'
import { preflight } from './router'
import { approvePlan } from './signals'
import type { Outcome, Raw } from './signals'

export type GateInput = { planSha256?: unknown; decision?: unknown }
export type GateResult = { error: string } | { decision?: GateDecision & { sha256: string } }

/**
 * The owner's checks for a plan approval, shared by a Git run and a Lore
 * run: who asks, the preflight, the plan's hash and the decision. `raw` is
 * the ledger as its host read it (a Codex ledger names its base in
 * `codex.base`); `sha256` hashes text to hex. Answers why it is refused, or
 * the decision to record (none when nothing was named).
 */
export function approvalGate(raw: unknown, input: GateInput, caller: { kind: string }, at: string, sha256: (text: string) => string): GateResult {
  if (caller.kind !== 'owner') return { error: 'This action requires the owner’s explicit instruction in this chat.' }
  const read = parseLedger(JSON.stringify(raw))
  if (read.error !== undefined || read.ledger === undefined) return { error: read.error ?? 'The ledger does not read.' }
  const issues = preflight(read.ledger)
  if (issues.length) return { error: issues.join('\n') }
  const base = (raw as { codex?: { base?: string } }).codex?.base

  return planGate(sha256(canonicalPlan(read.ledger, base)), input, at)
}

/** The origins of a command that are the owner's own hand: the terminal, the desktop app, the owner's Remote Control. */
export const OWNER_ORIGINS: ReadonlySet<string> = new Set(['composer', 'sdk', 'bridge'])

/** What approving needs from the mod. */
export type ApprovalHost = {
  /** The ledger the session is bound to. */
  boundLedger(): Promise<string | undefined>
  /** Why the session is bound to no run. */
  unbound(): Promise<string>
  /** A file's text, or undefined when it is not there or cannot be read. */
  read(path: string): Promise<string | undefined>
  /** The Lore side of an approval: the run's workspace on its branch, the base protected. Why it could not be done, or undefined. */
  loreApprove(path: string): Promise<string | undefined>
  /** The base branch a plan approval covers. */
  base(): Promise<string>
  /** Reads the ledger, lets `change` edit its JSON and writes it back, after every change asked for before this one. */
  mutate<T>(path: string, change: (raw: Raw) => { value: T; isChanged: boolean }): Promise<{ value?: T; error?: string }>
  /** Moves the run's Linear issue and the board's own marks after an approval. */
  linearApproved(path: string): Promise<void>
  issueDone(path: string): Promise<void>
  /** Draws the board again from the ledger. */
  refresh(): Promise<void>
  /** Merges the run branch into the base: from the plan approval, or on the owner's `/approve-main`. */
  mergeMain(fromPlan: boolean, signal?: AbortSignal): Promise<string>
}

/** Approves the bound run's plan, by /approve or the owner's approving reply: what is said, and whether it was approved. */
export async function approveRun(host: ApprovalHost, path: string, delivery: 'complete' | 'review-only' = 'complete'): Promise<{ text: string; isApproved: boolean }> {
  const notReady = await host.loreApprove(path)
  if (notReady !== undefined) return { text: `No plan was approved: ${notReady} Approve again once that is fixed.`, isApproved: false }
  const base = await host.base()
  const written = await host.mutate<Outcome>(path, raw => {
    const outcome = approvePlan(raw, delivery, base)

    return { value: outcome, isChanged: outcome.isChanged }
  })
  if (written.error !== undefined || written.value === undefined) return { text: written.error ?? 'The ledger did not change.', isApproved: false }
  if (!written.value.isError) {
    await host.linearApproved(path)
    await host.issueDone(path)
  }
  await host.refresh()

  return { text: written.value.text, isApproved: written.value.isError !== true }
}

/** What a run's Lore side is, read for its base-branch commands; or why there is none. */
export async function loreRunOf(host: ApprovalHost): Promise<{ path: string; ledger: Ledger; runLore: NonNullable<Ledger['run']['lore']>; run: string } | { text: string }> {
  const path = await host.boundLedger()
  if (path === undefined) return { text: await host.unbound() }
  const ledger = parseLedger((await host.read(path)) ?? '').ledger
  if (ledger === undefined) return { text: 'The ledger does not read.' }
  const runLore = ledger.run.lore
  if (runLore?.workspace === undefined) return { text: 'This run has no Lore workspace yet: it is made when the owner approves the plan with /approve.' }

  return { path, ledger, runLore, run: runLore.workspace }
}

/**
 * `/approve-main`: the owner approves the run branch's revision for the base
 * branch, and the host merges exactly that revision into the protected base.
 * Only the owner's own origin counts; any other merges nothing.
 */
export async function approveMain(host: ApprovalHost, origin: string, signal?: AbortSignal): Promise<string> {
  if (!OWNER_ORIGINS.has(origin)) return 'Not done. /approve-main is the owner\'s: only the owner types it, in the terminal, the desktop app or Remote Control. Nothing was merged.'

  return host.mergeMain(false, signal)
}
