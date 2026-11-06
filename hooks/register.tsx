import { atom, read, update } from 'claude-code'
import type { CatchHandler, Elements, EngineInterface, Hook, Register } from 'claude-code'

import type { BoardState, Ledger, ModelTier } from '../types'
import {
  API,
  CLAIM_GRACE_MIN,
  DEFAULTS,
  abandoned,
  byHand,
  checksOf,
  closes,
  closingLine,
  configOf,
  elsewhere,
  flightsOf,
  githubRepo,
  headOf,
  isForges,
  judge,
  messageOf,
  obstacles,
  onMain,
  ownerSaysMerged,
  precheck,
  pullOf,
  short,
  startMerge,
} from './merge'
import type { Config, Facts, Flight, Look, Verdict } from './merge'
import { DONE_SHOWN, boardView, clock, detail, orchestratorLine, problemDetail, runMinutes, summary, timeline } from './board'
import type { TaskRow } from './board'
import { dashboardSvg } from './dashboard'
import { KEEP, ROTATE_AT, carried, handover } from './handover'
import { LINEAR_KEY, RUN_ID, STATUSES, TIERS, parseLedger } from './ledger'
import { approvedMain, baseBroughtIn, conflicted, letGo, loreReady, onBase, onRunBranch, readyForBase, rev7, startLoreMerge } from './lore-merge'
import { LINEAR_API, M_CREATE, M_UPDATE, Q_ISSUE, Q_TEAM, apiKeyOf, createdOf, errorsOf, issueOf, issueText, stateFor, teamOf, updatedOf } from './linear'
import { branchInfoOf, ignoreRules, mergeOf, pushOf, repositoryInfoOf, statusOf } from './lore'
import { CONFIG_PATH, LORE_DEFAULTS, PLACEHOLDER_SNIPPET, hasPlaceholder, parseConfig, runsIgnored } from './project'
import { isInside, removals, runBranchOf, runWorkspaceOf, taskBranchOf, topLevel, workspaceOf, workspacesOf } from './workspace'
import type { RepositoryInfo } from './lore'
import { pauseRun, unpauseRun } from './pause'
import { LOOK_AGAIN_MIN, dueForLook, isUnderway, unsettled } from './problems'
import { APPROVED, PLANNING, conducting, newRun, planning } from './plan'
import { ORCHESTRATOR, briefing, digest, post, relative, rule, touch, waiting } from './posts'
import { HELPER_TYPES, familyOf, route, unlocked } from './router'
import type { Route, Spawn } from './router'
import {
  acted,
  activityText,
  addTask,
  approvePlan,
  askAgain,
  assignProblem,
  ownerSetsTier,
  gauge,
  heldUp,
  markRead,
  overweight,
  proposePlan,
  released,
  reportProblem,
  reserved,
  resolveProblem,
  rotated,
  spawned,
  turnEnded,
  updateTask,
  weigh,
} from './signals'
import type { Caller, Delivery, Outcome, Raw, RawTask, Source } from './signals'
import { RUNS_DIR, boundKey, isStale, kept, ledgerPath, prepare } from './store'

const PANE = 'conductor-board'
const TITLE = 'Run board'
/** How often what the workers were seen doing is written to the ledger. */
const FLUSH_MS = 5000
/** `/board none` lets go of the run the session is bound to. */
const UNBIND = 'none'
const TOOL_ADD = 'mcp__conductor__task_add'
const TOOL_PLAN = 'mcp__conductor__run_plan'
const TOOL_POST = 'mcp__conductor__board_post'
const TOOL_RULE = 'mcp__conductor__board_rule'
const TOOL_READ = 'mcp__conductor__board_read'
const TOOL_MERGE = 'mcp__conductor__merge'
const TOOL_CHECK = 'mcp__conductor__merge_check'
/** How long GitHub may take over one request before it counts as not answering. */
const ASK_TIMEOUT_MS = 20_000
/** Every this many timer ticks a merge claim and the base branch's checks are looked at: about every half minute. */
const WATCH_EVERY = 6
/** Every this many timer ticks a working orchestrator's context is looked at: about every half minute. */
const GAUGE_EVERY = 6
/** After a compaction the engine skipped, how long before the mod asks again. */
const ROTATE_AGAIN_MS = 10 * 60_000
/** After a compaction that could not start (a turn was running after all), how long before the next try. */
const ROTATE_SOON_MS = 30_000
/** The tools whose `file_path` is a file the worker is changing. */
const WRITES: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit'])
const TOOL_UPDATE = 'mcp__conductor__task_update'
/** How many queued tasks get a tier picker under the board; the rest are set with /tier. */
const PICKERS_SHOWN = 8
const TIER_OPTIONS = TIERS.map(value => ({ value }))
const ROUTER_BROKE = 'conductor: the router failed, so no agent was started. /board none lets go of the run if this keeps happening.'
const TOOL_REPORT = 'mcp__conductor__problem_report'
const TOOL_RESOLVE = 'mcp__conductor__problem_resolve'
const TOOL_ASSIGN = 'mcp__conductor__problem_assign'
const NOT_DONE = 'Not done.'
/** A ticket in a tool's schema: a GitHub issue's number, or a Linear issue's key. */
const TICKET_PATTERN = LINEAR_KEY.source
/** After a merge the base branch's checks are watched this long at most, in minutes (proposed): a branch nothing checks has nothing to wait for. */
const MAIN_WATCH_MIN = 60
/**
 * How the orchestrator writes to the owner: they want to be informed, not
 * walked through the work. The board holds the detail.
 */
const REPORTING =
  '- What you write to the owner is an executive summary. The board shows where every task stands, so do not repeat it: say what changed since you last wrote and what happens next, in a few lines at most, with no list of tasks, checks, files or commands. Go into detail only where the owner has something to decide: then say what is to decide, the options, and which one you recommend and why, as fully as the decision needs. The notices the board sends you show in the conversation too: never quote or restate one, and when one changes nothing for the owner, answer it in one line.'
const BROKE = `${NOT_DONE} The board could not be written; nothing changed. Say so in your report.`
const NOT_BOUND = 'This session is bound to no run, so there is no board to write. The person binds it with /board <run id>.'
/** How often the open pane looks at the ledger file. */
const POLL_MS = 2000
/** Every this many polls: look for a newer run, and resolve the repository again. */
const RESCAN_EVERY = 10
/** Every this many polls: move the clock the elapsed times are drawn from. */
const CLOCK_EVERY = 15
/**
 * CSS pixels the picture is drawn at per cell of the pane's body: a cell is one
 * character of a 14px monospace face. Measured once (2026-10-09, Claude Code
 * 2.1.293, desktop): at 38 cells a 319px picture filled the body edge to edge.
 */
const PX_PER_COLUMN = 8.4

const EMPTY: BoardState = { runId: null, ledger: null, error: null }

const board = atom({ plugin: 'conductor', key: 'board' } as const, EMPTY)
const nowMs = atom({ plugin: 'conductor', key: 'nowMs' } as const, 0)
const pinnedRun = atom({ plugin: 'conductor', key: 'pinnedRun' } as const, null)

// What the poll remembers between ticks. A reload starts these over, and the
// first tick after it reads the ledger again: nothing drawn depends on them.
let root: string | null | undefined
/** The repository's `origin`, once it had one to read: what says whether the repository is on GitHub. */
let origin: string | null | undefined
/** What the person set when they installed the mod, read each time `register` runs. */
let config: Config = DEFAULTS
/** The token `gh auth token` gave, kept in this module's memory only: a reload, or a token GitHub refuses, asks for it again. */
let ghToken: string | undefined
/** The question to gh under way, which requests made at the same moment wait for together. */
let ghAsked: Promise<string | undefined> | undefined
let followed: string | null = null
let seen: { path: string; mtimeMs: number } | undefined
let shown = ''
let ticks = 0
let isTicking = false

// What the signals remember. A reload starts these over; `learn` fills the
// first two again from the ledger, and what was pending is at most a few
// seconds of "last seen doing".
/** Which task each known agent works for: a task's worker, and the subagents that worker started. */
const agents = new Map<string, string>()
/** The workers themselves: the agents whose turn ending hands a task back. */
const workers = new Set<string>()
/** What each task's worker was last seen doing, not yet written. */
const pending = new Map<string, string>()
/** The files each task's worker changed since the last write, relative to the repository. */
const changedFiles = new Map<string, Set<string>>()
/**
 * What waits for each reader: a task's worker by task id, the orchestrator
 * under its own name. The mod sends no messages (in a session whose
 * permissions are decided by a classifier, a message a plugin sends gets no
 * verdict and is refused, measured 2026-10-09). A reader is handed its inbox
 * with the result of its own next tool call, which needs no one's leave.
 */
const inbox = new Map<string, Delivery[]>()
/** Posts and rulings handed over since the last write. */
const handed: { source: Source; taskId: string }[] = []

/**
 * The questions the orchestrator has not been told of yet, by question id.
 * While its own turn runs it reads them with its next tool result, like any
 * board news. Only when it is idle is it woken with a prompt, and only for
 * what is still unanswered then: a prompt submitted during a turn is held by
 * the engine until the turn ends, by which time the question may be settled
 * (measured 2026-10-09: a wake-up arrived for a question already ruled on).
 * The engine also refuses a prompt submitted from inside a tool call, so the
 * wake-up comes from the timer.
 */
const wakes = new Map<string, string>()
/** Prompts the person's own commands (/conduct, /approve) left for the orchestrator: submitted by the timer like a wake-up. */
const asks: string[] = []
/** Whether the orchestrator's own turn is running; unknown after a reload, and then taken as idle. */
let isOrchestrating: boolean | undefined
let learnedFrom: string | undefined

// The orchestrator's own context. None of this is the run's: it is this session's, and a reload
// of the mod only forgets the last reading until the next one.
/** How full the orchestrator's context was at the last look, in percent. */
let lastPercent: number | undefined
let isRotating = false
/** The person asked for a rotation with /rotate, whatever the reading. */
let isRotateAsked = false
/** No compaction is tried before this moment. */
let rotateNotBefore = 0
/** The orchestrator was told, during a long turn, that its context is full enough to end the turn. */
let isNudged = false
/** The mod's own compaction hook added the run's state to the compacted conversation. */
let isCarried = false
let flushTicks = 0
/** How many tokens each task's worker held at its last model request, not yet written. */
const weights = new Map<string, number>()
/** The tasks whose worker was asked to hand back because its context passed the run's limit. */
const askedBack = new Set<string>()
/** Spawns the router has taken on and not yet decided: if its hook fails now, they are refused. */
const routing = new Set<string>()
/** The reason the engine last gave for refusing a compaction, said once: it is told again only when it changes. */
let heldFor: string | undefined
/** A look at a merge claim whose call never settled is under way: the next one waits for it. */
let isWatching = false
/** A look at the base branch's checks after a merge is under way. */
let isWatchingMain = false
/** A look at the problems nobody deals with is under way. */
let isLooking = false
/** The commands and tools the engine would not take when the mod started, each with the engine's reason. */
const unlisted: string[] = []

const iso = (ms: number): string => new Date(ms).toISOString()

type Written<T> = { value: T; error?: undefined } | { value?: undefined; error: string }

/** How often a read that caught the ledger half written is tried again, and how long it waits. */
const ATTEMPTS = 3
const RETRY_MS = 150

// One write at a time: every change reads the file as it is now, edits it and
// writes it back before the next one starts, so two signals never lose each other.
let queue: Promise<unknown> = Promise.resolve()

async function attempt<T>(
  $: EngineInterface,
  path: string,
  change: (raw: Raw) => { value: T; isChanged: boolean },
): Promise<Written<T>> {
  let refusal = ''
  for (let tries = 0; tries < ATTEMPTS; tries += 1) {
    if (tries > 0) await $.clock.sleep(RETRY_MS)
    let source: string
    try {
      source = await $.fs.read(path)
    } catch {
      return { error: `There is no ledger at ${path}.` }
    }
    const prepared = prepare(source, change)
    if (prepared.error === undefined) {
      if (prepared.write !== undefined) await $.fs.write(path, prepared.write)

      return { value: prepared.value }
    }
    if (!prepared.isTorn) return { error: prepared.error }
    refusal = prepared.error
  }

  return { error: `The ledger at ${path} does not read: ${refusal}.` }
}

/**
 * Reads the ledger, lets `change` edit its JSON and writes it back, after
 * every change asked for before this one. Never rejects.
 */
function mutate<T>(
  $: EngineInterface,
  path: string,
  change: (raw: Raw) => { value: T; isChanged: boolean },
): Promise<Written<T>> {
  const run = queue
    .then(() => attempt($, path, change))
    .catch((cause: unknown): Written<T> => ({
      error: `The ledger could not be written: ${cause instanceof Error ? cause.message : String(cause)}`,
    }))
  queue = run

  return run
}

function learn(ledger: Ledger, path: string): void {
  if (learnedFrom !== path) {
    agents.clear()
    workers.clear()
    pending.clear()
    changedFiles.clear()
    inbox.clear()
    handed.length = 0
    wakes.clear()
    isolated.clear()
    workspaces.clear()
    learnedFrom = path
    // What the ledger says still waits for a reader waits again after a reload.
    for (const delivery of waiting(ledger)) inbox.set(delivery.taskId, [...(inbox.get(delivery.taskId) ?? []), delivery])
  }
  for (const task of ledger.tasks) {
    if (task.workspace !== undefined) {
      isolated.add(task.id)
      workspaces.set(task.id, task.workspace)
    }
    if (task.agentId === undefined) continue
    agents.set(task.agentId, task.id)
    workers.add(task.agentId)
  }
}

/**
 * Whether this repository is on GitHub: its `origin` names a repository on
 * github.com. Asked before anything asks GitHub, since a pull request's number
 * means something only there. A repository that could not be read is not
 * known to be on GitHub, and is read again.
 */
async function isAtForge($: EngineInterface): Promise<boolean> {
  try {
    if (typeof origin !== 'string') origin = (await $.session.repo())?.remote ?? null
  } catch {
    return false
  }

  return isForges(origin)
}

/** This repository's `owner/name` on GitHub, once `isAtForge` has read its origin. */
const repoHere = (): string | undefined => githubRepo(origin)

/**
 * Where the session works: a git repository (GitHub or elsewhere), or a Lore
 * workspace. A Lore workspace whose `lore` could not be run, or whose
 * repository could not be read, still has its root: the mod can then say what
 * is missing instead of staying silent.
 */
type LoreBackend = { kind: 'lore'; root: string; bin?: string; info?: RepositoryInfo; problem?: string }
type Backend = { kind: 'git'; root: string; remote: string | null } | LoreBackend

let backend: Backend | null | undefined
/** The `lore` binary that ran, once one did: kept for this module's life. */
let loreFound: string | undefined

const LORE_MISSING =
  "lore could not be run: not as lore on the PATH, and not as ~/.local/bin/lore. Set its full path in the mod's Lore program option, or export LORE_BIN, then start a new session."
/** The person's own word on which lore to run: the mod's Lore program option. LORE_BIN comes after it. */
let loreOption: string | undefined
/** The key of the mod's Linear API key option; empty when none. LINEAR_API_KEY comes after it. */
let linearOption = ''
/** Why the last Linear state change failed, said once as a problem: later ones for the same reason are not said again. */
let linearFailed: string | undefined

type Ran = { exitCode: number; stdout: string; stderr: string; out: string }

/** The `lore` binary to run: the one that answered `--version`, tried on the PATH and then in ~/.local/bin. */
async function loreBin($: EngineInterface, cwd: string): Promise<string | undefined> {
  if (loreFound !== undefined) return loreFound
  const home = await $.env.get('HOME').catch(() => undefined)
  // Only the person says which program runs, never the repository: a path they give is the one, and no other is tried in its place.
  const fromEnv = (await $.env.get('LORE_BIN').catch(() => undefined))?.trim()
  const configured = loreOption ?? (fromEnv === undefined || fromEnv === '' ? undefined : fromEnv)
  const candidates = configured !== undefined ? [configured] : ['lore', ...(home === undefined ? [] : [`${home}/.local/bin/lore`])]
  for (const candidate of candidates) {
    try {
      const ran = await $.process.run([candidate, '--version'], { cwd, timeoutMs: 10_000 })
      if (ran.exitCode === 0) {
        loreFound = candidate

        return candidate
      }
    } catch {
      // Not this one.
    }
  }

  return undefined
}

/**
 * Runs `lore --non-interactive <args>` in a folder, without a shell. Never
 * throws: a program that could not be run, or ran out of time, answers a
 * non-zero exit with the reason. `out` is what it printed on both streams,
 * which is what Lore's messages are read from.
 */
async function lore($: EngineInterface, args: readonly string[], cwd: string, timeoutMs = 30_000): Promise<Ran> {
  const bin = await loreBin($, cwd)
  if (bin === undefined) return { exitCode: 127, stdout: '', stderr: LORE_MISSING, out: LORE_MISSING }
  try {
    const ran = await $.process.run([bin, '--non-interactive', ...args], { cwd, timeoutMs })

    return { exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr, out: `${ran.stdout}${ran.stderr === '' ? '' : `\n${ran.stderr}`}` }
  } catch (cause) {
    const reason = because(cause)

    return { exitCode: 1, stdout: '', stderr: reason, out: reason }
  }
}

/** The nearest folder at or above the session's own that holds a `.lore` folder. */
async function loreRoot($: EngineInterface): Promise<string | null> {
  let dir = (await $.session.cwd().catch(() => '')).replace(/\/+$/, '')
  while (dir !== '') {
    if (await $.fs.exists(`${dir}/.lore`).catch(() => false)) return dir
    dir = dir.slice(0, dir.lastIndexOf('/'))
  }

  return null
}

