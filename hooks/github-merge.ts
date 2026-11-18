/**
 * What a merge asks of GitHub and writes about it, host-neutral: a commit's
 * checks, the base branch's head, a pull request surveyed with both, the
 * merges other runs have in flight, a merge claim settled on the board, and
 * a claim reconciled with the pull request. The requests, the token, the
 * ledger folder and the board are a host's (the mod's `$`, or the Codex
 * script's `gh`); nothing here touches the engine. Both hosts call
 * `checksAt` and the Codex script `reconcileRun`; the rest is the mod's.
 */

import type { Ledger } from '../types'
import { RUN_ID, parseLedger } from './ledger'
import { abandoned, checksOf, flightsOf, headOf, judge, onMain, pullOf, short } from './merge'
import type { Facts, Flight, Look, Verdict } from './merge'
import type { Outcome, Raw } from './signals'

/** GitHub's answer to a request, its body read as JSON; or why there is none. */
export type GithubAnswer = { status: number; json: unknown; text: string; error?: undefined } | { error: string }

/**
 * A request about the run's repository: `path` starts at the repository
 * (`/pulls/12`), and the host knows the repository and the token. The mod's
 * host never throws and answers `error`; the Codex host throws what `gh`
 * threw, and the module lets it through.
 */
export type GithubHost = {
  github(path: string, init?: { method?: string; body?: string }): Promise<GithubAnswer>
}

/** What surveying a pull request also needs: the base branch of the run and the repository's name for a message. */
export type SurveyHost = GithubHost & {
  base(): Promise<string>
  repo(): string | undefined
}

/** The folder of run folders, as a host reads it. */
export type FlightHost = {
  /** The folder that holds the run folders; undefined when there is none. */
  runsDir(): string | undefined
  list(dir: string): Promise<{ kind: string; name: string }[]>
  read(path: string): Promise<string>
}

/** What the board needs when a merge claim is written. */
export type SettleHost = {
  /** Reads the ledger, lets `change` edit its JSON and writes it back, after every change asked for before this one. */
  mutate<T>(path: string, change: (raw: Raw) => { value: T; isChanged: boolean }): Promise<{ value: T; error?: undefined } | { value?: undefined; error: string }>
  /** Draws the board again from the ledger, at once and not at its next poll. */
  redraw(): Promise<void>
  /** Puts what a written change has for its readers into their inboxes. */
  carry(outcome: Outcome): void
}

/** What reconciling a claim needs besides GitHub: the clock, in milliseconds. */
export type ReconcileHost = GithubHost & { now(): number }

export type ChecksState = Verdict | { error: string }
export type Survey = { facts: Facts; error?: undefined } | { error: string }
export type Settled = Outcome | undefined
export type ReconcileInput = { release?: unknown }
export type ReconcileResult = Outcome

/** A commit's checks, check runs and commit statuses both, and their verdict. */
export async function checksAt(host: GithubHost, sha: string): Promise<ChecksState> {
  const [runs, status] = await Promise.all([host.github(`/commits/${sha}/check-runs?per_page=100`), host.github(`/commits/${sha}/status?per_page=100`)])
  if (runs.error !== undefined) return { error: runs.error }
  if (status.error !== undefined) return { error: status.error }
  const read = runs.status === 200 && status.status === 200 ? checksOf(runs.json, status.json) : undefined
  if (read === undefined) return { error: `the checks of ${short(sha)} could not be read (HTTP ${runs.status} and ${status.status})` }

  return judge(read)
}

/** The base branch's head and the verdict of its checks. */
export async function lookAtBase(host: SurveyHost): Promise<Look> {
  const base = await host.base()
  const branch = await host.github(`/branches/${encodeURIComponent(base)}`)
  if (branch.error !== undefined) return { error: branch.error }
  const head = branch.status === 200 ? headOf(branch.json) : undefined
  if (head === undefined) return { error: `the head of ${base} could not be read (HTTP ${branch.status})` }
  const verdict = await checksAt(host, head)
  if ('error' in verdict) return { error: verdict.error }

  return { head, verdict }
}

