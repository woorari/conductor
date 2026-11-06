import type { Ledger, Task } from '../types'
import { afterDone, lookLines } from './problems'
import { changed, refused, tidy } from './signals'
import type { Caller, Outcome, Raw } from './signals'

/**
 * The merge loop's rules, as pure functions: what stands in the way of a
 * merge, what a commit's checks say, and every edit of the ledger a merge
 * makes. Asking GitHub is `register.tsx`'s; nothing here does.
 *
 * The forge is GitHub (github.com): the repository is the one the checkout's
 * `origin` names. In a checkout whose `origin` is elsewhere, none of it runs
 * (`isForges`), and a pull request is merged by that forge's own path.
 */

/** GitHub's REST API. */
export const API = 'https://api.github.com'

/** How long another run's merge in flight keeps this one waiting, in minutes: after that it is taken as abandoned. */
export const FLIGHT_FRESH_MIN = 45
/** A claim younger than this is the merge call still at work, in minutes: the watch leaves it alone. */
export const CLAIM_GRACE_MIN = 2

const MINUTE = 60_000

/** The ways GitHub merges a pull request. */
export const METHODS = ['merge', 'squash', 'rebase'] as const
export type Method = (typeof METHODS)[number]

/** What the person set when they installed the mod (`userConfig`), defaults filled in. */
export type Config = {
  /** The branch pull requests merge into. */
  base: string
  method: Method
  /** A GitHub token given as the mod's own option; empty when it is to come from the environment or `gh`. */
  token: string
}

export const DEFAULTS: Config = { base: 'main', method: 'merge', token: '' }

/** The mod's options as the engine hands them to `register`, read with care: anything missing or odd is the default. */
export function configOf(options: unknown): Config {
  const from = fieldsOf(options)
  const base = typeof from?.baseBranch === 'string' && from.baseBranch.trim() !== '' ? from.baseBranch.trim() : DEFAULTS.base
  const method = METHODS.find(one => one === from?.mergeMethod) ?? DEFAULTS.method
  const token = typeof from?.githubToken === 'string' ? from.githubToken.trim() : ''

  return { base, method, token }
}

/**
 * The `owner/name` a git remote's URL names, whatever host it goes by:
 * `git@host:owner/name.git`, `ssh://git@host:22/owner/name`, `https://host/owner/name.git`.
 */
export function slugOf(remote: string): string | undefined {
  const found = /(?:^|[/:])([^/:\s]+)\/([^/:\s]+)$/.exec(remote.trim().replace(/\/+$/, '').replace(/\.git$/i, ''))

  return found === null ? undefined : `${found[1]}/${found[2]}`
}

const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com', 'ssh.github.com'])

/**
 * The `owner/name` of a remote on github.com, or undefined for any other host:
 * `git@github.com:owner/name.git`, `ssh://git@ssh.github.com:443/owner/name.git`,
 * `https://github.com/owner/name`, with or without credentials in the URL.
 */
export function githubRepo(remote: string | null | undefined): string | undefined {
  if (typeof remote !== 'string') return undefined
  const found = /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim())
  if (found === null) return undefined
  const [, host = '', owner = '', name = ''] = found

  return GITHUB_HOSTS.has(host.toLowerCase()) && owner !== '' && name !== '' ? `${owner}/${name}` : undefined
}

/** Whether a checkout's `origin` is a repository on GitHub: only there does the board read a pull request or merge one. No origin is none. */
export const isForges = (remote: string | null | undefined): boolean => githubRepo(remote) !== undefined

/** What the forge's side of the mod answers in a checkout whose origin is not on GitHub: why it stands still there, and how a task is closed. */
export function elsewhere(remote: string | null | undefined): string {
  const here = typeof remote === 'string' ? slugOf(remote) : undefined

  return `This repository's origin is ${here === undefined ? 'not known (it has none to read)' : `${here}, which is not on GitHub`}, so the board reads no pull request and merges nothing here. A pull request is merged by this repository's own path, and its task is then done on the owner's word: /merged <task>.`
}

export const short = (sha: string): string => sha.slice(0, 7)

/** One check on a commit: a check run or a commit status, by its name, and where it stands. */
export type Check = { name: string; state: 'green' | 'failed' | 'pending'; shown: string }