/** Where the session works, read once: git first, as before, then a Lore workspace. Null outside both. */
async function backendOf($: EngineInterface): Promise<Backend | null> {
  if (backend !== undefined) return backend
  const repo = await $.session.repo().catch(() => null)
  if (repo !== null && repo !== undefined) {
    backend = { kind: 'git', root: repo.root, remote: repo.remote }

    return backend
  }
  const found = await loreRoot($)
  if (found === null) {
    backend = null

    return backend
  }
  const bin = await loreBin($, found)
  if (bin === undefined) {
    // Not kept: lore may be installed meanwhile, and the next look finds it.
    return { kind: 'lore', root: found, problem: LORE_MISSING }
  }
  const asked = await lore($, ['repository', 'info'], found)
  const info = asked.exitCode === 0 ? repositoryInfoOf(asked.out) : undefined
  if (info === undefined) return { kind: 'lore', root: found, bin, problem: `lore could not read this workspace's repository: ${asked.out.trim() || `exit ${asked.exitCode}`}` }
  backend = { kind: 'lore', root: found, bin, info }

  return backend
}

/** How long a copy, a merge, a push or a listing of a large workspace may take: the engine's ceiling for one program. */
const LONG_MS = 600_000
/** Lists a copy's folders (each ending in /) and files into a file; the paths are parameters, never part of the script. */
const LIST_SCRIPT = 'find "$1" -mindepth 1 -type d -exec printf "%s/\\n" {} + > "$2" && find "$1" -mindepth 1 -type f >> "$2"'

/** Runs a program without a shell. Never throws: one that could not run, or ran out of time, answers a non-zero exit with why. */
async function runProgram($: EngineInterface, argv: readonly string[], timeoutMs = 30_000): Promise<Ran> {
  try {
    const ran = await $.process.run([...argv], { timeoutMs })

    return { exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr, out: `${ran.stdout}${ran.stderr === '' ? '' : `\n${ran.stderr}`}` }
  } catch (cause) {
    const reason = because(cause)

    return { exitCode: 1, stdout: '', stderr: reason, out: reason }
  }
}

/** The last line a program printed, for saying why it failed. */
const lastLine = (ran: Ran): string => ran.out.trim().split(/\n/).filter(line => line.trim() !== '').at(-1)?.trim() ?? `exit ${ran.exitCode}`

/** Runs a program on many paths, at most 200 to a call. Answers the first failure, or undefined. */
async function onPaths($: EngineInterface, head: readonly string[], paths: readonly string[]): Promise<Ran | undefined> {
  for (let at = 0; at < paths.length; at += 200) {
    const ran = await runProgram($, [...head, ...paths.slice(at, at + 200)], LONG_MS)
    if (ran.exitCode !== 0) return ran
  }

  return undefined
}

type Making = { root: string; base: string; path: string; branch: string; from: string; carry: readonly string[]; minFreeGB: number; runId: string; taskId: string }

/**
 * Makes a Lore workspace for one task: a copy-on-write copy of the owner's
 * workspace that takes the tracked files and the folders the project carries
 * and nothing else, made a workspace of its own, on its own branch. The
 * owner's workspace is only read. On any failure the half-made copy is
 * removed and the reason answered.
 */
async function prepareWorkspace($: EngineInterface, at: Making): Promise<{ path: string; error?: undefined } | { error: string }> {
  // Only a folder the mod makes itself, inside the run's workspaces and outside the owner's workspace, is ever removed.
  if (!isInside(at.base, at.path) || at.path === at.root || at.path.startsWith(`${at.root}/`)) return { error: `${at.path} is no place for a workspace: it must lie inside ${at.base}, outside ${at.root}` }
  if (await $.fs.exists(at.path).catch(() => true)) return { error: `${at.path} is there already and is no Lore workspace; it is left as it is. Move it away, then start the worker again` }
  const fail = async (why: string) => {
    await runProgram($, ['rm', '-rf', '--', at.path], LONG_MS)

    return { error: why }
  }
  const made = await runProgram($, ['mkdir', '-p', at.path])
  if (made.exitCode !== 0) return fail(`its folder could not be made: ${lastLine(made)}`)
  const df = await runProgram($, ['df', '-Pk', at.path])
  const freeKb = Number(df.stdout.trim().split(/\n/).at(-1)?.trim().split(/\s+/)[3])
  if (df.exitCode !== 0 || !Number.isFinite(freeKb)) return fail(`df did not say how much disk is free: ${lastLine(df)}`)
  const freeGb = Math.floor(freeKb / 1024 / 1024)
  if (freeGb < at.minFreeGB) {
    return fail(`only ${freeGb} GB are free on the disk that holds ${at.path}, and a worker's workspace needs at least ${at.minFreeGB} GB free (lore.minFreeGB in .claude/conductor/config.json)`)
  }
  const rules = ignoreRules((await textAt($, `${at.root}/.loreignore`)) ?? '')
  const entries = (await $.fs.list(at.root)).map(one => ({ name: one.name, isDir: one.kind === 'dir' }))
  for (const entry of topLevel(entries, rules, at.carry)) {
    const copied = await runProgram($, ['cp', '-c', '-R', `${at.root}/${entry}`, `${at.path}/`], LONG_MS)
    if (copied.exitCode !== 0) return fail(`${entry} could not be copied: ${lastLine(copied)}`)
  }
  const listing = `${at.root}/${RUNS_DIR}/${at.runId}/listing-${at.taskId}.txt`
  const listed = await runProgram($, ['/bin/sh', '-c', LIST_SCRIPT, 'sh', at.path, listing], LONG_MS)
  if (listed.exitCode !== 0) return fail(`the copy's files could not be listed: ${lastLine(listed)}`)
  const relativeListing = ((await textAt($, listing)) ?? '')
    .split('\n')
    .map(line => (line.startsWith(`${at.path}/`) ? line.slice(at.path.length + 1) : line))
    .join('\n')
  const removedFailed = await onPaths($, ['rm', '-rf', '--'], removals(relativeListing, rules, at.carry).map(one => `${at.path}/${one}`).filter(one => isInside(at.path, one)))
  if (removedFailed !== undefined) return fail(`what the copy must not hold could not be removed: ${lastLine(removedFailed)}`)
  const step = async (args: readonly string[], timeoutMs = 30_000): Promise<Ran> => lore($, args, at.path, timeoutMs)
  const updated = await step(['repository', 'update-path'])
  if (updated.exitCode !== 0) return fail(`lore did not take the copy as a workspace of its own: ${lastLine(updated)}`)
  const scanned = await step(['status', '--scan'], LONG_MS)
  const status = statusOf(scanned.out)
  if (scanned.exitCode !== 0 || status === undefined) return fail(`lore could not read the copy's status: ${lastLine(scanned)}`)
  const untrackedFailed = await onPaths($, ['rm', '-f', '--'], status.untracked.map(one => `${at.path}/${one}`).filter(one => isInside(at.path, one)))
  if (untrackedFailed !== undefined) return fail(`the copy's untracked files could not be removed: ${lastLine(untrackedFailed)}`)
  const from = await step(['branch', 'switch', at.from, '--reset'], LONG_MS)
  if (from.exitCode !== 0) return fail(`lore could not switch the copy to ${at.from}: ${lastLine(from)}`)
  const info = branchInfoOf((await step(['branch', 'info', at.branch])).out)
  if (info?.remoteLatest !== undefined) {
    // A task started again goes on from what its branch holds.
    const again = await step(['branch', 'switch', at.branch, '--reset'], LONG_MS)
    if (again.exitCode !== 0) return fail(`lore could not switch the copy to ${at.branch}: ${lastLine(again)}`)
  } else {
    const created = await step(['branch', 'create', at.branch])
    if (created.exitCode !== 0) return fail(`lore could not make the branch ${at.branch}: ${lastLine(created)}`)
    const pushed = await step(['push'], LONG_MS)
    const outcome = pushOf(pushed.exitCode, pushed.out)
    if (outcome.kind === 'refused') return fail(`lore could not push the new branch ${at.branch}: ${outcome.text}`)
  }

  return { path: at.path }
}

/**
 * Before the owner's approval of a Lore run's plan takes effect: the run's
 * own workspace on its own branch, made from the base branch and pushed, the
 * base branch protected, and where the base stood kept. Answers why it could
 * not be done, or undefined when it was (or there is nothing of Lore to do).
 */
async function loreApprove($: EngineInterface, path: string): Promise<string | undefined> {
  const ledger = parseLedger((await textAt($, path)) ?? '').ledger
  const here = await backendOf($)
  const runLore = ledger?.run.lore
  if (ledger === undefined || runLore === undefined || ledger.run.plan !== 'proposed' || here?.kind !== 'lore') return undefined
  const project = ledger.run.config
  const workspacesBase = workspacesOf(here.root, project?.lore?.workspaces)
  const workspace = runLore.workspace ?? runWorkspaceOf(workspacesBase, ledger.run.id)
  if (!(await $.fs.exists(`${workspace}/.lore`).catch(() => false))) {
    await Promise.resolve($.ui.toast("Run board: making the run's Lore workspace. A large workspace takes a minute or two.")).catch(() => undefined)
    const made = await prepareWorkspace($, {
      root: here.root,
      base: workspacesBase,
      path: workspace,
      branch: runLore.branch,
      from: runLore.base,
      carry: project?.lore?.carry ?? LORE_DEFAULTS.carry,
      minFreeGB: project?.lore?.minFreeGB ?? LORE_DEFAULTS.minFreeGB,
      runId: ledger.run.id,
      taskId: '_run',
    })
    if (made.error !== undefined) return `the run's Lore workspace could not be made: ${made.error}.`
  }
  const protectedNow = await lore($, ['branch', 'protect', runLore.base], workspace)
  if (protectedNow.exitCode !== 0) return `the base branch ${runLore.base} could not be protected: ${lastLine(protectedNow)}.`
  const baseAt = branchInfoOf((await lore($, ['branch', 'info', runLore.base], workspace)).out)?.remoteLatest
  if (baseAt === undefined) return `lore did not say where ${runLore.base} stands.`
  const written = await mutate($, path, raw => {
    const kept = (raw.run as { lore?: Record<string, unknown> }).lore
    if (kept === undefined) return { value: false, isChanged: false }
    kept.workspace = workspace
    kept.baseAt = baseAt

    return { value: true, isChanged: true }
  })

  return written.error ?? (written.value ? undefined : 'the run has no Lore branch any more.')
}

/** A worker's workspace made and not handed to the engine yet, by task. */
const prepared = new Map<string, string>()
/** Starts whose workspace waits for the engine's WorktreeCreate, oldest first. One is in flight at a time. */
const awaitingWorktree: { taskId: string; path: string }[] = []
/** The tasks whose worker was handed a workspace of its own: the others' workers may not write. */
const isolated = new Set<string>()
/** Each such task's workspace, for reading the paths its worker changes. */
const workspaces = new Map<string, string>()
let startChain: Promise<void> = Promise.resolve()

/**
 * One Lore worker start at a time, from making its workspace until the engine
 * has started it: the engine names the workspace it asks for after the agent,
 * not the task, so the start in flight is the one it is for.
 */
function exclusive(): Promise<() => void> {
  let unlock: () => void = () => undefined
  const mine = new Promise<void>(resolve => {
    unlock = resolve
  })
  const prior = startChain
  startChain = prior.then(() => mine)

  return prior.then(() => unlock)
}

