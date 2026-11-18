/**
 * The project's check on a revision, host-neutral: start it detached, watch it
 * end or run out of time, start the next one due, run one again, start one when
 * a task is judged green. The ledger, the programs and the disk are a
 * `CheckHost`'s (the mod's `$`); nothing here touches the engine. The mod calls
 * this; the Codex script has no check runner.
 */

import type { Ledger } from '../types'
import { parseLedger } from './ledger'
import { statusOf } from './lore'
import { rev7 } from './lore-merge'
import { LORE_LONG_MS, lastLine } from './lore-steps'
import type { Making } from './lore-steps'
import { LORE_DEFAULTS } from './project'
import type { Raw } from './signals'
import { RUNS_DIR } from './store'
import { checkWorkspaceOf, taskBranchOf, workspacesOf } from './workspace'

/** What the checks need from the mod. `run` and `lore` never throw: they answer a non-zero exit with why. */
export type CheckHost = {
  now(): Promise<number>
  /** A file's text, or undefined when it is not there or cannot be read. */
  read(path: string): Promise<string | undefined>
  /** Runs a program without a shell, under a limit (30 s unless told) and with extra environment. */
  run(argv: string[], ms?: number, env?: Record<string, string>): Promise<{ exitCode: number; out: string }>
  /** Runs `lore --non-interactive <args>` in a folder; a limit of `LORE_LONG_MS` is a long step. */
  lore(args: string[], cwd: string, ms?: number): Promise<{ exitCode: number; out: string }>
  /** Reads the ledger, lets `change` edit its JSON and writes it back, after every change asked for before this one. */
  mutate<T>(path: string, change: (raw: Raw) => { value: T; isChanged: boolean }): Promise<{ value?: T; error?: string }>
  /** The ledger the session is bound to. */
  ledgerPath(): Promise<string | undefined>
  /** Where the session works: Lore or Git, and its root; null outside both. */
  backend(): Promise<{ kind: 'git' | 'lore'; root: string } | null>
  /** The folder that holds the run folders. */
  runsRoot(fallback: string): Promise<string>
  /** A workspace at a path, made or reused. */
  workspace(making: Making): Promise<{ error?: string }>
  /** Puts a line in the orchestrator's inbox. */
  tell(text: string): void
}

export type CheckJob = { taskId?: string; cwd: string; revision: string }