/** What a commit's checks say: every one of them green, one failed, or not there yet. */
export type Verdict = { verdict: 'green' | 'failed' | 'running'; line: string; failed: string[] }

type Fields = Record<string, unknown>

const fieldsOf = (value: unknown): Fields | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : undefined

/** A check run's conclusions that count as passed. Anything else that finished counts as failed. */
const PASSED: ReadonlySet<string> = new Set(['success', 'neutral', 'skipped'])

/**
 * A commit's checks from GitHub's two answers about it: its check runs
 * (`/commits/<sha>/check-runs`, GitHub Actions among them) and its commit
 * statuses (`/commits/<sha>/status`, older integrations). Undefined when
 * either answer is not one. `isPartial` when GitHub has more of either than
 * the page holds: the verdict is then never green.
 */
export function checksOf(runs: unknown, status: unknown): { checks: Check[]; isPartial: boolean } | undefined {
  const fromRuns = fieldsOf(runs)
  const fromStatus = fieldsOf(status)
  const runList = fromRuns?.check_runs
  const statusList = fromStatus?.statuses
  if (!Array.isArray(runList) || !Array.isArray(statusList)) return undefined
  const checks: Check[] = []
  for (const one of runList) {
    const run = fieldsOf(one)
    if (typeof run?.name !== 'string' || typeof run.status !== 'string') return undefined
    const conclusion = typeof run.conclusion === 'string' ? run.conclusion : undefined
    if (run.status !== 'completed' || conclusion === undefined) checks.push({ name: run.name, state: 'pending', shown: run.status })
    else checks.push({ name: run.name, state: PASSED.has(conclusion) ? 'green' : 'failed', shown: conclusion })
  }
  for (const one of statusList) {
    const each = fieldsOf(one)
    if (typeof each?.context !== 'string' || typeof each.state !== 'string') return undefined
    const state = each.state === 'success' ? 'green' : each.state === 'failure' || each.state === 'error' ? 'failed' : 'pending'
    checks.push({ name: each.context, state, shown: each.state })
  }
  const total = (value: unknown, listed: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : listed)
  const isPartial = total(fromRuns?.total_count, runList.length) > runList.length || total(fromStatus?.total_count, statusList.length) > statusList.length

  return { checks, isPartial }
}

/**
 * The verdict on a commit's checks: failed when one failed, green when there
 * is at least one and every one passed, running otherwise. No check at all is
 * never green: a pull request nothing has checked is not called safe.
 */
export function judge(read: { checks: readonly Check[]; isPartial: boolean }): Verdict {
  const listed = [...read.checks].sort((a, b) => a.name.localeCompare(b.name))
  const line = (listed.map(one => `${one.name}=${one.shown}`).join(', ') || 'no checks yet') + (read.isPartial ? ' (more than one page of checks: not all read)' : '')
  const failed = listed.filter(one => one.state === 'failed').map(one => one.name)
  if (failed.length > 0) return { verdict: 'failed', line, failed }
  const isGreen = listed.length > 0 && !read.isPartial && listed.every(one => one.state === 'green')

  return { verdict: isGreen ? 'green' : 'running', line, failed: [] }
}

/** A pull request, as far as a merge needs it. */
export type Pull = {
  state: string
  isMerged: boolean
  /** GitHub's `mergeable`: true, false, or null while it is still working it out. */
  mergeable: boolean | null
  /** GitHub's `mergeable_state`: `clean`, `unstable`, `blocked`, `behind`, `dirty`, `draft`, `has_hooks` or `unknown`. */
  mergeableState: string
  isDraft: boolean
  /** The branch it merges into. */
  base: string
  /** Its head commit. */
  head: string
  title: string
  body: string
  /** The commit its merge made, once merged. */
  commit?: string
}