/** What GitHub says about a pull request and about the base branch, right now. */
export async function survey(host: SurveyHost, pr: number): Promise<Survey> {
  const branchName = await host.base()
  const [pulled, base] = await Promise.all([host.github(`/pulls/${pr}`), lookAtBase(host)])
  if (pulled.error !== undefined) return { error: pulled.error }
  if (pulled.status === 404) return { error: `it knows no pull request ${pr} in ${host.repo() ?? 'this repository'}` }
  const pull = pulled.status === 200 ? pullOf(pulled.json) : undefined
  if (pull === undefined) return { error: `pull request ${pr} could not be read (HTTP ${pulled.status})` }
  if ('error' in base) return { error: base.error }
  // A merged pull request's own checks decide nothing any more.
  const checks: ChecksState = pull.isMerged ? { verdict: 'green', line: 'merged', failed: [] } : await checksAt(host, pull.head)
  if ('error' in checks) return { error: checks.error }

  return { facts: { pull, checks, base: branchName, baseHead: base.head, main: base.verdict } }
}

/** The merges other runs of this repository have in flight. Never throws: a run that does not read is no reason to refuse. */
export async function flights(host: FlightHost, own: string, now: number): Promise<Flight[]> {
  const runs = host.runsDir()
  if (runs === undefined) return []
  const ledgers: Ledger[] = []
  try {
    for (const entry of await host.list(runs)) {
      if (entry.kind !== 'dir' || !RUN_ID.test(entry.name)) continue
      try {
        const parsed = parseLedger(await host.read(`${runs}/${entry.name}/ledger.json`))
        if (parsed.ledger !== undefined) ledgers.push(parsed.ledger)
      } catch {
        // A run folder without a ledger has no merge.
      }
    }
  } catch {
    return []
  }

  return flightsOf(ledgers, own, now)
}

/** Writes how a merge in flight went on or ended, and has the orchestrator told. Never throws. */
export async function settle(host: SettleHost, path: string, change: (raw: Raw) => Outcome): Promise<Settled> {
  const written = await host.mutate(path, raw => {
    const outcome = change(raw)

    return { value: outcome, isChanged: outcome.isChanged }
  })
  // The pane shows it at once, not at its next poll.
  await host.redraw()
  if (written.error !== undefined || written.value.isError) return undefined
  host.carry(written.value)

  return written.value
}

/**
 * A merge claim, settled with the pull request: merged on GitHub, the board
 * is set right; not reported merged, the claim is kept until `release` lets
 * it go, and not before two minutes have passed. `raw` is the ledger as its
 * host read it, edited in place; the host writes it when the answer says it
 * changed. Throws the words the Codex script prints.
 */
export async function reconcileRun(host: ReconcileHost, raw: Raw, input: ReconcileInput): Promise<ReconcileResult> {
  const flight = (raw.merge ?? fail('No merge claim needs reconciliation.')) as { pr?: unknown; startedAt?: unknown }
  const response = await host.github(`/pulls/${flight.pr}`)
  if (response.error !== undefined) throw new Error(response.error)
  const pull = pullOf(response.json) ?? fail('Cannot read the PR.')
  if (pull.isMerged && pull.commit) {
    const base = (raw as unknown as { codex: { base: string } }).codex.base

    return { ...onMain(raw, new Date(host.now()).toISOString(), pull.commit, base), text: 'Merge verified and board reconciled. Check base-branch CI now.' }
  }
  if (input.release !== true) return { isError: false, isChanged: false, text: 'GitHub does not report it merged. Claim retained. Inspect the PR; reconcile with release:true when the write has definitively settled.' }
  if (host.now() - Date.parse(String(flight.startedAt)) < 120000) fail('Wait at least two minutes before releasing an uncertain merge claim.')

  return abandoned(raw, 'After inspection, the merge was not applied.')
}

function fail(message: string): never {
  throw new Error(message)
}