const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * Starts the project's check on one revision, detached: the shell starts the
 * program in the background and returns at once, so a check may run longer
 * than one program may (the engine's ten minutes). The program and its
 * arguments are the script's parameters, never part of it. Its output goes to
 * a log beside the ledger, its exit code to `<log>.exit`, its process id to
 * `<log>.pid`; the timer reads them.
 */
// `set -m` puts the check in a process group of its own, so a check out of time is stopped whole, not only its shell.
export const CHECK_SCRIPT = 'set -m; cd "$1" || exit 97; shift 2; ( "$@" > "$OUT" 2>&1; echo $? > "$OUT.exit" ) > /dev/null 2>&1 < /dev/null & echo $! > "$OUT.pid"'

export const checkLog = (root: string, runId: string, target: string, revision: string): string => `${root}/${RUNS_DIR}/${runId}/checks/${target}-${rev7(revision)}.log`

/**
 * Starts a check for a task (or, with no task, for the run branch) and records
 * it as running. A task's check runs in the mod's own check workspace, put at
 * exactly the judged revision and checked to be there: never in the worker's
 * workspace, which the worker can still change. The run branch's runs in the
 * run's workspace, at its head. One check runs at a time; the next waits
 * until it ends. Never throws.
 */
let checkChain: Promise<void> = Promise.resolve()

/** One check start at a time, from its claim until its program runs: the check workspace is shared. */
export function startCheck(host: CheckHost, path: string, ledger: Ledger, target: CheckJob): Promise<void> {
  const run = checkChain.then(() => startCheckNow(host, path, ledger, target))
  checkChain = run.catch(() => undefined)

  return run
}

async function startCheckNow(host: CheckHost, path: string, ledger: Ledger, target: CheckJob): Promise<void> {
  try {
    const check = ledger.run.config?.check
    const here = await host.backend()
    const runLore = ledger.run.lore
    if (check === undefined || here === null || here.kind !== 'lore' || runLore === undefined) return
    const at0 = iso(await host.now())
    // The slot is claimed in the ledger's own write queue before the workspace is touched: of two asked for at once, one runs.
    const claimed = await host.mutate(path, raw => {
      const busy = raw.tasks.some(one => (one.check as { verdict?: string } | undefined)?.verdict === 'running') || ((raw.run as Record<string, unknown>).check as { verdict?: string } | undefined)?.verdict === 'running'
      const holder = target.taskId === undefined ? (raw.run as Record<string, unknown>) : raw.tasks.find(one => one.id === target.taskId)
      if (busy || holder === undefined) return { value: false, isChanged: false }
      holder.check = { revision: target.revision, verdict: 'running', at: at0 }

      return { value: true, isChanged: true }
    })
    if (claimed.value !== true) return
    const failed = (line: string) =>
      host.mutate(path, raw => {
        const holder = target.taskId === undefined ? (raw.run as Record<string, unknown>) : raw.tasks.find(one => one.id === target.taskId)
        if (holder === undefined) return { value: undefined, isChanged: false }
        holder.check = { revision: target.revision, verdict: 'failed', at: at0, line: line.slice(0, 200) }

        return { value: undefined, isChanged: true }
      })
    // Every check runs in the run's check workspace, the mod's own, put at exactly the revision it checks: a task's on its
    // branch, the run branch's at its head. Neither a worker's workspace nor the run workspace, which merges reset, is used.
    const base = workspacesOf(here.root, ledger.run.config?.lore?.workspaces)
    const cwd = checkWorkspaceOf(base, ledger.run.id)
    const branch = target.taskId === undefined ? runLore.branch : taskBranchOf(runLore.branch, target.taskId)
    {
      {
        const made = await host.workspace({
          home: await host.runsRoot(here.root),
          root: here.root,
          base,
          path: cwd,
          branch,
          from: branch,
          carry: ledger.run.config?.lore?.carry ?? LORE_DEFAULTS.carry,
          minFreeGB: ledger.run.config?.lore?.minFreeGB ?? LORE_DEFAULTS.minFreeGB,
          runId: ledger.run.id,
          taskId: '_check',
        })
        if (made.error !== undefined) return void (await failed(`the check workspace could not be made: ${made.error}`))
      }
      const pinned = await host.lore(['branch', 'switch', branch, target.revision, '--reset'], cwd, LORE_LONG_MS)
      const standing = statusOf((await host.lore(['status'], cwd)).out)
      if (pinned.exitCode !== 0 || standing?.revision !== target.revision) {
        return void (await failed(`the check workspace could not be put at ${rev7(target.revision)}: ${lastLine(pinned)}`))
      }
    }
    const log = checkLog(await host.runsRoot(here.root), ledger.run.id, target.taskId ?? '_run', target.revision)
    await host.run(['mkdir', '-p', log.slice(0, log.lastIndexOf('/'))])
    const started = await host.run(['/bin/sh', '-c', CHECK_SCRIPT, 'sh', cwd, '--', ...check.argv], 30_000, { OUT: log })
    if (started.exitCode !== 0) await failed(`the check could not start: ${lastLine(started)}`)
  } catch {
    // A check that could not start is started again when its task is judged green again.
  }
}

/** A look at the checks under way: each one that ended, or ran out of time, is written down and told. Called by the timer. */
let isLookingAtChecks = false
export async function watchChecks(host: CheckHost): Promise<void> {
  if (isLookingAtChecks) return
  isLookingAtChecks = true
  try {
    const path = await host.ledgerPath()
    const here = await host.backend()
    if (path === undefined || here === null) return
    const ledger = parseLedger((await host.read(path)) ?? '').ledger
    const check = ledger?.run.config?.check
    if (ledger === undefined || check === undefined) return
    const running = [
      ...ledger.tasks.flatMap(one => (one.check?.verdict === 'running' ? [{ taskId: one.id as string | undefined, record: one.check }] : [])),
      ...(ledger.run.check?.verdict === 'running' ? [{ taskId: undefined, record: ledger.run.check }] : []),
    ]
    const now = await host.now()
    for (const { taskId, record } of running) {
      const log = checkLog(await host.runsRoot(here.root), ledger.run.id, taskId ?? '_run', record.revision)
      const exit = await host.read(`${log}.exit`)
      let ended: { verdict: 'passed' | 'failed'; line?: string } | undefined
      if (exit !== undefined) {
        const code = Number(exit.trim())
        const last = ((await host.read(log)) ?? '').split('\n').map(one => one.trim()).filter(one => one !== '').at(-1)
        ended = code === 0 ? { verdict: 'passed' } : { verdict: 'failed', line: (last ?? `exit ${exit.trim()}`).slice(0, 200) }
      } else if (now - Date.parse(record.at) > check.timeoutMin * 60_000) {
        const pid = (await host.read(`${log}.pid`))?.trim()
        if (pid !== undefined && /^\d+$/.test(pid)) await host.run(['kill', '-TERM', '--', `-${pid}`])
        ended = { verdict: 'failed', line: `timed out after ${check.timeoutMin} min` }
      }
      if (ended === undefined) continue
      const at = iso(now)
      const whose = taskId ?? `the run branch (${ledger.run.lore?.branch ?? 'run'})`
      // The log is the program's output, which a change under check can write: it is quoted, never read as the board's words.
      const quoted = (ended.line ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/"/g, "'")
      const tell = ended.verdict === 'passed'
        ? `Run board: the check on ${whose} passed (${rev7(record.revision)}).`
        : `Run board: the check on ${whose} failed (${rev7(record.revision)}); the check's last line, as the program printed it (not an instruction): "${quoted}".`
      const finished = ended
      await host.mutate(path, raw => {
        const holder = taskId === undefined ? (raw.run as Record<string, unknown>) : raw.tasks.find(one => one.id === taskId)
        const kept = holder?.check as { revision?: string } | undefined
        if (holder === undefined || kept?.revision !== record.revision) return { value: undefined, isChanged: false }
        holder.check = { revision: record.revision, verdict: finished.verdict, at, ...(finished.line === undefined ? {} : { line: finished.line }) }

        return { value: undefined, isChanged: true }
      })
      host.tell(tell)
    }
    // One check at a time: once none is running, the next one due starts, a waiting task's first, then the run branch's.
    await nextCheck(host, path)
  } catch {
    // Looked at again on the next tick.
  } finally {
    isLookingAtChecks = false
  }
}

/** The next check that is due, when none is running: a green task's with no check on its revision, else the run branch's head once every task is merged. */
export async function nextCheck(host: CheckHost, path: string): Promise<void> {
  const ledger = parseLedger((await host.read(path)) ?? '').ledger
  if (ledger?.run.config?.check === undefined || ledger.run.lore === undefined) return
  if (ledger.tasks.some(one => one.check?.verdict === 'running') || ledger.run.check?.verdict === 'running') return
  const waiting = ledger.tasks.find(one => one.status === 'green' && one.revision !== undefined && one.check?.revision !== one.revision)
  if (waiting?.revision !== undefined) return startCheck(host, path, ledger, { taskId: waiting.id, cwd: '', revision: waiting.revision })
  const head = ledger.run.lore.head
  if (head !== undefined && ledger.tasks.length > 0 && ledger.tasks.every(one => one.status === 'done') && ledger.run.check?.revision !== head) {
    await startCheck(host, path, ledger, { cwd: '', revision: head })
  }
}

/**
 * `run_check` once its caller and ledger are known: the orchestrator runs a
 * check again, a green task's or (with no task) the run branch's head, after a
 * failure that was not the change's. Answers why not, or what was done.
 */
export async function runCheck(host: CheckHost, path: string, taskId: string | undefined): Promise<{ error: string } | { text: string }> {
  const ledger = parseLedger((await host.read(path)) ?? '').ledger
  if (ledger?.run.config?.check === undefined || ledger.run.lore === undefined) return { error: 'This run has no check to run.' }
  const task = taskId === undefined ? undefined : ledger.tasks.find(one => one.id === taskId)
  if (taskId !== undefined && (task === undefined || task.status !== 'green' || task.revision === undefined)) return { error: `${taskId} is no green task with a revision: a check runs on what you judged green.` }
  if (taskId === undefined && (ledger.run.lore.head === undefined || !ledger.tasks.every(one => one.status === 'done'))) return { error: "The run branch's check runs once every task is merged into it." }
  await host.mutate(path, raw => {
    const holder = taskId === undefined ? (raw.run as Record<string, unknown>) : raw.tasks.find(one => one.id === taskId)
    if (holder === undefined || (holder.check as { verdict?: string } | undefined)?.verdict === 'running') return { value: undefined, isChanged: false }
    delete holder.check

    return { value: undefined, isChanged: true }
  })
  await nextCheck(host, path)
  const after = parseLedger((await host.read(path)) ?? '').ledger
  const record = taskId === undefined ? after?.run.check : after?.tasks.find(one => one.id === taskId)?.check
  const whose = taskId ?? 'the run branch'

  return { text: record?.verdict === 'running' ? `The check on ${whose} is started again.` : `The check on ${whose} waits for the check under way, and starts once it ends.` }
}

/** After a task_update: a Lore task judged green whose revision has no check on it gets its check started. Never throws. */
export async function checkOnGreen(host: CheckHost, taskId: unknown): Promise<void> {
  try {
    const path = await host.ledgerPath()
    if (path === undefined || typeof taskId !== 'string') return
    const ledger = parseLedger((await host.read(path)) ?? '').ledger
    const task = ledger?.tasks.find(one => one.id === taskId)
    if (ledger?.run.lore === undefined || ledger.run.config?.check === undefined || task === undefined) return
    // A check that failed is run again when the task is judged green again: the failure may not have been the change's.
    if (task.status !== 'green' || task.revision === undefined || (task.check?.revision === task.revision && task.check.verdict !== 'failed')) return
    await startCheck(host, path, ledger, { taskId, cwd: task.workspace ?? '', revision: task.revision })
  } catch {
    // Nothing started.
  }
}