/** A pull request from GitHub's answer to `/pulls/<n>`; undefined when the answer is not one. */
export function pullOf(json: unknown): Pull | undefined {
  const from = fieldsOf(json)
  const head = fieldsOf(from?.head)
  const base = fieldsOf(from?.base)
  if (from === undefined || typeof from.state !== 'string' || typeof head?.sha !== 'string' || typeof base?.ref !== 'string') return undefined
  const isMerged = from.merged === true
  const commit = from.merge_commit_sha

  return {
    state: from.state,
    isMerged,
    mergeable: typeof from.mergeable === 'boolean' ? from.mergeable : null,
    mergeableState: typeof from.mergeable_state === 'string' ? from.mergeable_state : 'unknown',
    isDraft: from.draft === true,
    base: base.ref,
    head: head.sha,
    title: typeof from.title === 'string' ? from.title : '',
    body: typeof from.body === 'string' ? from.body : '',
    // Before a merge GitHub names a test merge here: it is the merge's commit only once merged.
    commit: isMerged && typeof commit === 'string' && commit !== '' ? commit : undefined,
  }
}

/** A branch's head commit from GitHub's answer to `/branches/<name>`. */
export function headOf(json: unknown): string | undefined {
  const sha = fieldsOf(fieldsOf(json)?.commit)?.sha

  return typeof sha === 'string' && sha !== '' ? sha : undefined
}

/** GitHub's own words about why a request was refused, from its answer's `message`; empty when it gave none. */
export function messageOf(text: string): string {
  try {
    const message = fieldsOf(JSON.parse(text) as unknown)?.message

    return typeof message === 'string' ? tidy(message).slice(0, 200) : ''
  } catch {
    return ''
  }
}

/** A text without its code: GitHub does not act on a keyword inside backticks or a fenced block. */
const prose = (text: string): string => text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')

const numbers = (found: Iterable<RegExpMatchArray>): number[] =>
  [...new Set([...found].map(one => Number(one[1])))].sort((a, b) => a - b)