/** A file's text, or undefined when it is not there or cannot be read. */
async function textAt($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

/** The root of the repository or workspace the session is in, read again on a rescan; null outside both. */
async function rootOf($: EngineInterface, rescan = false): Promise<string | null> {
  if (rescan && backend?.kind !== 'lore') backend = undefined

  return (await backendOf($))?.root ?? null
}

/** The ledger this session's signals and tools write: the bound run's, or undefined. */
async function boundLedger($: EngineInterface): Promise<string | undefined> {
  const run = await read($, pinnedRun)
  if (run === null) return undefined
  if (root === undefined) root = await rootOf($)

  return root === null ? undefined : ledgerPath(root, run)
}

/**
 * Binds this session to a run, or lets go of it with null. The binding is
 * also written to the mod's own store under the session's id, because the
 * host forgets a session's state when its process ends (measured 2026-10-09:
 * after a restart of the app a session whose plan waited for approval was
 * bound to no run, and /approve refused).
 */
async function bind($: EngineInterface, run: string | null): Promise<void> {
  await update($, pinnedRun, () => run)
  try {
    const own = boundKey(await $.session.id())
    if (run === null) {
      await $.store.delete(own)

      return
    }
    const now = await $.clock.now()
    await $.store.set(own, { run, at: iso(now) })
    // The store is one file for every session there ever was: what is old is dropped here.
    for (const key of await $.store.keys()) {
      if (key.startsWith(boundKey('')) && isStale(await $.store.get(key), now)) await $.store.delete(key)
    }
  } catch {
    // Not kept: the session stays bound for as long as its process lives.
  }
}

/**
 * A session that starts again takes up the run it was bound to. One that is
 * bound and not written down yet (bound before the mod kept bindings) is
 * written down. Never throws.
 */
async function rebind($: EngineInterface): Promise<void> {
  try {
    const own = boundKey(await $.session.id())
    const now = await read($, pinnedRun)
    const was = kept(await $.store.get(own))?.run
    if (now !== null) {
      if (was !== now) await $.store.set(own, { run: now, at: iso(await $.clock.now()) })

      return
    }
    if (was === undefined) return
    if (root === undefined) root = await rootOf($)
    // A run that is gone is not one to be bound to.
    if (root === null || !(await $.fs.exists(ledgerPath(root, was)))) {
      await $.store.delete(own)

      return
    }
    await update($, pinnedRun, () => was)
  } catch {
    // What was kept could not be read: the session is bound to no run, and says how to bind it.
  }
}

/** What a command answers in a session bound to no run: which run to bind, when the repository has one. Never throws. */
async function unbound($: EngineInterface): Promise<string> {
  let viewed: string | null = null
  try {
    await refresh($, true)
    viewed = (await read($, board)).runId
  } catch {
    viewed = null
  }

  return viewed === null
    ? 'This session is bound to no run: /board <run id> binds it.'
    : `This session is bound to no run; it only views ${viewed}. /board ${viewed} binds it: then give this command again.`
}

/** Knows the bound run's workers again after a reload: one read, the first time it is asked. */
async function remember($: EngineInterface, path: string): Promise<void> {
  if (learnedFrom === path) return
  try {
    const parsed = parseLedger(await $.fs.read(path))
    if (parsed.ledger !== undefined) learn(parsed.ledger, path)
  } catch {
    // No ledger yet: there is nobody to remember.
  }
}

const callerOf = (agentId: string | undefined): Caller => {
  if (agentId === undefined) return { kind: 'orchestrator' }
  const taskId = agents.get(agentId)

  return taskId === undefined ? { kind: 'stranger' } : { kind: 'worker', taskId }
}

/** A tool call as the signals read it: the tool, the loop it ran in, and its own arguments. */
type ToolCall = { tool: string; agentId?: string } & Record<string, unknown>

/** Serves one of the mod's own tools: one validated, serialised change to the bound run's ledger. */
async function answer(
  $: EngineInterface,
  call: ToolCall,
  change: (raw: Raw, at: string, caller: Caller, input: Record<string, unknown>) => Outcome,
): Promise<{ result: string; text: string; isError?: undefined } | { isError: true; result: string; text: string }> {
  // Measured with a real worker (2026-10-09): the error flag of a mod's own tool does not reach the
  // model, which reads the text alone. So a refusal says in its first words that nothing was done.
  const fail = (reason: string) => {
    const text = `${NOT_DONE} ${reason}`

    return { isError: true as const, result: text, text }
  }
  const path = await boundLedger($)
  if (path === undefined) return fail(NOT_BOUND)
  await remember($, path)
  const at = iso(await $.clock.now())
  const caller = callerOf(call.agentId)
  const written = await mutate($, path, raw => {
    const outcome = change(raw, at, caller, call)

    return { value: outcome, isChanged: outcome.isChanged }
  })
  if (written.error !== undefined) return fail(written.error)
  if (written.value.isError) return fail(written.value.text)
  carry(written.value)

  return { result: written.value.text, text: written.value.text }
}

/**
 * The router's hook failed. A spawn it had taken on is refused, since a
 * worker must never start on a model nobody chose; any other goes ahead.
 */
const unrouted: CatchHandler<Hook<'agent.spawn'>> = ($, e, next) => {
  if (next.called) return next(e)

  return routing.delete(e.tool_use_id) ? { deny: ROUTER_BROKE } : next(e)
}

/**
 * Decides a worker's start once more and claims it, in one step of the write
 * queue. The first decision was made on a ledger read a moment ago; of
 * several workers started in one message each one read it before any was
 * written down (measured 2026-10-09: four started together were all given
 * number 1, and one more ran than the run allowed). Here each is judged
 * against a board that already counts the ones before it.
 */
async function claim(
  $: EngineInterface,
  path: string,
  spawn: Spawn,
  name: string,
  first: Ledger,
): Promise<{ decided: Route; before?: RawTask; error?: undefined } | { error: string }> {
  const at = iso(await $.clock.now())
  const written = await mutate<{ decided: Route; before?: RawTask }>($, path, raw => {
    const decided = route(parseLedger(JSON.stringify(raw)).ledger ?? first, spawn)
    if (decided.kind !== 'worker') return { value: { decided }, isChanged: false }
    const before = reserved(raw, at, { taskId: decided.taskId, name, slot: decided.slot, builtOn: decided.base?.taskId })

    return { value: { decided, before }, isChanged: before !== undefined }
  })

  return written.error !== undefined ? { error: written.error } : written.value
}

/** Tells the board a routed agent started. Never throws: the agent runs whether or not the board heard. */
async function heard(
  $: EngineInterface,
  path: string,
  name: string,
  decided: Extract<Route, { kind: 'worker' | 'child' }>,
  started: { agentId?: string; model?: string },
): Promise<void> {
  const slot = decided.kind === 'worker' ? decided.slot : undefined
  try {
    const { agentId, model } = started
    if (agentId === undefined || model === undefined) return
    agents.set(agentId, decided.taskId)
    if (decided.kind === 'child') return
    workers.add(agentId)
    const at = iso(await $.clock.now())
    let ticket: unknown
    await mutate($, path, raw => {
      const taskId = spawned(raw, at, { name, agentId, model, slot })
      ticket = raw.tasks.find(one => one.id === taskId)?.ticket
      // The engine has the last word on the model. When it is not the tier's, the board says so.
      if (taskId !== undefined && familyOf(model) !== decided.model) {
        reportProblem(raw, at, { kind: 'orchestrator' }, {
          text: `${taskId} is tagged ${decided.model} but its worker runs on ${model}.`,
          severity: 'warning',
          task: taskId,
        })
      }

      return { value: taskId, isChanged: taskId !== undefined }
    })
    if (typeof ticket === 'string') await moveIssue($, path, ticket, 'started')
  } catch {
    // The worker runs whether or not the board heard of it.
  }
}

/** The owner picked a tier, in the pane or with /tier. Answers the line to show them. */
async function pick($: EngineInterface, taskId: string, tier: string): Promise<string> {
  const chosen = TIERS.find(one => one === tier)
  if (chosen === undefined) return `${tier} is no tier: ${TIERS.join(', ')}.`
  const path = await boundLedger($)
  if (path === undefined) return unbound($)
  const written = await mutate($, path, raw => {
    const outcome = ownerSetsTier(raw, taskId, chosen satisfies ModelTier)

    return { value: outcome, isChanged: outcome.isChanged }
  })
  seen = undefined
  await refresh($, false)

  return written.error ?? written.value.text
}

/** What one of the mod's tools answers when its own hook failed: an error the caller can read, never silence. */
function broke(): { isError: true; result: string; text: string } {
  return { isError: true, result: BROKE, text: BROKE }
}

/** Puts what a written change has for its readers into their inboxes, and notes what the orchestrator is to be told. */
function carry(outcome: Outcome): void {
  for (const delivery of outcome.deliveries ?? []) {
    inbox.set(delivery.taskId, [...(inbox.get(delivery.taskId) ?? []), delivery])
  }
  const told = [outcome.tell, outcome.wake].filter(one => one !== undefined)
  if (told.length > 0) {
    inbox.set(ORCHESTRATOR, [...(inbox.get(ORCHESTRATOR) ?? []), ...told.map(text => ({ taskId: ORCHESTRATOR, text }))])
  }
  if (outcome.wake !== undefined && outcome.asks !== undefined) wakes.set(outcome.asks, outcome.wake)
  if (outcome.answered !== undefined) forget(wakes.get(outcome.answered))
}

/** A question is settled or has been read: nobody is told of it again. */
function forget(text: string | undefined): void {
  if (text === undefined) return
  for (const [id, wake] of wakes) if (wake === text) wakes.delete(id)
  const rest = (inbox.get(ORCHESTRATOR) ?? []).filter(one => one.text !== text)
  if (rest.length > 0) inbox.set(ORCHESTRATOR, rest)
  else inbox.delete(ORCHESTRATOR)
}

/**
 * Hands a reader its inbox with the result of the tool call it just made:
 * what the model reads after the result. A refused call carries nothing, so
 * the inbox waits for the next one.
 */
function hand<R extends { deny?: string; context?: readonly string[] }>(reader: string, ran: R): R {
  const waits = inbox.get(reader)
  if (waits === undefined || waits.length === 0 || ran.deny !== undefined) return ran
  inbox.delete(reader)
  for (const one of waits) {
    if (one.source !== undefined) handed.push({ source: one.source, taskId: reader })
    if (reader === ORCHESTRATOR) forget(one.text)
  }

  return { ...ran, context: [...(ran.context ?? []), ...waits.map(one => one.text)] }
}

/** Wakes an idle orchestrator with the questions it has not read, as one prompt. Called from the timer, never from a tool call. */
function wake($: EngineInterface): void {
  if (isOrchestrating === true || wakes.size + asks.length === 0) return
  const questions = [...wakes.values()]
  for (const text of questions) forget(text)
  const texts = [...asks.splice(0), ...questions]
  void $.prompt.submit({ text: texts.join('\n\n') }).catch(() => undefined)
}

/** Looks at how full the orchestrator's context is, and writes it to a bound run's ledger. Never throws. */
async function gaugeNow($: EngineInterface): Promise<number | undefined> {
  try {
    const path = await boundLedger($)
    if (path === undefined) return undefined
    const { context } = await $.session.usage()
    lastPercent = context.percent
    const percent = context.percent
    if (percent === undefined) return undefined
    const at = iso(await $.clock.now())
    await mutate($, path, raw => ({ value: undefined, isChanged: gauge(raw, at, percent) }))

    return percent
  } catch {
    return undefined
  }
}

/**
 * The orchestrator's fresh start: when its context is full enough and no turn
 * of its own is running, the run's state is written to disk as the handover
 * and the session is compacted. The state comes back from the ledger, not
 * from the summary. Called from the timer; never throws.
 */
async function rotation($: EngineInterface): Promise<void> {
  if (isRotating || isOrchestrating === true) return
  if (!isRotateAsked && (lastPercent === undefined || lastPercent < ROTATE_AT)) return
  isRotating = true
  let now = 0
  // The try went on to the /compact command: a failure from there is not tried again half a minute later.
  let isByCommand = false
  try {
    const path = await boundLedger($)
    if (path === undefined) {
      isRotateAsked = false

      return
    }
    now = await $.clock.now()
    if (!isRotateAsked && now < rotateNotBefore) return
    const read = parseLedger(await $.fs.read(path))
    if (read.ledger === undefined) return
    // A run with nothing left to do has no orchestration to protect: its session is left as it is,
    // unless the person asks with /rotate.
    if (!isRotateAsked && read.ledger.tasks.every(task => task.status === 'done')) return
    const percent = lastPercent === undefined ? undefined : Math.round(lastPercent)
    const text = handover(read.ledger, { at: iso(now), percent, isElsewhere: !(await isAtForge($)) })
    await $.fs.write(path.replace(/ledger\.json$/, 'handover.md'), `${text}\n`)
    isCarried = false
    const before = lastPercent ?? (await gaugeNow($))
    let skip: string | undefined
    try {
      skip = (await $.session.compact({ instructions: KEEP })).skip
    } catch (refusal) {
      // The engine has no such call in a session the desktop app or an SDK host runs (its words,
      // measured 2026-10-09: "compaction here runs inside a turn (a /compact prompt)"), and refuses it
      // while a turn runs. The command is the same compaction as a turn of its own, run once the
      // session is idle. A command is not run every half minute: what fails from here waits ten.
      isByCommand = true
      try {
        await $.command.run({ command: 'compact', args: KEEP })
      } catch (cause) {
        throw new Error(`/compact could not be run for you (${because(cause)}); the engine's own call: ${because(refusal)}`)
      }
      const after = await gaugeNow($)
      if (before !== undefined && after !== undefined && after >= before) {
        throw new Error(`/compact ran and the context is no smaller (${Math.round(after)}%); the engine's own call: ${because(refusal)}`)
      }
    }
    isRotateAsked = false
    if (skip !== undefined) {
      rotateNotBefore = now + ROTATE_AGAIN_MS
      $.ui.toast(`Run board: not compacted (${skip}); the mod asks again in ten minutes.`)

      return
    }
    isNudged = false
    heldFor = undefined
    await mutate($, path, raw => {
      rotated(raw, iso(now))

      return { value: undefined, isChanged: true }
    })
    // The engine does not run a mod's own hook on a compaction that mod asked for, so the state did
    // not travel with the summary. It is added to the conversation as a note right behind it; where
    // the session refuses that, the orchestrator reads it first thing, with its next tool result.
    if (!isCarried) {
      const noted = await $.session
        .append({ message: { type: 'user', content: [{ type: 'text', text: carried(text) }] } })
        .then(row => row.deny === undefined)
        .catch(() => false)
      if (!noted) inbox.set(ORCHESTRATOR, [{ taskId: ORCHESTRATOR, text: carried(text) }, ...(inbox.get(ORCHESTRATOR) ?? [])])
    }
    const after = await gaugeNow($)
    $.ui.toast(
      `Run board: this session was compacted (${percent ?? '?'}% full${after === undefined ? '' : `, now ${Math.round(after)}%`}).`,
    )
  } catch (cause) {
    // Tried again later, and why it did not go through is kept on the board and said once, not thrown
    // away. The person's own /rotate was tried and answered: it is not repeated on every tick.
    rotateNotBefore = now + (isByCommand ? ROTATE_AGAIN_MS : ROTATE_SOON_MS)
    if (isByCommand) isRotateAsked = false
    await notCompacted($, because(cause), now)
  } finally {
    isRotating = false
  }
}

/**
 * Asks the orchestrator, once for the lot, to look again at the blockers and
 * warnings that nobody deals with and that have stood for `LOOK_AGAIN_MIN`
 * minutes or more since they were found or last asked about. The mod cannot
 * tell whether such a problem still holds; the orchestrator can, and what it
 * finds is either a task for it or its resolution. Called from the timer;
 * never throws, and a read that failed is tried again at the next look.
 */
async function lookAgain($: EngineInterface): Promise<void> {
  if (isLooking) return
  isLooking = true
  try {
    const path = await boundLedger($)
    if (path === undefined) return
    const ledger = parseLedger(await $.fs.read(path)).ledger
    if (ledger === undefined || !isUnderway(ledger.run, ledger.tasks)) return
    const at = iso(await $.clock.now())
    // Asked of the file again inside the write queue (`askAgain`), so a problem taken up meanwhile is left alone.
    if (dueForLook(ledger, Date.parse(at)).length === 0) return
    await settle($, path, raw => askAgain(raw, at))
  } catch {
    // Tried again at the next look.
  } finally {
    isLooking = false
  }
}

/**
 * After a merge: looks at the checks on the base branch for the run's sake. A
 * failure is said once, as a blocker, and holds every merge but its repair's;
 * a green head ends the watch, and so does a branch nothing checks, after a
 * while. Called from the timer; never throws, and a request that fails is no
 * verdict.
 */
async function watchMain($: EngineInterface): Promise<void> {
  if (isWatchingMain) return
  isWatchingMain = true
  try {
    const path = await boundLedger($)
    if (path === undefined) return
    const ledger = parseLedger(await $.fs.read(path)).ledger
    if (ledger?.main === undefined) return
    // The base branch is GitHub's: in a repository whose origin is elsewhere there are no checks to look at.
    if (!(await isAtForge($))) return
    const now = await $.clock.now()
    const at = iso(now)
    const look = await lookAtBase($)
    if ('error' in look) return
    if (look.verdict.verdict === 'running') {
      if (now - Date.parse(ledger.main.since) > MAIN_WATCH_MIN * 60_000) await mutate($, path, raw => ({ value: delete raw.main, isChanged: true }))

      return
    }
    if (look.verdict.verdict === 'failed') {
      // A newer push may have cancelled the checks of the commit before it: only a head that stood still counts.
      const again = await lookAtBase($)
      const line = `${short(look.head)}: ${look.verdict.failed.join(', ')}`
      if ('error' in again || again.head !== look.head || ledger.main.failed === line) return
      await settle($, path, raw => {
        const main = raw.main as Record<string, unknown> | undefined
        if (main === undefined) return { isChanged: false, isError: true, text: '' }
        main.failed = line
        const recorded = reportProblem(raw, at, { kind: 'orchestrator' }, {
          text: `The checks on ${config.base} failed for ${line}. Nothing merges onto a red ${config.base} but its repair.`,
          severity: 'blocker',
        })
        const text = `Run board: the checks on ${config.base} failed for ${line}. ${recorded.isError ? '' : recorded.text}`.trimEnd()

        return { isChanged: true, isError: false, text, wake: text, asks: `main ${line}` }
      })

      return
    }
    // Green: the watch is over.
    await mutate($, path, raw => ({ value: delete raw.main, isChanged: true }))
  } catch {
    // A look that failed is tried again on the next one.
  } finally {
    isWatchingMain = false
  }
}

/** `/pause` and `/unpause`: the owner's hold on the bound run, written to its ledger, and the orchestrator told. */
async function hold($: EngineInterface, isPausing: boolean): Promise<{ text: string }> {
  const path = await boundLedger($)
  if (path === undefined) return { text: await unbound($) }
  const at = iso(await $.clock.now())
  const written = await mutate($, path, raw => {
    const outcome = isPausing ? pauseRun(raw, at) : unpauseRun(raw)

    return { value: outcome, isChanged: outcome.isChanged }
  })
  if (written.error !== undefined) return { text: written.error }
  // A working orchestrator reads it with its next tool result; an idle one is woken with it.
  if (!written.value.isError) carry(written.value)
  seen = undefined
  await refresh($, false)

  return { text: written.value.text }
}

/** Keeps the engine's reason for refusing a compaction, and says it once. Never throws. */
async function notCompacted($: EngineInterface, reason: string, now: number): Promise<void> {
  try {
    const path = await boundLedger($)
    if (path === undefined || now === 0) return
    await mutate($, path, raw => ({ value: undefined, isChanged: heldUp(raw, iso(now), reason) }))
    if (heldFor === reason) return
    heldFor = reason
    seen = undefined
    $.ui.toast(`Run board: a compaction is due and did not go through (${reason}). The mod tries again; /compact works too.`)
  } catch {
    // Not kept this time: the next try keeps it.
  }
}

/** During a long turn of the orchestrator: once its context is full enough, it is told to end the turn. Never throws. */
async function nudge($: EngineInterface): Promise<void> {
  const percent = await gaugeNow($)
  if (percent === undefined || percent < ROTATE_AT || isNudged) return
  // A finished run's session is not compacted, so its orchestrator is not told that it will be.
  try {
    const path = await boundLedger($)
    const ledger = path === undefined ? undefined : parseLedger(await $.fs.read(path)).ledger
    if (ledger === undefined || ledger.tasks.every(task => task.status === 'done')) return
  } catch {
    return
  }
  isNudged = true
  const text = `Run board: your context is ${Math.round(percent)}% full. Finish the step you are on and end your turn: the mod then compacts this conversation and brings the run's state back from the ledger. First put what the board does not hold yet (a decision, where a task stands) into a task note or a ruling.`
  inbox.set(ORCHESTRATOR, [...(inbox.get(ORCHESTRATOR) ?? []), { taskId: ORCHESTRATOR, text }])
}

type Answered = { status: number; text: string; error?: undefined } | { error: string }

/** One request through the host. Never throws: an address that cannot be asked answers `error`, which is no verdict. */
async function ask(
  $: EngineInterface,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Answered> {
  try {
    // A clock that cannot wait only means there is no limit: it never counts as the address not answering.
    const limit = $.clock.sleep(ASK_TIMEOUT_MS).then(
      () => undefined,
      () => new Promise<undefined>(() => undefined),
    )
    const answered = await Promise.race([$.http.fetch(url, init), limit])

    return answered === undefined ? { error: `no answer within ${ASK_TIMEOUT_MS / 1000} s` } : { status: answered.status, text: answered.text }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}

const NO_TOKEN = "there is no GitHub token: set the mod's GitHub token option, export GH_TOKEN or GITHUB_TOKEN, or sign in with gh auth login"

/**
 * The token a request to GitHub carries, from the first place that has one:
 * the mod's own option (kept in the system's secure storage), GH_TOKEN,
 * GITHUB_TOKEN, then `gh auth token`. It goes into a request's header and
 * nowhere else: not the ledger, not a message.
 */
async function githubToken($: EngineInterface): Promise<string | undefined> {
  if (config.token !== '') return config.token
  try {
    const fromEnv = (await $.env.get('GH_TOKEN')) ?? (await $.env.get('GITHUB_TOKEN'))
    if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  } catch {
    // No environment to read: gh may still have a token.
  }
  if (ghToken !== undefined) return ghToken
  // Requests made at once share one question to gh, so it runs once and not once for each of them.
  ghAsked ??= (async () => {
    try {
      const ran = await $.process.run(['gh', 'auth', 'token'], { timeoutMs: 10_000 })
      const token = ran.exitCode === 0 ? ran.stdout.trim() : ''
      if (token !== '') ghToken = token
    } catch {
      // No gh on this machine, or it could not run.
    }

    return ghToken
  })().finally(() => {
    ghAsked = undefined
  })

  return ghAsked
}

/** The headers of a request to GitHub; undefined when there is no token. */
async function githubHeaders($: EngineInterface): Promise<Record<string, string> | undefined> {
  const token = await githubToken($)

  return token === undefined
    ? undefined
    : {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'conductor-claude-code-mod',
        'Content-Type': 'application/json',
      }
}

type Json = { status: number; json: unknown; text: string; error?: undefined } | { error: string }

/** A request about this repository to GitHub, its answer read as JSON. Never throws. */
async function github($: EngineInterface, path: string, init?: { method?: string; body?: string }): Promise<Json> {
  const repo = repoHere()
  if (repo === undefined) return { error: 'this repository is not on GitHub' }
  const headers = await githubHeaders($)
  if (headers === undefined) return { error: NO_TOKEN }
  const answered = await ask($, `${API}/repos/${repo}${path}`, { ...init, headers })
  if (answered.error !== undefined) return { error: answered.error }
  // A token GitHub refuses is asked for again next time, in case gh has a newer one.
  if (answered.status === 401) ghToken = undefined
  try {
    return { status: answered.status, json: JSON.parse(answered.text) as unknown, text: answered.text }
  } catch {
    return answered.status >= 400 ? { status: answered.status, json: null, text: answered.text } : { error: `an answer that is not JSON (HTTP ${answered.status})` }
  }
}

const NO_LINEAR_KEY = "there is no Linear key: set the mod's Linear API key option, or export LINEAR_API_KEY"

/** The key a request to Linear carries: the mod's option, then LINEAR_API_KEY. It goes into the request's header and nowhere else. */
async function linearKey($: EngineInterface): Promise<string | undefined> {
  if (linearOption !== '') return linearOption
  const fromEnv = (await $.env.get('LINEAR_API_KEY').catch(() => undefined))?.trim()

  return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
}

/** One GraphQL request to Linear, its `data` or why there is none. Never throws, and never says the key. */
async function linear($: EngineInterface, query: string, variables: Record<string, unknown>): Promise<{ data: unknown; error?: undefined } | { error: string }> {
  const key = await linearKey($)
  if (key === undefined) return { error: NO_LINEAR_KEY }
  const answered = await ask($, LINEAR_API, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json', 'User-Agent': 'conductor-claude-code-mod' },
    body: JSON.stringify({ query, variables }),
  })
  const scrub = (text: string): string => text.split(key).join('[key]')
  if (answered.error !== undefined) return { error: scrub(answered.error) }
  let json: unknown
  try {
    json = JSON.parse(answered.text)
  } catch {
    return { error: `an answer that is not JSON (HTTP ${answered.status})` }
  }
  const errors = errorsOf(json)
  if (errors !== undefined) return { error: scrub(`${errors}${answered.status === 401 ? ' (HTTP 401: Linear did not take the key)' : ''}`) }
  if (answered.status >= 400) return { error: `HTTP ${answered.status}` }

  return { data: (json as { data?: unknown }).data }
}

/** Records, once for each reason, that Linear did not take a state change. Never throws. */
async function linearProblem($: EngineInterface, path: string, text: string, reason: string): Promise<void> {
  if (linearFailed === reason) return
  linearFailed = reason
  const at = iso(await $.clock.now())
  await mutate($, path, raw => {
    const outcome = reportProblem(raw, at, { kind: 'orchestrator' }, { text, severity: 'warning' })

    return { value: outcome, isChanged: outcome.isChanged }
  })
}

/**
 * Moves a Linear issue to its team's first state of a type: started when its
 * work starts, completed when it is merged. An issue that is there already,
 * or further on, stays. A failure never stops the run: it is recorded once as
 * a warning. Never throws.
 */
async function moveIssue($: EngineInterface, path: string, key: string, type: 'started' | 'completed'): Promise<void> {
  try {
    const fail = (reason: string) => linearProblem($, path, `Linear did not move ${key} to its ${type} state: ${reason}. The run goes on; later changes are not reported while this lasts.`, reason)
    const read = await linear($, Q_ISSUE, { id: key })
    if (read.error !== undefined) return await fail(read.error)
    const view = issueOf(read.data)
    if (view === undefined) return await fail(`Linear has no issue ${key}`)
    if (view.state.type === type || (type === 'started' && view.state.type === 'completed')) return
    const stateId = stateFor(view.team.states, type)
    if (stateId === undefined) return await fail(`team ${view.team.key} has no ${type} state`)
    const sent = await linear($, M_UPDATE, { id: view.id, input: { stateId } })
    if (sent.error !== undefined) return await fail(sent.error)
    if (!updatedOf(sent.data)) return await fail('Linear did not say the change went through')
    linearFailed = undefined
  } catch {
    // The run goes on whatever Linear does.
  }
}

/**
 * A task that is done moves its Linear issue to completed, when its ticket is
 * one. In a git run with its tickets in Linear, the run's own issue follows
 * once every task is done; a Lore run's moves when it reaches the base
 * branch. Never throws.
 */
async function issueDone($: EngineInterface, path: string, taskId: string): Promise<void> {
  try {
    const ledger = parseLedger(await $.fs.read(path)).ledger
    const ticket = ledger?.tasks.find(one => one.id === taskId)?.ticket
    if (typeof ticket === 'string') await moveIssue($, path, ticket, 'completed')
    if (ledger === undefined || ledger.run.tickets !== 'linear' || ledger.run.lore !== undefined) return
    if (!ledger.tasks.every(one => one.status === 'done')) return
    const issue = ledger.run.issue ?? (LINEAR_KEY.test(ledger.run.source ?? '') ? ledger.run.source : undefined)
    if (issue !== undefined && issue !== ticket) await moveIssue($, path, issue, 'completed')
  } catch {
    // Nothing to move.
  }
}

/**
 * After the owner approved a Linear run's plan: a run from a spec gets its own
 * issue in the project's team, filed now, and the run's issue moves to
 * started. Never throws, and never holds up the approval.
 */
async function linearApproved($: EngineInterface, path: string): Promise<void> {
  try {
    const ledger = parseLedger(await $.fs.read(path)).ledger
    if (ledger === undefined || ledger.run.tickets !== 'linear') return
    let key = ledger.run.issue ?? (LINEAR_KEY.test(ledger.run.source ?? '') ? ledger.run.source : undefined)
    if (key === undefined) {
      const teamKey = ledger.run.config?.linear?.team
      const fail = (reason: string) =>
        linearProblem($, path, `Linear did not file this run's own issue in team ${teamKey ?? '(none)'}: ${reason}. File it by hand, then give its key with task_update on a task, or set the run's issue.`, reason)
      if (teamKey === undefined) return await fail('the project config names no linear.team')
      const team = await linear($, Q_TEAM, { key: teamKey })
      if (team.error !== undefined) return await fail(team.error)
      const found = teamOf(team.data)
      if (found === undefined) return await fail(`Linear has no team ${teamKey}`)
      const made = await linear($, M_CREATE, { input: { teamId: found.id, title: ledger.run.title, description: `Spec: ${ledger.run.source ?? ''}` } })
      if (made.error !== undefined) return await fail(made.error)
      const created = createdOf(made.data)
      if (created === undefined) return await fail('Linear did not say which issue it made')
      key = created.key
      const filed = created.key
      await mutate($, path, raw => {
        ;(raw.run as Record<string, unknown>).issue = filed

        return { value: undefined, isChanged: true }
      })
    }
    await moveIssue($, path, key, 'started')
  } catch {
    // The approval stands whatever Linear does.
  }
}

/** `ticket_read`: an issue in Linear, as the orchestrator reads it. */
async function ticketRead($: EngineInterface, call: ToolCall) {
  const fail = (reason: string) => ({ isError: true as const, result: `${NOT_DONE} ${reason}`, text: `${NOT_DONE} ${reason}` })
  const key = call.key
  if (typeof key !== 'string' || !LINEAR_KEY.test(key)) return fail('key is a Linear issue key, like ABC-12.')
  const read = await linear($, Q_ISSUE, { id: key })
  if (read.error !== undefined) return fail(`Linear could not be read: ${read.error}.`)
  const view = issueOf(read.data)
  if (view === undefined) return fail(`Linear has no issue ${key}.`)
  const text = issueText(view)

  return { result: text, text }
}

/** `ticket_file`: the orchestrator files a drafted ticket as a sub-issue of the run's issue, after the owner approved the plan. */
async function ticketFile($: EngineInterface, call: ToolCall) {
  const fail = (reason: string) => ({ isError: true as const, result: `${NOT_DONE} ${reason}`, text: `${NOT_DONE} ${reason}` })
  const path = await boundLedger($)
  if (path === undefined) return fail(NOT_BOUND)
  if (callerOf(call.agentId).kind !== 'orchestrator') return fail('Only the orchestrator files a ticket.')
  const { title, description, task } = call
  if (typeof title !== 'string' || title.trim() === '') return fail('Give the ticket a title.')
  if (description !== undefined && typeof description !== 'string') return fail('description is text.')
  const ledger = parseLedger(await $.fs.read(path)).ledger
  if (ledger === undefined) return fail('The ledger does not read.')
  if (ledger.run.plan !== 'approved' && ledger.run.plan !== undefined) {
    return fail('The plan is not approved yet: drafted tickets are filed only after the owner approves the plan with /approve.')
  }
  if (task !== undefined && !ledger.tasks.some(one => one.id === task)) return fail(`There is no task ${String(task)} in this run.`)
  const parent = ledger.run.issue ?? (LINEAR_KEY.test(ledger.run.source ?? '') ? ledger.run.source : undefined)
  if (parent === undefined) return fail("This run has no Linear issue of its own to file under. It is filed when the owner approves the plan of a Linear run.")
  const read = await linear($, Q_ISSUE, { id: parent })
  if (read.error !== undefined) return fail(`Linear could not be read: ${read.error}.`)
  const view = issueOf(read.data)
  if (view === undefined) return fail(`Linear has no issue ${parent}.`)
  const made = await linear($, M_CREATE, { input: { teamId: view.team.id, title: title.trim(), description: (description ?? '').trim(), parentId: view.id } })
  if (made.error !== undefined) return fail(`Linear did not file it: ${made.error}.`)
  const created = createdOf(made.data)
  if (created === undefined) return fail('Linear did not say which issue it made.')
  if (typeof task === 'string') {
    await mutate($, path, raw => {
      const found = raw.tasks.find(one => one.id === task)
      if (found !== undefined) found.ticket = created.key

      return { value: undefined, isChanged: found !== undefined }
    })
    seen = undefined
  }
  const text = `Filed ${created.key} under ${parent}: ${created.url}.${typeof task === 'string' ? ` ${task} carries it.` : ''}`

  return { result: text, text }
}

/** Whether this project's tickets may be in Linear: its config says so, or a Linear key is set. */
async function wantsLinear($: EngineInterface): Promise<boolean> {
  if ((await linearKey($)) !== undefined) return true
  if (root === undefined || root === null) return false
  const read = parseConfig(await textAt($, `${root}/${CONFIG_PATH}`))

  return 'config' in read && read.config.tickets === 'linear'
}

/** A commit's checks, check runs and commit statuses both, and their verdict. */
async function checksAt($: EngineInterface, sha: string): Promise<Verdict | { error: string }> {
  const [runs, status] = await Promise.all([github($, `/commits/${sha}/check-runs?per_page=100`), github($, `/commits/${sha}/status?per_page=100`)])
  if (runs.error !== undefined) return { error: runs.error }
  if (status.error !== undefined) return { error: status.error }
  const read = runs.status === 200 && status.status === 200 ? checksOf(runs.json, status.json) : undefined
  if (read === undefined) return { error: `the checks of ${short(sha)} could not be read (HTTP ${runs.status} and ${status.status})` }

  return judge(read)
}

/** The base branch's head and the verdict of its checks. */
async function lookAtBase($: EngineInterface): Promise<Look> {
  const branch = await github($, `/branches/${encodeURIComponent(config.base)}`)
  if (branch.error !== undefined) return { error: branch.error }
  const head = branch.status === 200 ? headOf(branch.json) : undefined
  if (head === undefined) return { error: `the head of ${config.base} could not be read (HTTP ${branch.status})` }
  const verdict = await checksAt($, head)
  if ('error' in verdict) return { error: verdict.error }

  return { head, verdict }
}

/** What GitHub says about a pull request and about the base branch, right now. */
async function survey($: EngineInterface, pr: number): Promise<{ facts: Facts; error?: undefined } | { error: string }> {
  const [pulled, base] = await Promise.all([github($, `/pulls/${pr}`), lookAtBase($)])
  if (pulled.error !== undefined) return { error: pulled.error }
  if (pulled.status === 404) return { error: `it knows no pull request ${pr} in ${repoHere() ?? 'this repository'}` }
  const pull = pulled.status === 200 ? pullOf(pulled.json) : undefined
  if (pull === undefined) return { error: `pull request ${pr} could not be read (HTTP ${pulled.status})` }
  if ('error' in base) return { error: base.error }
  // A merged pull request's own checks decide nothing any more.
  const checks: Verdict | { error: string } = pull.isMerged ? { verdict: 'green', line: 'merged', failed: [] } : await checksAt($, pull.head)
  if ('error' in checks) return { error: checks.error }

  return { facts: { pull, checks, base: config.base, baseHead: base.head, main: base.verdict } }
}

/** The merges other runs of this repository have in flight. Never throws: a run that does not read is no reason to refuse. */
async function flights($: EngineInterface, own: string, now: number): Promise<Flight[]> {
  if (typeof root !== 'string') return []
  const runs = `${root}/${RUNS_DIR}`
  const ledgers: Ledger[] = []
  try {
    for (const entry of await $.fs.list(runs)) {
      if (entry.kind !== 'dir' || !RUN_ID.test(entry.name)) continue
      try {
        const parsed = parseLedger(await $.fs.read(`${runs}/${entry.name}/ledger.json`))
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
async function settle($: EngineInterface, path: string, change: (raw: Raw) => Outcome): Promise<Outcome | undefined> {
  const written = await mutate($, path, raw => {
    const outcome = change(raw)

    return { value: outcome, isChanged: outcome.isChanged }
  })
  // The pane shows it at once, not at its next poll.
  seen = undefined
  await refresh($, false)
  if (written.error !== undefined || written.value.isError) return undefined
  carry(written.value)

  return written.value
}

/** The origins of a command that are the owner's own hand: the terminal, the desktop app, the owner's Remote Control. */
const OWNER_ORIGINS: ReadonlySet<string> = new Set(['composer', 'sdk', 'bridge'])

/** What a run's Lore side is, read for its base-branch commands; or why there is none. */
async function loreRunOf($: EngineInterface): Promise<{ path: string; ledger: Ledger; runLore: NonNullable<Ledger['run']['lore']>; run: string } | { text: string }> {
  const path = await boundLedger($)
  if (path === undefined) return { text: await unbound($) }
  const ledger = parseLedger((await textAt($, path)) ?? '').ledger
  if (ledger === undefined) return { text: 'The ledger does not read.' }
  const runLore = ledger.run.lore
  if (runLore?.workspace === undefined) return { text: 'This run has no Lore workspace yet: it is made when the owner approves the plan with /approve.' }

  return { path, ledger, runLore, run: runLore.workspace }
}

/**
 * `/approve-main`: the owner approves the run branch's revision for the base
 * branch, and the mod merges exactly that revision into the protected base,
 * protecting it again whatever happens. Refused while anything stands in the
 * way, when the run branch moved, or when the base moved since the run branch
 * last took it in.
 */
async function approveMain($: EngineInterface, origin: string): Promise<string> {
  if (!OWNER_ORIGINS.has(origin)) return 'Not done. /approve-main is the owner\'s: only the owner types it, in the terminal, the desktop app or Remote Control. Nothing was merged.'
  const found = await loreRunOf($)
  if ('text' in found) return found.text
  const { path, ledger, runLore, run } = found
  const base = runLore.base
  const head = branchInfoOf((await lore($, ['branch', 'info', runLore.branch], run)).out)?.remoteLatest
  const baseNow = branchInfoOf((await lore($, ['branch', 'info', base], run)).out)?.remoteLatest
  if (head === undefined || baseNow === undefined) return `Nothing was merged: lore did not say where ${head === undefined ? runLore.branch : base} stands on the server.`
  const blocks = readyForBase(ledger, head)
  if (blocks.length > 0) return [`The run cannot go into ${base} yet:`, ...blocks.map(one => `- ${one}`)].join('\n')
  if (baseNow !== runLore.baseAt) {
    return `Nothing was merged: ${base} moved since the run branch last took it in (it is at ${rev7(baseNow)}; the run branch took in ${runLore.baseAt === undefined ? 'no revision of it on record' : rev7(runLore.baseAt)}). Merging into it now would land a result nobody approved. Ask the orchestrator to bring it in with mcp__conductor__run_sync_base, then approve again.`
  }
  const at = iso(await $.clock.now())
  const claimed = await mutate($, path, raw => {
    approvedMain(raw, at, { revision: head, base: baseNow })
    const outcome = startLoreMerge(raw, at, { task: ledger.run.id, revision: head, target: 'base' })

    return { value: outcome, isChanged: true }
  })
  if (claimed.error !== undefined) return `Nothing was merged: ${claimed.error}`
  if (claimed.value.isError) return `Nothing was merged: ${claimed.value.text}`
  const giveUp = async (why: string): Promise<string> => (await settle($, path, raw => letGo(raw, why)))?.text ?? `Nothing was merged: ${why}.`
  const synced = await lore($, ['branch', 'switch', runLore.branch, '--reset'], run, LONG_MS)
  const status = statusOf((await lore($, ['status'], run)).out)
  if (synced.exitCode !== 0 || status === undefined) return giveUp(`the run's workspace could not be brought to ${runLore.branch}`)
  if (status.revision !== head) return giveUp(`${runLore.branch} moved after the approval (it is at ${rev7(status.revision)}, ${rev7(head)} was approved): approve again`)
  const unprotected = await lore($, ['branch', 'unprotect', base], run)
  if (unprotected.exitCode !== 0) return giveUp(`${base} could not be unprotected for the merge: ${lastLine(unprotected)}`)
  let outcome: ReturnType<typeof mergeOf> = { kind: 'failed', reason: 'it did not run' }
  let protectedAgain: Ran | undefined
  try {
    const merged = await lore($, ['branch', 'merge', 'into', base, `Run ${ledger.run.id}: ${ledger.run.title}`], run, LONG_MS)
    outcome = mergeOf(merged.exitCode, merged.out)
  } finally {
    // Whatever the merge did, the base branch is protected again.
    protectedAgain = await lore($, ['branch', 'protect', base], run)
  }
  let protectLine = ''
  if (protectedAgain.exitCode !== 0) {
    protectLine = ` ${base} could not be protected again (${lastLine(protectedAgain)}): it is a blocker on the board. Protect it by hand with lore branch protect ${base}.`
    const failedAt = iso(await $.clock.now())
    await mutate($, path, raw => {
      const outcome2 = reportProblem(raw, failedAt, { kind: 'orchestrator' }, { text: `${base} is not protected: lore branch protect ${base} failed after the run's merge (${lastLine(protectedAgain!)}). Protect it by hand.`, severity: 'blocker' })

      return { value: outcome2, isChanged: outcome2.isChanged }
    })
  }
  if (outcome.kind !== 'merged') return `${await giveUp(`lore did not merge it into ${base}: ${outcome.kind === 'conflict' ? `conflicts in ${outcome.files.join(', ')}` : outcome.reason}`)}${protectLine}`
  const landed = outcome.revision
  const done = await settle($, path, raw => onBase(raw, at, landed, base))
  const issue = ledger.run.issue ?? (LINEAR_KEY.test(ledger.run.source ?? '') ? ledger.run.source : undefined)
  if (issue !== undefined) await moveIssue($, path, issue, 'completed')
  const notArchived: string[] = []
  for (const one of ledger.tasks) {
    if (one.branch === undefined) continue
    const archived = await lore($, ['branch', 'archive', taskBranchOf(runLore.branch, one.id)], run)
    if (archived.exitCode !== 0) notArchived.push(one.id)
  }
  const kept: string[] = []
  for (const folder of [...ledger.tasks.flatMap(one => (one.workspace === undefined ? [] : [one.workspace])), run]) {
    const scanned = statusOf((await lore($, ['status', '--scan'], folder, LONG_MS)).out)
    const here = await backendOf($)
    if (scanned?.isClean === true && scanned.isInSync && here !== null && isInside(workspacesOf(here.root, ledger.run.config?.lore?.workspaces), folder)) await runProgram($, ['rm', '-rf', '--', folder], LONG_MS)
    else kept.push(folder)
  }
  const tail = [
    notArchived.length === 0 ? "Its tasks' branches are archived." : `The branches of ${notArchived.join(', ')} could not be archived.`,
    kept.length === 0 ? 'Its workspaces are removed.' : `Kept, with changes not pushed: ${kept.join(', ')}.`,
  ].join(' ')

  return `${done?.text ?? `Merged: run ${ledger.run.id} is on ${base} as ${rev7(landed)}.`} ${tail}${protectLine}`
}

/** `run_sync_base`: the orchestrator has the mod bring the base branch into the run branch, so the run can be approved again. */
async function runSyncBase($: EngineInterface, call: ToolCall): Promise<{ result: string; text: string; isError?: true }> {
  const fail = (reason: string) => ({ isError: true as const, result: `${NOT_DONE} ${reason}`, text: `${NOT_DONE} ${reason}` })
  const say = (text: string) => ({ result: text, text })
  if (callerOf(call.agentId).kind !== 'orchestrator') return fail('Only the orchestrator brings the base branch in.')
  const found = await loreRunOf($)
  if ('text' in found) return fail(found.text)
  const { path, ledger, runLore, run } = found
  const base = runLore.base
  if (ledger.merge !== undefined) return fail(`${ledger.merge.task} is still merging: one merge at a time.`)
  const baseNow = branchInfoOf((await lore($, ['branch', 'info', base], run)).out)?.remoteLatest
  if (baseNow === undefined) return fail(`lore did not say where ${base} stands on the server.`)
  const synced = await lore($, ['branch', 'switch', runLore.branch, '--reset'], run, LONG_MS)
  if (synced.exitCode !== 0) return fail(`the run's workspace could not be brought to ${runLore.branch}: ${lastLine(synced)}.`)
  const runHead = branchInfoOf((await lore($, ['branch', 'info', runLore.branch], run)).out)?.remoteLatest
  const merged = await lore($, ['branch', 'merge', base, `--message=Bring ${base} into ${runLore.branch}`], run, LONG_MS)
  const outcome = mergeOf(merged.exitCode, merged.out)
  const at = iso(await $.clock.now())
  if (outcome.kind === 'conflict') {
    await lore($, ['branch', 'merge', 'abort'], run, LONG_MS)
    const files = outcome.files.join(', ') || 'files lore did not name'
    await mutate($, path, raw => {
      const reported = reportProblem(raw, at, { kind: 'orchestrator' }, { text: `Bringing ${base} into ${runLore.branch} conflicts in: ${files}. Give it a task that resolves it on the run branch, then call run_sync_base again.`, severity: 'blocker' })

      return { value: reported, isChanged: reported.isChanged }
    })

    return fail(`${base} conflicts with ${runLore.branch} in: ${files}. Nothing was merged; it is a blocker on the board.`)
  }
  if (outcome.kind === 'failed') {
    await lore($, ['branch', 'merge', 'abort'], run, LONG_MS)

    return fail(`lore did not bring ${base} in: ${outcome.reason}.`)
  }
  if (outcome.source !== undefined && outcome.source !== baseNow) {
    if (runHead !== undefined) await lore($, ['branch', 'reset', runHead, '--branch', runLore.branch], run)
    await lore($, ['branch', 'switch', runLore.branch, '--reset'], run, LONG_MS)

    return fail(`${base} moved while it was brought in. Nothing was pushed: call run_sync_base again.`)
  }
  const sent = await lore($, ['push'], run, LONG_MS)
  const result = pushOf(sent.exitCode, sent.out)
  if (result.kind === 'refused') return fail(`the run branch could not be pushed: ${result.text}.`)
  const written = await settle($, path, raw => baseBroughtIn(raw, baseNow))
  if (written === undefined) return fail('the board could not be written.')
  const landed = result.kind === 'pushed' ? rev7(result.revision) : rev7(outcome.revision)

  return say(`Brought ${base} into ${runLore.branch} as ${landed}. A new approval is needed: tell the owner what changed and ask them to type /approve-main.`)
}

/**
 * `merge` and `merge_check` in a Lore run: a judged task's branch into the
 * run branch, pinned to the revision its worker handed back, one at a time,
 * in the run's own workspace. `merge_check` stops before the claim and
 * changes nothing.
 */
async function loreMergeTool($: EngineInterface, call: ToolCall, isCheckOnly: boolean): Promise<{ result: string; text: string; isError?: true }> {
  const fail = (reason: string) => ({ isError: true as const, result: `${NOT_DONE} ${reason}`, text: `${NOT_DONE} ${reason}` })
  const say = (text: string) => ({ result: text, text })
  const path = await boundLedger($)
  if (path === undefined) return fail(NOT_BOUND)
  await remember($, path)
  const ledger = parseLedger((await textAt($, path)) ?? '').ledger
  if (ledger === undefined) return fail('The ledger does not read.')
  const runLore = ledger.run.lore
  if (runLore?.workspace === undefined) return fail('This run has no Lore workspace yet: it is made when the owner approves the plan with /approve.')
  const run = runLore.workspace
  const now = await $.clock.now()
  const asked = loreReady(ledger, callerOf(call.agentId), call, await flights($, ledger.run.id, now))
  if ('error' in asked) return fail(asked.error)
  const { task, revision } = asked
  const id = task.id
  // The branch is the one the mod named: never a name written on the task, which reaches lore as an argument.
  const branch = taskBranchOf(runLore.branch, id)
  const blocks = [...asked.blocks]
  const head = branchInfoOf((await lore($, ['branch', 'info', branch], run)).out)?.remoteLatest
  if (head === undefined) blocks.push(`lore did not say where ${branch} stands on the server.`)
  else if (head !== revision) blocks.push(`${branch} moved since it was judged: it is at ${rev7(head)}, and ${rev7(revision)} was judged. Judge it again.`)
  if (blocks.length > 0) return isCheckOnly ? say([`${id} cannot merge yet:`, ...blocks.map(one => `- ${one}`)].join('\n')) : fail([`${id} cannot merge yet:`, ...blocks.map(one => `- ${one}`)].join('\n'))
  if (isCheckOnly) return say(`${id} may merge now: its branch ${branch} is at ${rev7(revision)}, as it was judged. It merges into ${runLore.branch}.`)

  const at = iso(now)
  const claimed = await mutate($, path, raw => {
    const outcome = startLoreMerge(raw, at, { task: id, revision, target: 'run' })

    return { value: outcome, isChanged: outcome.isChanged }
  })
  if (claimed.error !== undefined) return fail(claimed.error)
  if (claimed.value.isError) return fail(claimed.value.text)
  const giveUp = async (why: string) => {
    const outcome = await settle($, path, raw => letGo(raw, why))

    return fail(outcome?.text ?? `${id} was not merged: ${why}.`)
  }
  const synced = await lore($, ['branch', 'switch', runLore.branch, '--reset'], run, LONG_MS)
  if (synced.exitCode !== 0) return giveUp(`the run's workspace could not be brought to ${runLore.branch}: ${lastLine(synced)}`)
  const runHead = branchInfoOf((await lore($, ['branch', 'info', runLore.branch], run)).out)?.remoteLatest
  if (runHead === undefined) return giveUp(`lore did not say where ${runLore.branch} stands on the server`)
  const merged = await lore($, ['branch', 'merge', branch, `--message=${id}: ${task.title}`], run, LONG_MS)
  const outcome = mergeOf(merged.exitCode, merged.out)
  // Lore merges a branch's latest: one pushed between the look above and the merge is not the judged revision.
  if (outcome.kind === 'merged' && outcome.source !== revision) {
    await lore($, ['branch', 'reset', runHead, '--branch', runLore.branch], run)
    await lore($, ['branch', 'switch', runLore.branch, '--reset'], run, LONG_MS)
    const took = outcome.source === undefined ? 'a revision lore did not name' : rev7(outcome.source)

    return giveUp(`lore took in ${took}, not the judged ${rev7(revision)}: the branch moved meanwhile. Nothing was pushed; judge it again`)
  }
  if (outcome.kind === 'conflict') {
    await lore($, ['branch', 'merge', 'abort'], run, LONG_MS)
    const said = await settle($, path, raw => conflicted(raw, at, id, outcome.files))

    return fail(said?.text ?? `${id} conflicts with the run branch; nothing was merged.`)
  }
  if (outcome.kind === 'failed') {
    await lore($, ['branch', 'merge', 'abort'], run, LONG_MS)

    return giveUp(`lore did not merge it: ${outcome.reason}`)
  }
  const pushed = await lore($, ['push'], run, LONG_MS)
  const sent = pushOf(pushed.exitCode, pushed.out)
  if (sent.kind !== 'pushed') return giveUp(`the merge could not be pushed: ${sent.kind === 'refused' ? sent.text : 'lore pushed nothing'}`)
  // Its locks are let go, and its workspace removed when everything in it is in Lore.
  await lore($, ['lock', 'release', '--branch', branch], run)
  let workspaceLine = ''
  if (task.workspace !== undefined) {
    const scanned = await lore($, ['status', '--scan'], task.workspace, LONG_MS)
    const status = statusOf(scanned.out)
    if (status?.isClean === true && status.isInSync && isInside(workspacesOf((await backendOf($))?.root ?? '', ledger.run.config?.lore?.workspaces), task.workspace)) {
      await runProgram($, ['rm', '-rf', '--', task.workspace], LONG_MS)
      workspaceLine = 'Its workspace is removed: everything in it is in Lore.'
    } else {
      workspaceLine = `Its workspace is kept at ${task.workspace}: ${status === undefined ? 'lore could not read it' : 'it holds changes that are not pushed'}. Look at it before you remove it.`
    }
  }
  const removed = workspaceLine.startsWith('Its workspace is removed')
  const done = await settle($, path, raw => {
    const result = onRunBranch(raw, iso(now), id, sent.revision, runLore.branch, workspaceLine)
    const kept = raw.tasks.find(one => one.id === id)
    if (removed && kept !== undefined) delete kept.workspace

    return result
  })
  isolated.delete(id)
  workspaces.delete(id)
  await issueDone($, path, id)

  return say(done?.text ?? `Merged: ${id} is on ${runLore.branch} as ${rev7(sent.revision)}, but the board could not be written.`)
}

/**
 * `merge` and `merge_check`: the one way a pull request of a run reaches the
 * base branch. The board's own side first, then GitHub's facts read just now,
 * then the claim, then the merge pinned to the head those facts graded.
 * `merge_check` stops before the claim and changes nothing.
 */
async function mergeTool(
  $: EngineInterface,
  call: ToolCall,
  isCheckOnly: boolean,
): Promise<{ result: string; text: string; isError?: undefined } | { isError: true; result: string; text: string }> {
  const say = (text: string) => ({ result: text, text })
  const fail = (reason: string) => {
    const text = `${NOT_DONE} ${reason}`

    return { isError: true as const, result: text, text }
  }
  const path = await boundLedger($)
  if (path === undefined) return fail(NOT_BOUND)
  // Before anything is asked of GitHub: a pull request's number means something only in a repository on GitHub.
  if ((await backendOf($))?.kind === 'lore') return loreMergeTool($, call, isCheckOnly)
  if (!(await isAtForge($))) return fail(elsewhere(origin))
  await remember($, path)
  let ledger: Ledger
  try {
    const parsed = parseLedger(await $.fs.read(path))
    if (parsed.ledger === undefined) return fail(`The ledger does not read: ${parsed.error}.`)
    ledger = parsed.ledger
  } catch {
    return fail(`There is no ledger at ${path}.`)
  }
  const now = await $.clock.now()
  const asked = precheck(ledger, callerOf(call.agentId), call, await flights($, ledger.run.id, now), isCheckOnly)
  if ('error' in asked) return fail(asked.error)
  const surveyed = await survey($, asked.pr)
  if (surveyed.error !== undefined) {
    return fail(`GitHub did not say what a merge needs to know (${surveyed.error}). Nothing was merged. A request that failed is no verdict: try again.`)
  }
  const { facts } = surveyed
  const { pull } = facts
  const id = asked.task.id

  // Merged outside the board: nothing to merge, and the task is done.
  if (pull.isMerged) {
    const where = pull.commit === undefined ? '' : ` as ${short(pull.commit)}`
    if (isCheckOnly) return say(`PR ${asked.pr} is merged already${where}, outside the board. ${TOOL_MERGE} takes it over and marks ${id} done.`)
    const adopted = await settle($, path, raw => onMain(raw, iso(now), pull.commit ?? pull.head, config.base, { isAdopted: true, task: id, pr: asked.pr }))
    if (adopted !== undefined) await issueDone($, path, id)

    return adopted === undefined ? fail(`${id} could not be taken over: the board could not be written.`) : say(adopted.text)
  }

  const blocks = obstacles(facts, asked)
  if (isCheckOnly) {
    if (blocks.length > 0) return say(`${id} cannot merge yet:\n${blocks.map(one => `- ${one}`).join('\n')}`)

    return say(
      `${id} may merge now. PR ${asked.pr} is open and mergeable into ${config.base}, its checks are green on ${short(pull.head)} (${facts.checks.line}), the checks on ${config.base} are ${facts.main.verdict} for ${short(facts.baseHead)}, and ${closingLine(closes(`${pull.title}\n${pull.body}`))}. GitHub would merge it with its ${config.method} method. Before you call ${TOOL_MERGE}: tell the other sessions that may merge (ListAgents shows them) and name them in told.`,
    )
  }
  if (blocks.length > 0) return fail(`Nothing was merged. ${id} cannot merge now:\n${blocks.map(one => `- ${one}`).join('\n')}`)

  const claimed = await mutate($, path, raw => {
    const outcome = startMerge(raw, iso(now), { task: id, pr: asked.pr, head: pull.head, told: asked.told, closes: asked.closes })

    return { value: outcome, isChanged: outcome.isChanged }
  })
  seen = undefined
  await refresh($, false)
  if (claimed.error !== undefined) return fail(`Nothing was merged. ${claimed.error}`)
  if (claimed.value.isError) return fail(`Nothing was merged. ${claimed.value.text}`)

  // The merge itself: pinned, so GitHub refuses it if the head moved since it was graded.
  const sent = await github($, `/pulls/${asked.pr}/merge`, { method: 'PUT', body: JSON.stringify({ sha: pull.head, merge_method: config.method }) })
  const said = sent.error === undefined ? messageOf(sent.text) : ''
  const answer = sent.error !== undefined ? sent.error : `HTTP ${sent.status}${said === '' ? '' : `: ${said}`}`
  // Whatever the call answered, the pull request itself says whether it is merged.
  const after = await github($, `/pulls/${asked.pr}`)
  const now2 = iso(await $.clock.now())
  const settled = after.error !== undefined || after.status !== 200 ? undefined : pullOf(after.json)
  if (settled?.isMerged === true) {
    const commit = settled.commit ?? pull.head
    const done = await settle($, path, raw => onMain(raw, now2, commit, config.base))
    if (done !== undefined) await issueDone($, path, id)

    return say(done?.text ?? `Merged: PR ${asked.pr} (${id}) is on ${config.base} as ${short(commit)}, but the board could not be written. Set it right with ${TOOL_MERGE} for ${id} again: it is taken over.`)
  }
  if (settled !== undefined) {
    await mutate($, path, raw => {
      const outcome = abandoned(raw, `GitHub answered ${answer}`)

      return { value: outcome, isChanged: outcome.isChanged }
    })
    seen = undefined
    await refresh($, false)

    return fail(`Nothing was merged: GitHub did not merge PR ${asked.pr} (${answer}). The claim is let go and ${id} stands where it stood. If its head moved, have it graded again.`)
  }

  return say(`Not known yet. The merge call for PR ${asked.pr} went out (${answer}), but GitHub could not be asked afterwards whether it merged. The board keeps ${id} as merging, looks again within a few minutes and settles it either way. Merge nothing meanwhile.`)
}

/**
 * A merge claim whose call never said how it ended (the session stopped in
 * between, or GitHub could not be asked afterwards): the pull request says.
 * Called from the timer; never throws.
 */
async function watchClaim($: EngineInterface): Promise<void> {
  if (isWatching) return
  isWatching = true
  try {
    const path = await boundLedger($)
    if (path === undefined) return
    const flight = parseLedger(await $.fs.read(path)).ledger?.merge
    if (flight === undefined) return
    // A claim in a repository whose origin is not on GitHub is none the board made: nothing of it is asked there.
    if (!(await isAtForge($))) return
    const now = await $.clock.now()
    if (now - Date.parse(flight.startedAt) < CLAIM_GRACE_MIN * 60_000) return
    const pulled = await github($, `/pulls/${flight.pr}`)
    const pull = pulled.error !== undefined || pulled.status !== 200 ? undefined : pullOf(pulled.json)
    if (pull === undefined) return
    const at = iso(now)
    if (pull.isMerged) {
      // Nobody heard the merge tool's answer: the orchestrator is told now, and woken if it is idle.
      await settle($, path, raw => {
        const done = onMain(raw, at, pull.commit ?? flight.head, config.base)

        return done.isError ? done : { ...done, wake: `Run board: PR ${flight.pr} (${flight.task}) is merged as ${short(pull.commit ?? flight.head)}, and the task is done.`, asks: `merge ${flight.task}` }
      })
      await issueDone($, path, flight.task)
    } else await settle($, path, raw => abandoned(raw, 'the merge call did not go through'))
  } catch {
    // A look that failed is tried again on the next one.
  } finally {
    isWatching = false
  }
}

/** Writes what the workers were last seen doing and which files they changed; never throws. */
async function flush($: EngineInterface): Promise<void> {
  if (pending.size === 0 && changedFiles.size === 0 && handed.length === 0 && weights.size === 0) return
  const batch = [...pending]
  const files = [...changedFiles].map(([taskId, set]) => [taskId, [...set]] as const)
  const read = handed.splice(0)
  const heavy = [...weights]
  pending.clear()
  changedFiles.clear()
  weights.clear()
  try {
    const path = await boundLedger($)
    if (path === undefined) return
    const at = iso(await $.clock.now())
    const written = await mutate($, path, raw => {
      const isActed = batch.map(([taskId, text]) => acted(raw, taskId, { at, text })).some(Boolean)
      const touched = files.map(([taskId, list]) => touch(raw, at, taskId, list))
      const isRead = markRead(raw, read)
      const isWeighed = heavy.map(([taskId, tokens]) => weigh(raw, taskId, tokens)).some(Boolean)
      // A worker past the run's limit is asked, once, to hand back at its next green step.
      const asks = heavy
        .filter(([taskId]) => !askedBack.has(taskId))
        .map(([taskId, tokens]) => overweight(raw, taskId, tokens))
        .filter(one => one !== undefined)

      return { value: { touched, asks }, isChanged: isActed || isRead || isWeighed || touched.some(one => one.isChanged) }
    })
    for (const outcome of written.value?.touched ?? []) carry(outcome)
    for (const ask of written.value?.asks ?? []) {
      askedBack.add(ask.taskId)
      carry({ isChanged: false, isError: false, text: '', deliveries: [ask] })
    }
  } catch {
    // A sign of life that could not be written is replaced by the next one.
  }
}

async function newestRun($: EngineInterface, runs: string): Promise<string | null> {
  let newest: { id: string; mtimeMs: number } | undefined
  try {
    for (const entry of await $.fs.list(runs)) {
      if (entry.kind !== 'dir' || !RUN_ID.test(entry.name)) continue
      try {
        const { mtimeMs } = await $.fs.stat(`${runs}/${entry.name}/ledger.json`)
        if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { id: entry.name, mtimeMs }
      } catch {
        // A run folder without a ledger yet is not a run to show.
      }
    }
  } catch {
    return null
  }

  return newest?.id ?? null
}

/** Writes what the pane shows, and only when it differs from what it shows now. */
async function show(
  $: EngineInterface,
  stamp: string,
  next: (previous: BoardState) => BoardState,
): Promise<void> {
  if (stamp === shown) return
  await update($, board, next)
  shown = stamp
}

/** Reads the ledger of the run on show when its file changed; never throws. */
async function refresh($: EngineInterface, rescan: boolean): Promise<void> {
  try {
    if (root === undefined || rescan) root = await rootOf($, rescan)
    if (root === null) {
      const error = 'This session is not inside a git repository or a Lore workspace, so there is no run folder to read.'

      return await show($, `no-repo`, () => ({ runId: null, ledger: null, error }))
    }
    const runs = `${root}/${RUNS_DIR}`
    const pinned = await read($, pinnedRun)
    if (pinned === null && (followed === null || rescan)) followed = await newestRun($, runs)
    const runId = pinned ?? followed
    if (runId === null) return await show($, 'no-run', () => EMPTY)

    const path = `${runs}/${runId}/ledger.json`
    const keep = (error: string) => (previous: BoardState) =>
      previous.runId === runId ? { ...previous, error } : { runId, ledger: null, error }
    let mtimeMs: number
    try {
      mtimeMs = (await $.fs.stat(path)).mtimeMs
    } catch {
      seen = undefined

      return await show($, `missing ${path}`, keep(`There is no ledger at ${path}.`))
    }
    if (seen?.path === path && seen.mtimeMs === mtimeMs) return

    const parsed = parseLedger(await $.fs.read(path))
    if (parsed.error !== undefined) {
      // Not remembered: a file caught half written is read again on the next tick.
      seen = undefined

      return await show($, `refused ${path} ${parsed.error}`, keep(parsed.error))
    }
    seen = { path, mtimeMs }
    const { ledger } = parsed
    if (pinned !== null) learn(ledger, path)
    await show($, `read ${path} ${mtimeMs}`, () => ({ runId, ledger, error: null, updatedMs: mtimeMs }))
  } catch (cause) {
    const error = `The ledger could not be read: ${cause instanceof Error ? cause.message : String(cause)}`
    await show($, error, previous => ({ ...previous, error })).catch(() => undefined)
  }
}

async function tick($: EngineInterface): Promise<void> {
  if (isTicking) return
  isTicking = true
  try {
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (!isUp) return
    ticks += 1
    await refresh($, ticks % RESCAN_EVERY === 0)
    if (ticks % CLOCK_EVERY === 0) {
      const now = await $.clock.now()
      await update($, nowMs, () => now)
    }
  } catch {
    // A tick that failed is tried again on the next one.
  } finally {
    isTicking = false
  }
}

const because = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * Registers a command. A name the engine will not take (it keeps some for
 * itself, `/run` among them, measured 2026-10-09) is noted and said once, and
 * holds up nothing else: before this, one refused name ended the mod's start
 * and with it every later command, tool and both timers.
 */
async function listCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<void> {
  try {
    await $.command.register(spec)
  } catch (cause) {
    unlisted.push(`/${spec.name} (${because(cause)})`)
  }
}

async function listTool($: EngineInterface, spec: Parameters<EngineInterface['tool']['register']>[0]): Promise<void> {
  try {
    await $.tool.register(spec)
  } catch (cause) {
    unlisted.push(`${spec.name} (${because(cause)})`)
  }
}

/**
 * The mod works only in a repository that opted in with a `.claude/conductor`
 * folder. Anywhere else it registers nothing and its hooks pass everything on.
 */
async function isHome($: EngineInterface): Promise<boolean> {
  try {
    if (root === undefined) root = await rootOf($)

    return root !== null && (await $.fs.exists(`${root}/.claude/conductor`))
  } catch {
    return false
  }
}

export const register: Register = (on, options) => {
  config = configOf(options)
  const given = (options as Record<string, unknown> | undefined)?.loreBin
  loreOption = typeof given === 'string' && given.trim() !== '' ? given.trim() : undefined
  linearOption = apiKeyOf(options)
  on('session.start', async ($, e, next) => {
    if (!(await isHome($))) return next(e)
    // The timers first: whatever a registration below runs into, the board stays live.
    $.clock.every(POLL_MS, () => void tick($))
    $.clock.every(FLUSH_MS, () => {
      flushTicks += 1
      wake($)
      void flush($)
      void rotation($)
      if (flushTicks % WATCH_EVERY === 0) {
        void watchClaim($)
        void watchMain($)
        void lookAgain($)
      }
      if (isOrchestrating === true && flushTicks % GAUGE_EVERY === 0) void nudge($)
    })
    unlisted.length = 0
    await listCommand($, {
      name: 'board',
      description: 'Show the run board: what is building, next, done, and the problems found',
      argumentHint: '[run id]',
    })
    await listTool($, {
      name: 'task_update',
      description:
        'Run board: say where a task of the run this session is bound to stands. The orchestrator may set any status, and may change the tier of a task that has not started (with tierReason). A task\'s own worker may set review (its pull request is open), blocked (it waits on a ruling) or failed, and may set note, pr and branch. The board is written only through these tools: never edit ledger.json.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task\'s id, e.g. t391-1.' },
          status: { type: 'string', enum: [...STATUSES] },
          tier: { type: 'string', enum: [...TIERS], description: 'Only before the task starts, and only by the orchestrator.' },
          tierReason: { type: 'string', description: 'One line: why this tier. Required with tier.' },
          note: { type: 'string', description: 'One line: what it is doing now, or why it is blocked. An empty string clears it.' },
          ticket: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: TICKET_PATTERN }], description: 'The issue it belongs to, a GitHub number or a Linear key like ABC-12; the orchestrator\'s to set.' },
          pr: { type: 'integer', minimum: 1, description: 'The pull request\'s number.' },
          branch: { type: 'string' },
          revision: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'In Lore: the revision its branch was pushed at, which the merge is pinned to.' },
        },
        required: ['task'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await listTool($, {
      name: 'task_add',
      description:
        'Run board: the orchestrator adds a task to the run, tagged with the model tier its worker runs on: opus for architecture and design, sonnet for challenging development, haiku for easy jobs. Its worker is then started with the task\'s id as the agent\'s name, and the mod sets the model from the tier. A task added to deal with open problems names them in addresses, so they have a task.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'A short name unique in the run, e.g. t391-2: letters, digits, _ and -.' },
          title: { type: 'string', description: 'What the task delivers, in a few words.' },
          tier: { type: 'string', enum: [...TIERS] },
          tierReason: { type: 'string', description: 'One line: why this tier.' },
          ticket: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: TICKET_PATTERN }], description: 'The issue it belongs to: a GitHub number or a Linear key like ABC-12.' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks that must be done first.' },
          files: { type: 'array', items: { type: 'string' }, description: 'The files or folders the task is expected to change, relative to the repository. Findings on them reach its worker, and a second task on the same file is flagged.' },
          addresses: { type: 'array', items: { type: 'string' }, description: 'The ids of open problems this task is to deal with, e.g. ["P3"]: each then has this task, and is resolved once it is done and the fix holds.' },
        },
        required: ['id', 'title', 'tier', 'tierReason'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await listTool($, {
      name: 'board_post',
      description:
        'Run board: tell the run something. kind finding is a fact other workers may need; name the files or folders it concerns and the workers on those files read it at their next step, and nobody else does. kind question is a worker\'s question to the orchestrator, who is woken to answer it.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['finding', 'question'] },
          text: { type: 'string', description: 'One to three sentences.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files or folders it concerns, relative to the repository.' },
        },
        required: ['kind', 'text'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await listTool($, {
      name: 'board_rule',
      description:
        'Run board: the orchestrator records a numbered ruling for the workers it binds. answers names the question it settles; tasks names the tasks it binds; a ruling that names nobody is for the workers building now. A running worker reads it at its next step. A stopped worker reads it when it runs again: the mod starts nobody, so send that worker a message yourself to start it.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What is decided, in one to three sentences.' },
          answers: { type: 'string', description: 'The question it answers, e.g. Q2.' },
          tasks: { type: 'array', items: { type: 'string' }, description: 'The ids of the tasks it binds.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await listTool($, {
      name: 'board_read',
      description:
        'Run board: what the board holds for you. A worker gets the rulings that bind it and the findings on its files. The orchestrator gets the whole run as a handover has it: every task with its worker, the open problems and questions, the rulings.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    await listCommand($, {
      name: 'conduct',
      description: 'Start a run from an issue or a spec: its board, its ledger, and a plan the orchestrator drafts for your approval',
      argumentHint: '<#issue or spec path> [title]',
    })
    await listCommand($, { name: 'approve', description: 'Approve the plan of the bound run, so its workers may start' })
    await listTool($, {
      name: 'run_plan',
      description:
        'Run board: the orchestrator says the plan of the run is ready for the owner, and names the run. After it, tell the owner the plan in a few lines and stop: they approve with /approve, and no worker starts before that.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What the run delivers, in a few words.' },
        },
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await listTool($, {
      name: 'merge_check',
      description:
        'Run board: what stands in the way of merging a task\'s pull request right now, read from GitHub: its state and mergeability, its checks on its head, the checks on the base branch, and what its description would close. Changes nothing and merges nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task\'s id.' },
          closes: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'The issues this merge is meant to close; leave out for none.' },
          onRedMain: { type: 'boolean', description: 'Only for the pull request that repairs failed checks on the base branch.' },
        },
        required: ['task'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await listTool($, {
      name: 'merge',
      description:
        'Run board: the orchestrator merges a green task\'s pull request into the base branch on GitHub. The mod checks everything merge_check checks and merges pinned to the head whose checks it read, never two at once; the task is done once GitHub has merged it, and the board then watches the checks on the base branch. A pull request already merged by hand is taken over. Tell the other sessions that may merge first, and name them in told.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task\'s id.' },
          told: {
            type: 'array',
            items: { type: 'string' },
            description: 'The sessions you told just now that you are about to merge (ListAgents shows who may merge); an empty list says there is nobody else.',
          },
          closes: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'The issues this merge is meant to close; leave out for none.' },
          onRedMain: { type: 'boolean', description: 'Only for the pull request that repairs failed checks on the base branch.' },
        },
        required: ['task', 'told'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await listCommand($, { name: 'pause', description: 'Hold the bound run: no worker starts and nothing is merged until /unpause; what is under way finishes' })
    await listCommand($, { name: 'unpause', description: 'End the pause of the bound run: workers may start and pull requests may merge again' })
    await listCommand($, {
      name: 'merged',
      description: 'Mark a task of the bound run done by your word: its pull request is merged',
      argumentHint: '<task id>',
    })
    await listCommand($, {
      name: 'rotate',
      description: 'Write the bound run\'s handover and compact this session now, whatever its context reading',
    })
    await listCommand($, {
      name: 'tier',
      description: 'Set the model tier of a task of the bound run that has not started',
      argumentHint: '<task id> <opus|sonnet|haiku>',
    })
    await listTool($, {
      name: 'problem_report',
      description:
        'Run board: record a problem found during the run, so the person watching the board sees it. severity is blocker (it stops a task), warning (it may bite later) or note (for the record). A worker\'s report is filed under its own task, and the orchestrator is told of a blocker or a warning: it gives the problem a task and sees it through.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What is wrong, in one or two sentences.' },
          severity: { type: 'string', enum: ['blocker', 'warning', 'note'] },
          task: { type: 'string', description: 'The task it concerns, when it concerns one.' },
        },
        required: ['text', 'severity'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await listTool($, {
      name: 'problem_resolve',
      description:
        'Run board: the orchestrator marks a recorded problem resolved and says how it was settled. A problem whose task is still going is refused: it is resolved once that task is done and you have checked that the fix holds.',
      inputSchema: {
        type: 'object',
        properties: {
          problem: { type: 'string', description: 'The problem\'s id, e.g. P3.' },
          resolution: { type: 'string', description: 'How it was settled, in one line.' },
          dismiss: {
            type: 'boolean',
            description: 'Only for a problem that turned out to be none while the task that was to deal with it is still going.',
          },
        },
        required: ['problem', 'resolution'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await listTool($, {
      name: 'problem_assign',
      description:
        'Run board: the orchestrator ties an open problem to the task of this run that deals with it, by the task\'s id or by the ticket it carries. Only a task that still goes on counts, and a ticket only while a task of this run carries it: a problem is not left with something nobody here conducts. For a problem that needs work of its own, add a task with task_add and addresses instead.',
      inputSchema: {
        type: 'object',
        properties: {
          problem: { type: 'string', description: 'The problem\'s id, e.g. P3.' },
          task: { type: 'string', description: 'The id of a task of this run that is not done.' },
          ticket: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: TICKET_PATTERN }], description: 'The issue\'s number or Linear key, when one task of this run still carries it.' },
        },
        required: ['problem'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    if ((await backendOf($))?.kind === 'lore') {
      await listCommand($, {
        name: 'approve-main',
        description: 'Approve the run branch for the base branch: the mod merges exactly its revision now, and protects the base again',
      })
      await listTool($, {
        name: 'run_sync_base',
        description:
          "Run board: the orchestrator has the mod bring the base branch into the run branch, when it moved since the run branch last took it in. A conflict is a blocker on the board. Afterwards the owner approves again with /approve-main.",
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        isDeferred: false,
      })
    }
    if (await wantsLinear($)) {
      await listTool($, {
        name: 'ticket_read',
        description: 'Run board: read an issue in Linear by its key: its title, state, description, sub-issues and last comments.',
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string', pattern: TICKET_PATTERN, description: 'The issue\'s key, e.g. ABC-12.' } },
          required: ['key'],
          additionalProperties: false,
        },
        isDeferred: false,
      })
      await listTool($, {
        name: 'ticket_file',
        description:
          "Run board: the orchestrator files a drafted ticket in Linear as a sub-issue of the run's issue, once the owner approved the plan. With task, that task carries the new key.",
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The ticket\'s title.' },
            description: { type: 'string', description: 'The ticket\'s description, in Markdown; link the spec it comes from.' },
            task: { type: 'string', description: 'The id of the task the ticket is for.' },
          },
          required: ['title'],
          additionalProperties: false,
        },
        isDeferred: false,
      })
    }
    if (unlisted.length > 0) {
      void Promise.resolve($.ui.toast(`Run board: the engine did not take ${unlisted.join('; ')}. Everything else of the mod works.`)).catch(() => undefined)
    }
    await rebind($)
    const path = await boundLedger($).catch(() => undefined)
    if (path !== undefined) await remember($, path)
    // A reload forgets the last reading of the context: taken again here, so a compaction that was due stays due.
    if (path !== undefined) void gaugeNow($)

    return next(e)
  })

  // The router. In a bound session a new agent is a task's worker (started on the
  // task's tier, whatever the call asked for), a worker's own subagent (never on a
  // dearer tier than the worker) or a read-only helper; anything else is refused.
  // A session bound to no run, a fork, a teammate and a workflow's agent are left alone.
  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.isTeammate === true || e.workflow !== undefined) return next(e)
    let path: string | undefined
    try {
      path = await boundLedger($)
    } catch {
      path = undefined
    }
    if (path === undefined) return next(e)

    routing.add(e.tool_use_id)
    await remember($, path)
    const parentTaskId = e.parentAgentId === undefined ? undefined : agents.get(e.parentAgentId)
    if (e.parentAgentId !== undefined && parentTaskId === undefined) {
      // Started by a helper or an agent the board does not know: not the router's.
      routing.delete(e.tool_use_id)

      return next(e)
    }
    let source: string
    try {
      source = await $.fs.read(path)
    } catch {
      routing.delete(e.tool_use_id)

      return { deny: `conductor: the run this session is bound to has no ledger at ${path}, so no agent was started. /board none lets go of the run.` }
    }
    const read = parseLedger(source)
    if (read.ledger === undefined) {
      routing.delete(e.tool_use_id)

      return { deny: `conductor: the bound run's ledger does not read (${read.error}), so no agent was started.` }
    }
    const spawn: Spawn = { name: e.name, model: e.model, subagentType: e.subagentType, parentTaskId }
    let decided = route(read.ledger, spawn)
    let before: RawTask | undefined
    if (decided.kind === 'worker') {
      const claimed = await claim($, path, spawn, e.name ?? decided.taskId, read.ledger)
      if (claimed.error !== undefined) {
        routing.delete(e.tool_use_id)

        return { deny: `conductor: the board could not be written (${claimed.error}), so no agent was started.` }
      }
      decided = claimed.decided
      before = claimed.before
    }
    routing.delete(e.tool_use_id)
    if (decided.kind === 'deny') return { deny: decided.text }
    if (decided.kind === 'pass') return next(e)
    const reservation = before
    const release = async (): Promise<void> => {
      if (reservation !== undefined) await mutate($, path, raw => ({ value: undefined, isChanged: released(raw, reservation) }))
    }
    // In Lore a worker builds in a workspace of its own, made now, before the engine starts it.
    let unlock: (() => void) | undefined
    const here = await backendOf($)
    const runLore = read.ledger.run.lore
    if (decided.kind === 'worker' && here?.kind === 'lore' && runLore !== undefined) {
      unlock = await exclusive()
      const project = read.ledger.run.config
      const taskId = decided.taskId
      const workspacesBase = workspacesOf(here.root, project?.lore?.workspaces)
      const workspace = workspaceOf(workspacesBase, read.ledger.run.id, taskId)
      const isThere = await $.fs.exists(`${workspace}/.lore`).catch(() => false)
      const made = isThere
        ? { path: workspace }
        : await prepareWorkspace($, {
            root: here.root,
            base: workspacesBase,
            path: workspace,
            branch: taskBranchOf(runLore.branch, taskId),
            from: decided.base?.branch ?? runLore.branch,
            carry: project?.lore?.carry ?? LORE_DEFAULTS.carry,
            minFreeGB: project?.lore?.minFreeGB ?? LORE_DEFAULTS.minFreeGB,
            runId: read.ledger.run.id,
            taskId,
          })
      if (made.error !== undefined) {
        unlock()
        await release()

        return { deny: `conductor: ${taskId}'s Lore workspace could not be made, so no worker was started: ${made.error}.` }
      }
      prepared.set(taskId, workspace)
      awaitingWorktree.push({ taskId, path: workspace })
    }
    const finished = (): void => {
      const waiting = awaitingWorktree.findIndex(one => decided.kind === 'worker' && one.taskId === decided.taskId)
      if (waiting >= 0) awaitingWorktree.splice(waiting, 1)
      unlock?.()
    }
    try {
      // A worker also starts knowing how it reports and what the board already holds for it.
      const task = decided.kind === 'worker' ? read.ledger.tasks.find(one => one.id === decided.taskId) : undefined
      // The project's own rules for a worker, when it keeps any: .claude/conductor/brief.md of the repository.
      const brief = task === undefined ? '' : await $.fs.read(path.replace(/runs\/[^/]+\/ledger\.json$/, 'brief.md')).catch(() => '')
      const prompt =
        task === undefined || decided.kind !== 'worker'
          ? e.prompt
          : `${e.prompt}\n${briefing(read.ledger, task, { brief, slot: decided.slot }, decided.base)}`
      let started: Awaited<ReturnType<typeof next>>
      try {
        started = await next({ ...e, model: decided.model, prompt })
      } finally {
        finished()
      }
      // The engine started nothing after all: the task stands again as it stood.
      if ((started as { agentId?: string }).agentId === undefined) await release()
      else await heard($, path, e.name ?? decided.taskId, decided, started)

      return started
    } catch (cause) {
      await release()
      throw cause
    }
  }).catch(unrouted)

  // Outside git, Claude Code asks for a worker's isolated copy here. In a Lore run the mod made it already;
  // in git the mod answers nothing and the engine makes its own worktree, as it does unhooked.
  on('classic.WorktreeCreate', async ($, e, next) => {
    try {
      const here = await backendOf($)
      if (here?.kind !== 'lore') return {}
      // The engine names the workspace after the agent: a worker it started already is found by its id, else it is the start in flight.
      const agentId = /^agent-(.+)$/.exec(e.name)?.[1]
      let taskId = agentId === undefined ? undefined : agents.get(agentId)
      let workspace = taskId === undefined ? undefined : prepared.get(taskId)
      if (workspace === undefined) {
        const head = awaitingWorktree.shift()
        taskId = head?.taskId
        workspace = head?.path
        if (agentId !== undefined && taskId !== undefined) agents.set(agentId, taskId)
      } else {
        const waiting = awaitingWorktree.findIndex(one => one.taskId === taskId)
        if (waiting >= 0) awaitingWorktree.splice(waiting, 1)
      }
      // Nothing of this run's: the project's own WorktreeCreate hook says why the engine cannot make one here.
      if (taskId === undefined || workspace === undefined) return next(e)
      prepared.delete(taskId)
      const path = await boundLedger($)
      if (path !== undefined) {
        const forTask = taskId
        const handed = workspace
        await mutate($, path, raw => {
          const task = raw.tasks.find(one => one.id === forTask)
          const runLore = (raw.run as { lore?: { branch?: unknown } }).lore
          if (task === undefined) return { value: undefined, isChanged: false }
          task.workspace = handed
          if (typeof runLore?.branch === 'string') task.branch = taskBranchOf(runLore.branch, forTask)

          return { value: undefined, isChanged: true }
        })
      }
      isolated.add(taskId)
      workspaces.set(taskId, workspace)

      return { worktreePath: workspace }
    } catch {
      return {}
    }
  })

  // What a worker is doing, from its own tool calls: remembered here, written by the flush.
  // And the way board news reaches its reader: with the result of the reader's own call.
  on('tool.call', async ($, e, next) => {
    const call = e as unknown as ToolCall
    // In a run nothing reaches the base branch by hand: not a worker's command, and not the orchestrator's either.
    if (call.tool === 'Bash' && typeof call.command === 'string') {
      const what = byHand(call.command, config.base)
      const isBound = what !== undefined && (await boundLedger($).catch(() => undefined)) !== undefined
      // A worker never merges, anywhere. The orchestrator's own merge is refused where the board merges: in a
      // repository that is not on GitHub it merges nothing, so there this is the repository's path, not a way round.
      if (what !== undefined && isBound && (call.agentId !== undefined || (await isAtForge($)))) {
        return {
          deny:
            call.agentId === undefined
              ? `conductor: this command ${what} by hand. In a run a pull request reaches ${config.base} through ${TOOL_MERGE}, which merges pinned to the graded head, one at a time. ${TOOL_CHECK} says what stands in the way. /board none lets go of the run.`
              : `conductor: this command ${what}. A worker never merges and never pushes to ${config.base}: set your task to review with its pull request and hand back. Merging is the orchestrator's.`,
        }
      }
    }
    const taskId = call.agentId === undefined ? undefined : agents.get(call.agentId)
    // A Lore worker that was not handed a workspace of its own would build in the owner's: it may not write at all.
    if (taskId !== undefined && (WRITES.has(call.tool) || call.tool === 'Bash') && !isolated.has(taskId) && (await backendOf($))?.kind === 'lore') {
      const path = await boundLedger($).catch(() => undefined)
      const ledger = path === undefined ? undefined : parseLedger(await textAt($, path) ?? '').ledger
      const task = ledger?.tasks.find(one => one.id === taskId)
      if (ledger?.run.lore !== undefined && task !== undefined) {
        if (task.workspace !== undefined) {
          isolated.add(taskId)
          workspaces.set(taskId, task.workspace)
        } else {
          return {
            deny: `conductor: ${taskId}'s worker has no Lore workspace of its own, so it would change the owner's workspace. It was started without isolation: "worktree". Stop and hand back; the orchestrator starts it again with isolation: "worktree".`,
          }
        }
      }
    }
    if (taskId !== undefined && !call.tool.startsWith('mcp__conductor__')) {
      pending.set(taskId, activityText(call))
      const file = call.file_path ?? call.notebook_path
      if (WRITES.has(call.tool) && typeof file === 'string' && typeof root === 'string') {
        const set = changedFiles.get(taskId) ?? new Set<string>()
        changedFiles.set(taskId, set.add(relative(file, root, workspaces.get(taskId))))
      }
    }
    const ran = await next(e)
    if (inbox.size === 0) return ran
    // A worker's subagent is not its reader: the news is for the loop that holds the task.
    const reader = call.agentId === undefined ? ORCHESTRATOR : workers.has(call.agentId) ? agents.get(call.agentId) : undefined

    return reader === undefined ? ran : hand(reader, ran)
  })

  // Whether the orchestrator is working: a question reaches a working orchestrator with its next
  // tool result, and wakes an idle one.
  on('turn.start', ($, e, next) => {
    if ((e as { agentId?: string }).agentId === undefined) isOrchestrating = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined) {
      isOrchestrating = false
      // The orchestrator's turn is over: this is when its context is read, and the timer acts on the reading.
      await gaugeNow($)
    }
    if (agentId !== undefined && workers.has(agentId)) {
      try {
        await flush($)
        const path = await boundLedger($)
        if (path !== undefined) {
          const at = iso(await $.clock.now())
          await mutate($, path, raw => ({ value: undefined, isChanged: turnEnded(raw, at, agentId, e.reason) !== undefined }))
        }
      } catch {
        // The turn ends whether or not the board heard of it.
      }
    }

    return next(e)
  })

  // The mod's own tools: the one way the orchestrator and the workers change the board.
  // Matched by pattern: a tool's own name is no known tool to the types until the mod that registers it has loaded.
  on('tool.call', { tool: /^mcp__conductor__run_plan$/ }, ($, e) =>
    answer($, e as unknown as ToolCall, (raw, _at, caller, input) => proposePlan(raw, caller, input)),
  ).catch(broke)
  on('tool.call', { tool: /^mcp__conductor__task_add$/ }, ($, e) =>
    answer($, e as unknown as ToolCall, (raw, _at, caller, input) => addTask(raw, caller, input)),
  ).catch(broke)
  on('tool.call', { tool: /^mcp__conductor__board_post$/ }, ($, e) => answer($, e as unknown as ToolCall, post)).catch(broke)
  on('tool.call', { tool: /^mcp__conductor__board_rule$/ }, ($, e) => answer($, e as unknown as ToolCall, rule)).catch(broke)
  on('tool.call', { tool: /^mcp__conductor__board_read$/ }, async ($, e) => {
    const isElsewhere = !(await isAtForge($))

    return answer($, e as unknown as ToolCall, (raw, at, caller) => {
      const read = parseLedger(JSON.stringify(raw))
      if (read.ledger === undefined) return { isChanged: false, isError: true, text: 'The ledger does not read.' }
      // The orchestrator reads the whole run, as a handover has it; a worker its own part of the board.
      const text =
        caller.kind === 'orchestrator'
          ? handover(read.ledger, { at, percent: lastPercent === undefined ? undefined : Math.round(lastPercent), isElsewhere })
          : digest(read.ledger, caller)

      return { isChanged: false, isError: false, text }
    })
  }).catch(broke)
  on('tool.call', { tool: /^mcp__conductor__task_update$/ }, ($, e) =>
    answer($, e as unknown as ToolCall, (raw, at, caller, input) => {
      const outcome = updateTask(raw, at, caller, input)
      if (outcome.isError || input.status !== 'green' || typeof input.task !== 'string') return outcome
      // A green task is what the tasks behind it were waiting for: said here, where the orchestrator reads it.
      const ledger = parseLedger(JSON.stringify(raw)).ledger
      const next = ledger === undefined ? [] : unlocked(ledger, input.task)
      if (next.length === 0) return outcome
      const names = next.map(one => (one.base === undefined ? one.id : `${one.id} (built on ${one.base.taskId}'s branch)`)).join(', ')
      if (ledger?.run.pausedAt !== undefined) return { ...outcome, text: `${outcome.text} The run is paused: once the owner types /unpause, these can start before this one is merged: ${names}.` }

      return { ...outcome, text: `${outcome.text} Can start now, before this one is merged: ${names}. Merge ${input.task} all the same as soon as nothing else is merging.` }
    }),
  ).catch(broke)
  on('tool.call', { tool: /^mcp__conductor__merge_check$/ }, ($, e) => mergeTool($, e as unknown as ToolCall, true)).catch(broke)
  on('tool.call', { tool: /^mcp__conductor__merge$/ }, ($, e) => mergeTool($, e as unknown as ToolCall, false)).catch(broke)
  on('tool.call', { tool: /^mcp__conductor__problem_report$/ }, ($, e) =>
    answer($, e as unknown as ToolCall, reportProblem),
  ).catch(broke)
  on('tool.call', { tool: /^mcp__conductor__problem_resolve$/ }, ($, e) =>
    answer($, e as unknown as ToolCall, (raw, _at, caller, input) => resolveProblem(raw, caller, input)),
  ).catch(broke)
  on('tool.call', { tool: /^mcp__conductor__run_sync_base$/ }, ($, e) => runSyncBase($, e as unknown as ToolCall)).catch(broke)
  on('tool.call', { tool: /^mcp__conductor__ticket_read$/ }, ($, e) => ticketRead($, e as unknown as ToolCall)).catch(broke)
  on('tool.call', { tool: /^mcp__conductor__ticket_file$/ }, ($, e) => ticketFile($, e as unknown as ToolCall)).catch(broke)
  on('tool.call', { tool: /^mcp__conductor__problem_assign$/ }, ($, e) =>
    answer($, e as unknown as ToolCall, (raw, _at, caller, input) => assignProblem(raw, caller, input)),
  ).catch(broke)

  // What the orchestrator has to know about a bound run. The text is the same
  // on every turn of a bound session, so it costs the prompt cache nothing.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const run = await read($, pinnedRun)
    if (run === null) return composed
    // GitHub's side of a run is told only where the repository is on GitHub; anywhere else, what stands in its place.
    const isHere = await isAtForge($)
    const text = [
      '# Run board (conductor)',
      '',
      `This session is bound to run \`${run}\`. Its board is the pane "Run board"; its ledger is ${RUNS_DIR}/${run}/ledger.json.`,
      '',
      REPORTING,
      `- The mod writes the ledger. Never edit ledger.json: change it with ${TOOL_ADD}, ${TOOL_UPDATE}, ${TOOL_REPORT} and ${TOOL_RESOLVE}.`,
      `- A run starts with a plan. Until you have proposed it with ${TOOL_PLAN} and the owner has approved it with /approve, no worker starts. Once they have, start the tasks that can start. ${PLANNING}`,
      `- Every worker is a task. Add it with ${TOOL_ADD}, tagged with a tier and why: opus for architecture and design, sonnet for challenging development, haiku for easy jobs. The owner may change a tier before the task starts; their choice stands.`,
      "- A task's worker is a background agent in a worktree of its own (isolation: \"worktree\"), started with the task's id as its `name` (or the name the task lists as its worker). The mod starts it on the task's tier whatever model the call names, marks the task building, records what the worker is doing from its tool calls, and marks it handed back when its turn ends.",
      `- A task starts once everything it waits for is green (reviewed, its checks green) or done: it does not wait for the merge. Start it then; the mod tells its worker to build on the green task's branch, which works for one unmerged branch at a time. ${isHere ? `${TOOL_MERGE} takes a task only after everything it waits for is done, so merge in that order.` : 'A task is merged only after everything it waits for is done, so merge in that order.'}`,
      `- A start is refused for an agent that is no task's worker, for a task that is done, already building or waiting on tasks that are not green yet, and when the run's limit of workers building at once is reached. Read-only helpers of type ${HELPER_TYPES.join(', ')} start without a task. A worker's own subagents never run on a dearer tier than the worker.`,
      '- The owner holds a run with /pause and lets it go on with /unpause. While it is paused the mod starts no worker and merges nothing; workers that are building finish and hand back, you judge their hand-backs and answer their questions, and a merge in flight is still settled with GitHub. When nothing is building any more, tell the owner in a line or two where the run stands, and stop. When the pause ends, read the board and go on: judge what was handed back, start what can start, and merge what is green, in order.',
      '- A task that is building while its worker is not running (the session was restarted meanwhile; ListAgents shows who runs) gets its worker started again with a message to the agent id the board lists: tell it first to run git status and git diff, and to commit and push what is its own.',
      '- After a hand-back the orchestrator judges it and sets the task to review, green, blocked or failed, or to done when it has no pull request.',
      ...(isHere
        ? [
            `- A task with a pull request becomes done through ${TOOL_MERGE} alone, for a task you judged green: its checks green on its head, its change reviewed. The mod reads GitHub, merges into ${config.base} pinned to that head with GitHub's ${config.method} method, never two at once (across runs too), marks the task done once GitHub has merged it and tells you. ${TOOL_CHECK} says what stands in the way and changes nothing. Before each merge tell the other sessions that may merge (ListAgents) and name them in told. Workers never merge, and a merge by hand (gh pr merge, GitHub's merge call, a push to ${config.base}) is refused in a bound session.`,
            `- When the board tells you a task is done, go on at once: start what can start and merge the next green task. After each merge the board watches the checks on ${config.base}: when they fail, find the merge that broke them and repair it before anything else merges; the repair's own merge takes onRedMain: true.`,
          ]
        : [
            `- This repository's origin is not on GitHub, so the mod reads no pull request and merges nothing here, and ${TOOL_MERGE} and ${TOOL_CHECK} refuse. The pull request of a task you judged green (its checks green on its head, its change reviewed) is merged by this repository's own path and rules, one at a time. A task with a pull request then becomes done on the owner's word alone: once it is merged and what this repository checks after a merge is good, tell the owner in one line to type /merged <task>. Workers never merge.`,
          ]),
      `- A problem anyone finds is recorded with ${TOOL_REPORT}, so it shows on the board. A blocker or a warning is yours until a task of this run has dealt with it. Look first whether it still holds (a precaution may not have come true, a fact may be none any more): if it does not, resolve it; if it does, give it a task of its own (${TOOL_ADD}, with addresses), or tie it to a task the run still conducts (${TOOL_ASSIGN}, by the task or by its ticket; a ticket counts only while a task of this run carries it, so a problem is never left with a ticket nobody here conducts). When its task is done, check that the fix holds and call ${TOOL_RESOLVE}; if it does not, give it a new task. A task that was given up leaves its problems without one. A note is for the record: resolve it when it no longer matters. Looking again is not left to you alone: the board asks you again every ${LOOK_AGAIN_MIN} minutes about one that nobody deals with, and a task is not merged while a problem found under it waits for that decision. A run with a blocker or a warning open is not delivered: say so in your summary to the owner instead of calling it finished.`,
      `- Workers do not report to you message by message. A fact another worker needs is a finding on the board (${TOOL_POST}) and is read only by the workers on the files it names. A worker's question wakes you: answer it with ${TOOL_RULE}, naming the question in answers. A running worker reads a ruling at its next step; a stopped one reads it when it runs again, and starting it is yours to do, with a message to that worker. ${TOOL_READ} shows the open questions and the latest findings and rulings. Board news for you arrives with the result of your own next tool call.`,
      `- When your context is about ${ROTATE_AT}% full, the mod compacts this conversation between your turns and brings the run's state back from the ledger; handover.md beside the ledger holds the same state. So keep what matters on the board (a task's note, a ruling) and not only in the conversation. ${TOOL_READ} gives you the whole run at any time.`,
      `- Name the files a task is expected to change when you add it. The mod sees which files each worker changes and tells you when two open tasks change the same one.`,
    ].join('\n')

    return { sections: [...composed.sections, { id: 'conductor:run', text, scope: 'session' as const }] }
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    // A run started from an issue is named by its number, so `/board #12` means run 12.
    const asked = e.args.trim().replace(/^#(?=\d+$)/, '')
    if (asked !== '' && !RUN_ID.test(asked)) {
      return { text: `"${asked}" is not a run id: letters, digits, _ and -, at most 64.` }
    }
    // A bare /board only shows the board; a run id binds the session to that run, `none` lets go of it.
    if (asked !== '') {
      await flush($)
      await bind($, asked === UNBIND ? null : asked)
    }
    const bound = await read($, pinnedRun)
    const now = await $.clock.now()
    await update($, nowMs, () => now)
    seen = undefined
    await refresh($, true)
    await $.ui.open({ id: PANE, title: TITLE })

    const state = await read($, board)
    if (state.ledger === null) {
      return { text: state.error ?? `No run yet: nothing under ${RUNS_DIR}.` }
    }
    const binding =
      bound === null
        ? `Viewing only: /board ${state.ledger.run.id} binds this session to the run, so its workers are recorded.`
        : `This session is bound to run ${bound}.`
    const line = `${state.ledger.run.title}: ${summary(boardView(state.ledger, now))}. ${binding}`

    return { text: state.error === null ? line : `${line} The newest read failed: ${state.error}` }
  })

  // A compaction of the main conversation in a bound session, whoever asked for it (the mod, the person
  // with /compact, the engine on its own): the summarizer is told to leave the run's state out, and the
  // state is added from the ledger. A worker's own compaction keeps its task and what the board holds for it.
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute') return next(e)
    let ledger: Ledger | undefined
    try {
      const path = await boundLedger($)
      ledger = path === undefined ? undefined : parseLedger(await $.fs.read(path)).ledger
    } catch {
      ledger = undefined
    }
    // A run with nothing left to do is left as it is: the summary is the session's own business again.
    if (ledger === undefined || ledger.tasks.every(task => task.status === 'done')) return next(e)

    if (e.agentId !== undefined) {
      const taskId = workers.has(e.agentId) ? agents.get(e.agentId) : undefined
      const task = ledger.tasks.find(one => one.id === taskId)
      const done = await next(e)
      if (task === undefined || done.skip !== undefined) return done

      return { ...done, messages: [...done.messages, { role: 'user' as const, text: briefing(ledger, task).trim(), toolUses: [] }] }
    }

    const at = iso(await $.clock.now())
    const text = handover(ledger, { at, percent: lastPercent === undefined ? undefined : Math.round(lastPercent), isElsewhere: !(await isAtForge($)) })
    const asked = e.instructions ?? ''
    const done = await next({ ...e, instructions: asked.includes(KEEP) ? asked : [asked, KEEP].filter(one => one !== '').join('\n\n') })
    if (done.skip !== undefined) return done
    isCarried = true

    return { ...done, messages: [...done.messages, { role: 'user' as const, text: carried(text), toolUses: [] }] }
  })

  // How many tokens a worker's context holds, from each of its model requests.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const taskId = e.agentId !== undefined && workers.has(e.agentId) ? agents.get(e.agentId) : undefined
    const usage = result?.usage
    if (taskId !== undefined && usage !== undefined && usage !== null) {
      weights.set(taskId, usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens)
    }

    return result
  })

  on('command.run', { command: 'conduct' }, async ($, e) => {
    const here = await backendOf($)
    if (here?.kind === 'lore' && here.problem !== undefined) return { text: `No run was started. ${here.problem}` }
    const asked = conducting(e.args)
    if ('error' in asked) return { text: asked.error }
    const { id, source, title } = asked
    if (id === UNBIND) return { text: `"${UNBIND}" is what /board takes to let go of a run, so no run can have that name: give another with id=<run id>.` }
    if (root === undefined) root = await rootOf($)
    if (root === null) return { text: 'This session is not inside a git repository or a Lore workspace, so there is nowhere to keep a run.' }
    // A spec that is not there is a mistyped path: said now, not after the orchestrator went looking for it.
    if (asked.kind === 'spec') {
      const isThere = (await $.fs.exists(source).catch(() => false)) || (!source.startsWith('/') && (await $.fs.exists(`${root}/${source}`).catch(() => false)))
      if (!isThere) return { text: `There is no file ${source} here, so there is nothing to start a run from. For an issue, give its number: /conduct #12.` }
    }
    const configText = await textAt($, `${root}/${CONFIG_PATH}`)
    const read = parseConfig(configText)
    if ('error' in read) return { text: `No run was started: ${read.error}` }
    const project = read.config
    const tickets = asked.kind === 'linear' || (asked.kind === 'spec' && project.tickets === 'linear') ? ('linear' as const) : undefined
    if (tickets === 'linear' && asked.kind === 'spec' && project.linear?.team === undefined) {
      return {
        text: 'No run was started. A run from a spec with its tickets in Linear files them in one team: set linear.team in .claude/conductor/config.json, for example {"linear": {"team": "ABC"}}.',
      }
    }
    let loreRun: Ledger['run']['lore']
    if (here?.kind === 'lore' && here.info !== undefined) {
      if (!runsIgnored(await textAt($, `${root}/.loreignore`))) {
        return {
          text: 'No run was started. The run ledgers are rewritten every few seconds and stay out of Lore: add the line .claude/conductor/runs/ to the .loreignore at the root of this workspace.',
        }
      }
      if (!hasPlaceholder([await textAt($, `${root}/.claude/settings.json`), await textAt($, `${root}/.claude/settings.local.json`)])) {
        return {
          text: `No run was started. Outside git, Claude Code lets the mod make each worker's Lore workspace only when the project declares a WorktreeCreate hook. Add this to .claude/settings.local.json (or .claude/settings.json), then give /conduct again; if a worker still cannot start, start a new session:\n\n${PLACEHOLDER_SNIPPET}`,
        }
      }
      loreRun = {
        remote: here.info.remote,
        repository: here.info.name,
        base: config.base,
        branch: runBranchOf(project.lore?.branchPrefix ?? LORE_DEFAULTS.branchPrefix, source, id, title),
      }
    }
    const path = ledgerPath(root, id)
    if (await $.fs.exists(path)) {
      return {
        text: `Run ${id} exists already: /board ${id} binds this session to it. For another run from the same ${asked.kind === 'spec' ? 'spec' : 'issue'}, give it a name of its own: /conduct ${source} id=<run id>.`,
      }
    }
    const now = await $.clock.now()
    const more = { tickets, config: configText === undefined ? undefined : project, lore: loreRun }
    await $.fs.write(path, `${JSON.stringify(newRun(id, source, iso(now), title, more), null, 2)}\n`)
    await flush($)
    await bind($, id)
    await update($, nowMs, () => now)
    seen = undefined
    await refresh($, true)
    await $.ui.open({ id: PANE, title: TITLE })
    asks.push(planning(id, source, title))

    return {
      text: `Run ${id} is started from ${source}${title === undefined ? '' : `, called "${title}"`}. The plan comes next; nothing starts before you /approve it.`,
    }
  })

  on('command.run', { command: 'approve' }, async $ => {
    const path = await boundLedger($)
    if (path === undefined) return { text: await unbound($) }
    const notReady = await loreApprove($, path)
    if (notReady !== undefined) return { text: `No plan was approved: ${notReady} Approve again once that is fixed.` }
    const written = await mutate($, path, raw => {
      const outcome = approvePlan(raw)

      return { value: outcome, isChanged: outcome.isChanged }
    })
    if (written.error !== undefined) return { text: written.error }
    if (!written.value.isError) {
      asks.push(APPROVED)
      await linearApproved($, path)
    }
    seen = undefined
    await refresh($, false)

    return { text: written.value.text }
  })

  on('command.run', { command: 'approve-main' }, async ($, e) => {
    const text = await approveMain($, e.origin.kind)
    seen = undefined
    await refresh($, false)

    return { text }
  })

  on('command.run', { command: 'pause' }, $ => hold($, true))
  on('command.run', { command: 'unpause' }, $ => hold($, false))

  on('command.run', { command: 'merged' }, async ($, e) => {
    const taskId = e.args.trim()
    if (taskId === '' || /\s/.test(taskId)) {
      return { text: 'Say which task: /merged <task id>. It marks the task done by your word that its pull request is merged.' }
    }
    const path = await boundLedger($)
    if (path === undefined) return { text: await unbound($) }
    const at = iso(await $.clock.now())
    const written = await mutate($, path, raw => {
      const outcome = ownerSaysMerged(raw, at, taskId)

      return { value: outcome, isChanged: outcome.isChanged }
    })
    seen = undefined
    await refresh($, false)
    // What hangs on the task the owner just closed reaches the orchestrator with its next tool result.
    if (written.error === undefined && !written.value.isError) carry(written.value)

    return { text: written.error ?? written.value.text }
  })

  on('command.run', { command: 'rotate' }, async $ => {
    if ((await boundLedger($)) === undefined) return { text: 'This session is bound to no run, so there is no handover to write: /board <run id> binds it.' }
    isRotateAsked = true

    return { text: 'Compaction asked for: it runs once no turn is running.' }
  })

  on('command.run', { command: 'tier' }, async ($, e) => {
    const [taskId, tier, ...rest] = e.args.trim().split(/\s+/)
    if (taskId === undefined || taskId === '' || tier === undefined || rest.length > 0) {
      return { text: `Say which task and which tier: /tier <task id> <${TIERS.join('|')}>.` }
    }

    return { text: await pick($, taskId, tier) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const state = await read($, board)
    const now = await read($, nowMs)
    const isViewOnly = (await read($, pinnedRun)) === null

    const heading = (label: string, count: number) => (
      <Text bold>
        {label} <Text dimColor>{String(count)}</Text>
      </Text>
    )
    const task = (row: TaskRow, color?: 'success' | 'error' | 'warning') => (
      <Box flexDirection="column">
        <Text wrap="truncate-end" color={color} dimColor={row.status === 'done'}>
          <Text bold>{row.id}</Text> {row.title}
        </Text>
        <Text wrap="truncate-end" dimColor>
          {'  '}
          {detail(row)}
        </Text>
      </Box>
    )
    const section = (
      label: string,
      rows: readonly TaskRow[],
      color?: 'success' | 'error' | 'warning',
      count = rows.length,
    ) =>
      rows.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {heading(label, count)}
          {rows.map(row => task(row, color ?? (row.status === 'green' ? 'success' : undefined)))}
        </Box>
      )

    if (state.ledger === null) {
      return (
        <Box flexDirection="column">
          <Text bold>No run to show</Text>
          <Text dimColor wrap="wrap">
            {state.error ?? `A run's ledger is read from ${RUNS_DIR}/<run id>/ledger.json.`}
          </Text>
        </Box>
      )
    }

    const view = boardView(state.ledger, now)
    const failure = state.error !== null && (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="error" wrap="wrap">
          Ledger not readable: {state.error}
        </Text>
        <Text dimColor>Showing the last good read.</Text>
      </Box>
    )

    const tzOffsetMin = -new Date().getTimezoneOffset()
    const updated = state.updatedMs === undefined ? undefined : clock(state.updatedMs, tzOffsetMin)

    // The owner's say on tiers, before dispatch: one picker per queued task of a bound run.
    const queued = isViewOnly ? [] : [...view.next, ...view.waiting]
    const pickers = (Select: Elements['desktop']['Select']) =>
      queued.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Tier before a task starts</Text>
          {queued.slice(0, PICKERS_SHOWN).map(row => (
            <Select
              key={`tier-${row.id}`}
              label={`${row.id} `}
              value={row.tier}
              options={TIER_OPTIONS}
              onSelect={value => void pick($, row.id, value).then(text => $.ui.toast(text))}
            />
          ))}
          {queued.length > PICKERS_SHOWN && (
            <Text dimColor>{`and ${queued.length - PICKERS_SHOWN} more: /tier <task id> <tier>`}</Text>
          )}
        </Box>
      )

    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const Select = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Select
      const picture = dashboardSvg(view, {
        width: Math.min(720, Math.max(260, e.props.bodyColumns * PX_PER_COLUMN)),
        timeline: timeline(state.ledger, now, tzOffsetMin),
        runMinutes: runMinutes(state.ledger, now),
        source: state.ledger.run.source,
        updated,
        isViewOnly,
      })

      return (
        <Box flexDirection="column">
          {failure}
          <Svg source={picture.source} alt={picture.alt} />
          {Select !== undefined && pickers(Select)}
        </Box>
      )
    }

    const earlier = view.done.length - DONE_SHOWN

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          {view.title}
        </Text>
        <Text dimColor wrap="wrap">
          {summary(view)}
        </Text>
        {state.error !== null && <Box marginTop={1} />}
        {failure}
        {view.problems.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {heading('PROBLEMS', view.problems.length)}
            {view.problems.map(one => (
              <Box flexDirection="column">
                <Text wrap="wrap" color={one.severity === 'blocker' ? 'error' : one.severity === 'warning' ? 'warning' : undefined}>
                  <Text bold>{one.id}</Text> {one.text}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {'  '}
                  {problemDetail(one)}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        {section('NEEDS A DECISION', view.attention, 'warning')}
        {view.questions.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {heading('QUESTIONS', view.questions.length)}
            {view.questions.map(one => (
              <Text wrap="wrap">
                <Text bold>{one.id}</Text> {one.text} <Text dimColor>{`(${one.from})`}</Text>
              </Text>
            ))}
          </Box>
        )}
        {section('BUILDING', view.building)}
        {section('HANDED BACK', view.returned)}
        {section('REVIEW', view.review)}
        {section('NEXT', view.next)}
        {section('WAITING', view.waiting)}
        {section('DONE', view.done.slice(0, DONE_SHOWN), undefined, view.done.length)}
        {earlier > 0 && <Text dimColor>{`  and ${earlier} earlier`}</Text>}
        {view.resolved > 0 && (
          <Box marginTop={1}>
            <Text dimColor>{`${view.resolved} ${view.resolved === 1 ? 'problem' : 'problems'} resolved`}</Text>
          </Box>
        )}
        {pickers($.ui.resolve(e).Select)}
        {orchestratorLine(view.orchestrator) !== undefined && (
          <Box marginTop={1}>
            <Text dimColor>{orchestratorLine(view.orchestrator)}</Text>
          </Box>
        )}
        {updated !== undefined && (
          <Box marginTop={1}>
            <Text dimColor>{`Updated ${updated}${isViewOnly ? ' · view only' : ''}`}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