/** The issues GitHub closes when a text with these words is merged into the default branch: its own keyword list, in prose. */
export const closes = (text: string): number[] =>
  numbers(prose(text).matchAll(/(?:^|[\s([])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\s:]+#(\d+)/gi))

/**
 * The issues a text might close: any word that starts like a closing keyword
 * in front of an issue number, in prose. Wider than GitHub's own list on
 * purpose, so that a wording nobody meant as a closing is asked about.
 */
export const mayClose = (text: string): number[] => numbers(prose(text).matchAll(/\b(?:clos|fix|resolv)[a-z]*[\s:]+#(\d+)/gi))

/** Another run's merge in flight. */
export type Flight = { run: string; task: string; pr?: number; revision?: string; startedAt: string }

/** The merges other runs have in flight, as far as they are fresh enough to wait for. */
export function flightsOf(ledgers: readonly Ledger[], own: string, nowMs: number): Flight[] {
  return ledgers.flatMap(one => {
    const flight = one.merge
    if (flight === undefined || one.run.id === own) return []
    const age = nowMs - Date.parse(flight.startedAt)

    return age >= 0 && age < FLIGHT_FRESH_MIN * MINUTE ? [{ run: one.run.id, task: flight.task, ...(flight.pr === undefined ? { revision: flight.revision } : { pr: flight.pr }), startedAt: flight.startedAt }] : []
  })
}

/** What a merge was asked with, once the board's own side of it holds. */
export type Asked = {
  task: Task
  pr: number
  closes: number[]
  told: string[]
  isOnRedMain: boolean
  /** The tasks this one waits for that are not merged yet, each with where it stands. */
  unmerged: string[]
  /**
   * What the problems found under this task still wait for: each a decision the orchestrator owes
   * before it lands (it still holds, so it gets a task; or it does not, so it is resolved).
   */
  problems?: string[]
  /** Since when the owner holds the run, when they do: nothing is merged meanwhile. */
  pausedAt?: string
}

const wholeNumbers = (value: unknown): number[] | undefined =>
  Array.isArray(value) && value.every(one => typeof one === 'number' && Number.isInteger(one) && one >= 1) ? [...new Set(value as number[])] : undefined

/**
 * The board's side of a merge, before GitHub is asked: who asks, for which
 * task, and that nothing else is merging in this run or another.
 */
export function precheck(
  ledger: Ledger,
  caller: Caller,
  input: Record<string, unknown>,
  others: readonly Flight[],
  isCheckOnly: boolean,
): Asked | { error: string } {
  if (caller.kind !== 'orchestrator') return { error: 'Only the orchestrator merges. A worker never does: set your task to review and hand back.' }
  const task = ledger.tasks.find(one => one.id === input.task)
  if (task === undefined) return { error: `There is no task ${String(input.task)} in this run. Its tasks: ${ledger.tasks.map(one => one.id).join(', ')}.` }
  if (task.status === 'done') return { error: `${task.id} is done already.` }
  if (task.pr === undefined) return { error: `${task.id} has no pull request: record its number with task_update first.` }
  const expected = input.closes === undefined ? [] : wholeNumbers(input.closes)
  if (expected === undefined) return { error: 'closes is a list of issue numbers this merge is meant to close; leave it out for none.' }
  const told = input.told === undefined ? [] : input.told
  if (!Array.isArray(told) || told.some(one => typeof one !== 'string' || tidy(one) === '')) {
    return { error: 'told is a list of the sessions you told that you are about to merge (ListAgents shows who may merge); an empty list says there is nobody else.' }
  }
  if (!isCheckOnly && input.told === undefined) {
    return { error: 'Say whom you told first: {"told": [...]} names the sessions you told that you are about to merge (ListAgents shows who may merge); an empty list says there is nobody else.' }
  }
  const flight = ledger.merge
  if (flight !== undefined && flight.task !== task.id) {
    return { error: `${flight.task} is still merging (PR ${flight.pr}): one merge at a time. The board settles it and tells you.` }
  }
  if (flight !== undefined) return { error: `${task.id} is merging already (PR ${flight.pr}). The board settles it and tells you.` }
  const other = others[0]
  if (other !== undefined) {
    return { error: `Run ${other.run} is merging PR ${other.pr} (${other.task}) since ${other.startedAt}: one merge at a time, across runs too. Try again once it is settled.` }
  }

  // A task may be built before what it waits for is merged; it is merged only after.
  const unmerged = (task.dependsOn ?? []).flatMap(id => {
    const one = ledger.tasks.find(other => other.id === id)

    return one === undefined || one.status === 'done' ? [] : [`${one.id} (${one.status})`]
  })

  return {
    task,
    pr: task.pr,
    closes: expected,
    told: (told as string[]).map(tidy),
    isOnRedMain: input.onRedMain === true,
    unmerged,
    problems: lookLines(ledger, task.id),
    ...(ledger.run.pausedAt === undefined ? {} : { pausedAt: ledger.run.pausedAt }),
  }
}

/** What GitHub says about a pull request and about the base branch, at one moment. */
export type Facts = {
  pull: Pull
  /** The verdict of the pull request's own checks, on its head. */
  checks: Verdict
  /** The branch it is to merge into, as the mod is set up. */
  base: string
  baseHead: string
  /** The verdict of the base branch's checks on its head. */
  main: Verdict
}

/** The mergeable states in which GitHub would merge now: `unstable` is non-required checks failing, which the checks' own verdict says. */
const MERGES_NOW: ReadonlySet<string> = new Set(['clean', 'unstable', 'has_hooks'])

/** Why GitHub would not merge a pull request as it stands, from its `mergeable` and `mergeable_state`; undefined when it would. */
function unmergeable(pull: Pull, pr: string, base: string): string | undefined {
  if (pull.mergeable === null || pull.mergeableState === 'unknown') {
    return `GitHub has not worked out yet whether ${pr} can be merged: ask again in a moment.`
  }
  if (pull.mergeableState === 'dirty' || pull.mergeable === false) return `${pr} has a conflict with ${base}: have its branch updated and graded again.`
  if (pull.mergeableState === 'blocked') return `GitHub's branch protection blocks ${pr}: a required review or a required check is missing.`
  if (pull.mergeableState === 'behind') return `${pr} is behind ${base}, and branch protection wants it up to date: have its branch updated and graded again.`
  if (!MERGES_NOW.has(pull.mergeableState) && pull.mergeableState !== 'draft') return `GitHub says ${pr} cannot be merged as it is (mergeable_state ${pull.mergeableState}).`

  return undefined
}

/** Everything that stands in the way of merging now; empty when nothing does. */
export function obstacles(facts: Facts, asked: Asked): string[] {
  const { pull, checks, main, base } = facts
  const pr = `PR ${asked.pr}`
  const found: string[] = []
  if (asked.task.status !== 'green') {
    found.push(`${asked.task.id} is ${asked.task.status}: only a task you judged green (its checks green, its change reviewed) is merged.`)
  }
  if (asked.pausedAt !== undefined) found.push(`The run is paused by the owner since ${asked.pausedAt}: nothing is merged until they type /unpause.`)
  if (asked.unmerged.length > 0) {
    found.push(`${asked.task.id} waits for ${asked.unmerged.join(', ')}: what a task waits for is merged first, in that order.`)
  }
  // A problem found under a task is looked at again before the task lands, so that none is left standing for
  // what it was when it was found: either it holds and is given a task, or it does not and is resolved.
  found.push(...(asked.problems ?? []))
  if (pull.state !== 'open') found.push(`${pr} is ${pull.state}, not open.`)
  if (pull.isDraft) found.push(`${pr} is a draft.`)
  if (pull.base !== base) found.push(`${pr} merges into ${pull.base}, not ${base}.`)
  const why = pull.state === 'open' ? unmergeable(pull, pr, base) : undefined
  if (why !== undefined) found.push(why)
  if (checks.verdict === 'running') found.push(`${pr}'s checks have no verdict yet on ${short(pull.head)} (${checks.line}).`)
  if (checks.verdict === 'failed') found.push(`${pr}'s checks failed on ${short(pull.head)}: ${checks.failed.join(', ')}.`)
  // Checks still running on the base branch hold nothing; a failed one holds every merge but the repair's.
  if (main.verdict === 'failed' && !asked.isOnRedMain) {
    found.push(`The checks on ${base} failed for ${short(facts.baseHead)} (${main.failed.join(', ')}). Merging on top is for the pull request that repairs it: pass onRedMain: true for that one, and for no other.`)
  }
  const text = `${pull.title}\n${pull.body}`
  const unexpected = mayClose(text).filter(issue => !asked.closes.includes(issue))
  if (unexpected.length > 0) {
    found.push(`${pr}'s description would close ${unexpected.map(issue => `#${issue}`).join(', ')}, which this merge was not said to close. Pass closes: [${unexpected.join(', ')}] if that is meant; otherwise have the wording changed.`)
  }
  const silent = asked.closes.filter(issue => !closes(text).includes(issue))
  if (silent.length > 0) {
    found.push(`${pr} is meant to close ${silent.map(issue => `#${issue}`).join(', ')}, but its description does not say so in plain text (a "Closes #N" inside backticks does nothing): the issue would stay open.`)
  }

  return found
}

/** What the pull request's merge would close, for the line that says so. */
export const closingLine = (issues: readonly number[]): string =>
  issues.length === 0 ? 'it closes no issue' : `it closes ${issues.map(issue => `#${issue}`).join(', ')}`

const flightOf = (raw: Raw): Record<string, unknown> | undefined => fieldsOf(raw.merge)

/** The merge is claimed: from now no other starts, here or in another run. */
export function startMerge(raw: Raw, at: string, claim: { task: string; pr: number; head: string; told: string[]; closes: number[] }): Outcome {
  const flight = flightOf(raw)
  if (flight !== undefined) return refused(`${String(flight.task)} is ${String(flight.state)} already: one merge at a time.`)
  const task = raw.tasks.find(one => one.id === claim.task)
  if (task === undefined || task.status === 'done') return refused(`${claim.task} is no open task of this run any more.`)
  raw.merge = {
    task: claim.task,
    pr: claim.pr,
    head: claim.head,
    state: 'merging',
    startedAt: at,
    ...(claim.told.length > 0 ? { told: claim.told } : {}),
    ...(claim.closes.length > 0 ? { closes: claim.closes } : {}),
  }

  return changed(`${claim.task} claimed for merging.`)
}

/**
 * The pull request is merged: the task is done. The base branch's checks on
 * it are watched from now, for the run's sake: a red base branch is said, and
 * holds every merge but the one that repairs it.
 */
export function onMain(raw: Raw, at: string, commit: string, base: string, how: { isAdopted?: boolean; pr?: number; task?: string } = {}): Outcome {
  const flight = flightOf(raw)
  const id = flight === undefined ? how.task : String(flight.task)
  const task = id === undefined ? undefined : raw.tasks.find(one => one.id === id)
  if (task === undefined) return refused('No merge is in flight.')
  const pr = flight === undefined ? how.pr : Number(flight.pr)
  task.status = 'done'
  task.finishedAt ??= at
  task.mergeCommit = commit
  task.mergedAt = at
  delete raw.merge
  raw.main = { since: at, commit }
  const left = afterDone(raw, task.id)
  // A pull request merged by hand is taken over during a pause too: then nothing is to start.
  const isPaused = typeof (raw.run as Record<string, unknown> | undefined)?.pausedAt === 'string'
  const next = isPaused ? 'The run is paused: nothing starts or merges until the owner types /unpause.' : 'Go on at once: start what can start and merge the next green task.'

  return changed(
    `${how.isAdopted === true ? 'Taken over' : 'Merged'}: PR ${String(pr)} (${task.id}) is on ${base} as ${short(commit)}, and the task is done. ${next} The board watches the checks on ${base} and says so if they fail.${left === '' ? '' : ` ${left}`}`,
  )
}

/** GitHub did not merge it: the claim is let go, and the task stands where it stood. */
export function abandoned(raw: Raw, why: string): Outcome {
  const flight = flightOf(raw)
  if (flight === undefined) return refused('No merge is in flight.')
  delete raw.merge
  const text = `Run board: PR ${String(flight.pr)} (${String(flight.task)}) was not merged: ${why}. The claim is let go; the task stands where it stood.`

  return { ...changed(text), tell: text }
}

/** What a look at the base branch found: its head and its checks' verdict, or why it could not be asked. */
export type Look = { head: string; verdict: Verdict } | { error: string }

const unquoted = (token: string): string => token.replace(/^["']+|["']+$/g, '')

/** Git's options that take a value of their own, in front of the subcommand. */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** The arguments of `git push` in one command of a shell line; undefined when it is no push. */
function pushArguments(tokens: readonly string[]): string[] | undefined {
  let at = tokens.indexOf('git')
  if (at === -1) return undefined
  at += 1
  while (at < tokens.length && (tokens[at] ?? '').startsWith('-')) at += GIT_VALUE_OPTIONS.has(tokens[at] ?? '') ? 2 : 1

  return tokens[at] === 'push' ? tokens.slice(at + 1) : undefined
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * What a shell command would do to the base branch by hand, if anything:
 * merge a pull request through GitHub's API or `gh`, or push to the base
 * branch. A reading of the text, so a merge wrapped in a script is not seen:
 * the guard is for the honest path, not a wall.
 */
export function byHand(command: string, base: string): string | undefined {
  if (/\/pulls\/\d+\/merge\b/.test(command) || /\bgh\s+pr\s+merge\b/.test(command)) return 'merges a pull request'
  const isBase = new RegExp(`^(?:[^:]*:)?(?:refs/heads/)?${escaped(base)}$`)
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const pushed = pushArguments(segment.trim().split(/\s+/).map(unquoted))
    if (pushed === undefined) continue
    if (pushed.some(token => isBase.test(token.replace(/^\+/, '')))) return `pushes to ${base}`
  }

  return undefined
}

/** `/merged`: the owner says a task's pull request is merged, by their own hand. */
export function ownerSaysMerged(raw: Raw, at: string, taskId: string): Outcome {
  const task = raw.tasks.find(one => one.id === taskId)
  if (task === undefined) return refused(`There is no task ${taskId} in this run.`)
  if (task.status === 'done') return refused(`${taskId} is done already.`)
  const flight = flightOf(raw)
  if (flight !== undefined && flight.task === taskId) delete raw.merge
  task.status = 'done'
  task.finishedAt ??= at
  task.mergedAt ??= at
  task.note = "merged, by the owner's word"
  const left = afterDone(raw, taskId)
  const done = `${taskId} is done, by your word that its pull request is merged.`

  // The owner said it at their own prompt: the orchestrator reads what hangs on it with its next tool result.
  return left === '' ? changed(done) : { ...changed(done), tell: `Run board: ${taskId} is done by the owner's word. ${left}` }
}
