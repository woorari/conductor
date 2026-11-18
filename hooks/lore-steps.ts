/**
 * The Lore steps of a run, host-neutral: making a worker's workspace, the
 * checks at plan approval, a task landing on the run branch, the run branch
 * landing on the protected base, and the base brought into the run branch.
 * Each is the `lore` calls the mod makes, in its order, over a `LoreHost`
 * that runs them; none touches the ledger. Pure: a host (the mod's `$`, or a
 * script's Node) supplies the programs and the disk.
 */

import { branchInfoOf, ignoreRules, mergeOf, pushOf, statusOf } from './lore'
import { rev7 } from './lore-merge'
import { RUNS_DIR } from './store'
import { isInside, removals, topLevel } from './workspace'

/** How long a copy, a status scan or a listing of a large workspace may take: the engine's ceiling for one program. */
export const LONG_MS = 600_000
/**
 * The longest a Lore step that moves a workspace's content may run: a switch,
 * a merge, its abort or a push of a large branch. A host that cannot run a
 * program this long in one call streams it.
 */
export const LORE_LONG_MS = 60 * 60_000

export type Ran = { exitCode: number; out: string; err: string }

/**
 * What the steps need from the machine. A method that fails throws an Error
 * whose message is the reason (the last line a program printed): `copyTree`
 * names the entry it could not copy. `lore` never throws: it answers a
 * non-zero exit with why.
 */
export type LoreHost = {
  /** Runs `lore --non-interactive <args>` in a folder. `ms` is the limit; one of `LORE_LONG_MS` or more is a long step. */
  lore(args: string[], cwd: string, ms?: number): Promise<Ran>
  freeGb(path: string): Promise<number | undefined>
  sameDisk(a: string, b: string): Promise<boolean>
  /** Copies the named top-level entries of one folder into another, copy-on-write where the disk allows. */
  copyTree(from: string, to: string, entries: string[]): Promise<void>
  mkdir(path: string): Promise<void>
  remove(path: string): Promise<void>
  /** Removes many paths in one go (and never a folder's own `.lore`: the steps name only what lies in a copy). */
  removeMany(paths: string[]): Promise<void>
  exists(path: string): Promise<boolean>
  /** Writes the ready mark: the file that says a workspace was finished. */
  mark(path: string): Promise<void>
  readText(path: string): Promise<string | undefined>
  listDir(path: string): Promise<{ name: string; isDir: boolean }[]>
  /** Every folder (each line ending in `/`) and file below a folder, one path to a line. */
  listTree(path: string): Promise<string>
}

/** `home` holds the run folders (ledger, listings, marks); `root` is the workspace copied. In a repository home they are one. */
export type Making = { home: string; root: string; base: string; path: string; branch: string; from: string; carry: readonly string[]; minFreeGB: number; runId: string; taskId: string }

/** The file that says a workspace was finished: only then is a folder there reused. */
export const readyMark = (root: string, runId: string, taskId: string): string => `${root}/${RUNS_DIR}/${runId}/ready-${taskId}`

/** The last line a program printed, for saying why it failed. */
export const lastLine = (ran: { exitCode: number; out: string }): string => ran.out.trim().split(/\n/).filter(line => line.trim() !== '').at(-1)?.trim() ?? `exit ${ran.exitCode}`

/** Removes the paths, if there are any. */
const removeAll = async (host: LoreHost, paths: string[]): Promise<void> => {
  if (paths.length > 0) await host.removeMany(paths)
}

const why = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * Makes a Lore workspace for one task: a copy-on-write copy of the owner's
 * workspace that takes the tracked files and the folders the project carries
 * and nothing else, made a workspace of its own, on its own branch. The
 * owner's workspace is only read. On any failure the half-made copy is
 * removed and the reason answered.
 */
export async function prepareWorkspace(host: LoreHost, at: Making): Promise<{ error?: string }> {
  // Only a folder the mod makes itself, inside the run's workspaces and outside the owner's workspace, is ever removed.
  if (!isInside(at.base, at.path) || at.path === at.root || at.path.startsWith(`${at.root}/`)) return { error: `${at.path} is no place for a workspace: it must lie inside ${at.base}, outside ${at.root}` }
  if (await host.exists(at.path).catch(() => true)) return { error: `${at.path} is there already and is no Lore workspace; it is left as it is. Move it away, then start the worker again` }
  const fail = async (reason: string): Promise<{ error: string }> => {
    await host.remove(at.path).catch(() => undefined)

    return { error: reason }
  }
  try {
    await host.mkdir(at.path)
  } catch (cause) {
    return fail(`its folder could not be made: ${why(cause)}`)
  }
  // A copy-on-write copy is one only on the same disk: across disks cp -c quietly copies every byte.
  if (!(await host.sameDisk(at.root, at.path).catch(() => false))) {
    return fail(`${at.path} lies on another disk than ${at.root} (or its disk could not be read), so a copy there would be a full copy, not a copy-on-write one. Put the workspaces on the same disk (lore.workspaces in .claude/conductor/config.json)`)
  }
  const freeGb = await host.freeGb(at.path).catch(() => undefined)
  if (freeGb === undefined) return fail('df did not say how much disk is free')
  if (freeGb < at.minFreeGB) {
    return fail(`only ${freeGb} GB are free on the disk that holds ${at.path}, and a worker's workspace needs at least ${at.minFreeGB} GB free (lore.minFreeGB in .claude/conductor/config.json)`)
  }
  const rules = ignoreRules((await host.readText(`${at.root}/.loreignore`)) ?? '')
  const entries = (await host.listDir(at.root)).filter(entry => entry.name !== '_deleted')
  try {
    await host.copyTree(at.root, at.path, topLevel(entries, rules, at.carry))
  } catch (cause) {
    return fail(why(cause))
  }
  // A listing of a large workspace runs to tens of megabytes: the host drops it as soon as it is read, whatever happened.
  let text: string
  try {
    text = await host.listTree(at.path)
  } catch (cause) {
    return fail(`the copy's files could not be listed: ${why(cause)}`)
  }
  const relativeListing = text
    .split('\n')
    .map(line => (line.startsWith(`${at.path}/`) ? line.slice(at.path.length + 1) : line))
    .join('\n')
  try {
    await removeAll(host, removals(relativeListing, rules, at.carry).map(one => `${at.path}/${one}`).filter(one => isInside(at.path, one)))
  } catch (cause) {
    return fail(`what the copy must not hold could not be removed: ${why(cause)}`)
  }
  const step = (args: string[], ms = 30_000): Promise<Ran> => host.lore(args, at.path, ms)
  const longStep = (args: string[]): Promise<Ran> => host.lore(args, at.path, LORE_LONG_MS)
  const updated = await step(['repository', 'update-path'])
  if (updated.exitCode !== 0) return fail(`lore did not take the copy as a workspace of its own: ${lastLine(updated)}`)
  const scanned = await step(['status', '--scan'], LONG_MS)
  const status = statusOf(scanned.out)
  if (scanned.exitCode !== 0 || status === undefined) return fail(`lore could not read the copy's status: ${lastLine(scanned)}`)
  try {
    await removeAll(host, status.untracked.map(one => `${at.path}/${one}`).filter(one => isInside(at.path, one)))
  } catch (cause) {
    return fail(`the copy's untracked files could not be removed: ${why(cause)}`)
  }
  const from = await longStep(['branch', 'switch', at.from, '--reset'])
  if (from.exitCode !== 0) return fail(`lore could not switch the copy to ${at.from}: ${lastLine(from)}`)
  const info = branchInfoOf((await step(['branch', 'info', at.branch])).out)
  if (info?.remoteLatest !== undefined) {
    // A task started again goes on from what its branch holds.
    const again = await longStep(['branch', 'switch', at.branch, '--reset'])
    if (again.exitCode !== 0) return fail(`lore could not switch the copy to ${at.branch}: ${lastLine(again)}`)
  } else {
    const created = await step(['branch', 'create', at.branch])
    if (created.exitCode !== 0) return fail(`lore could not make the branch ${at.branch}: ${lastLine(created)}`)
    const pushed = await longStep(['push'])
    const outcome = pushOf(pushed.exitCode, pushed.out)
    if (outcome.kind === 'refused') return fail(`lore could not push the new branch ${at.branch}: ${outcome.text}`)
  }
  await host.mark(readyMark(at.home, at.runId, at.taskId)).catch(() => undefined)

  return {}
}

/**
 * The Lore half of the owner's approval of a run's plan, once the run's
 * workspace is made: the base branch protected, where it stands read, and the
 * run branch checked to stand where the board expects it. `head` is where the
 * run branch stands for the board (the head it had, else where the base stood).
 * `root` is the owner's workspace; no step runs there.
 */
export async function approveStep(host: LoreHost, a: { root: string; runWorkspace: string; base: string; runBranch: string; head?: string }): Promise<{ error?: string; baseAt?: string; head?: string }> {
  const protectedNow = await host.lore(['branch', 'protect', a.base], a.runWorkspace)
  if (protectedNow.exitCode !== 0) return { error: `the base branch ${a.base} could not be protected: ${lastLine(protectedNow)}.` }
  const baseAt = branchInfoOf((await host.lore(['branch', 'info', a.base], a.runWorkspace)).out)?.remoteLatest
  if (baseAt === undefined) return { error: `lore did not say where ${a.base} stands.` }
  const runHead = branchInfoOf((await host.lore(['branch', 'info', a.runBranch], a.runWorkspace)).out)?.remoteLatest
  const expected = a.head ?? baseAt
  // A run branch that was there already is taken only when it stands where the board knows it: else it may hold work nobody judged.
  if (runHead !== expected) return { error: `${a.runBranch} is at ${runHead === undefined ? 'a revision lore did not say' : rev7(runHead)}, not at ${rev7(expected)} where the board expects it: it holds work nobody judged. Archive it (lore branch archive ${a.runBranch}) or start the run under another name.` }

  return { baseAt, head: expected }
}

/** What a task's landing came to: the revision pushed, the files in conflict (merge aborted), or why not. */
export type Landed =
  | { landed: string; conflict?: undefined; conflictFiles?: undefined; error?: undefined }
  | { conflict: string; conflictFiles: string[]; landed?: undefined; error?: undefined }
  | { error: string; landed?: undefined; conflict?: undefined; conflictFiles?: undefined }

/** What the base brought in came to: the run branch's new head, the files in conflict (merge aborted), or why not. */
export type Brought =
  | { head: string; conflict?: undefined; error?: undefined }
  | { conflict: string; head?: undefined; error?: undefined }
  | { error: string; head?: undefined; conflict?: undefined }

/** What the run branch's landing on the base came to; `unprotected` whatever else it says. */
export type OnBase = ({ landed: string; error?: undefined } | { error: string; landed?: undefined }) & { unprotected?: true; protectError?: string }

/**
 * A task's branch merged into the run branch, pinned to the revision that was
 * judged: the run branch brought up to date and checked against where the
 * board left it (`runHead`), the merge, a wrong revision reset, a conflict
 * aborted, the push, and the task's locks let go. `message` is the merge's.
 */
export async function landTask(
  host: LoreHost,
  l: { runWorkspace: string; runBranch: string; taskBranch: string; revision: string; runHead?: string; message: string },
): Promise<Landed> {
  const run = l.runWorkspace
  const synced = await host.lore(['branch', 'switch', l.runBranch, '--reset'], run, LORE_LONG_MS)
  if (synced.exitCode !== 0) return { error: `the run's workspace could not be brought to ${l.runBranch}: ${lastLine(synced)}` }
  const runHead = branchInfoOf((await host.lore(['branch', 'info', l.runBranch], run)).out)?.remoteLatest
  if (runHead === undefined) return { error: `lore did not say where ${l.runBranch} stands on the server` }
  // A task is merged only onto what the board itself left on the run branch: anything else would be carried along unjudged.
  if (l.runHead !== undefined && runHead !== l.runHead) return { error: `${l.runBranch} is at ${rev7(runHead)}, but the board left it at ${rev7(l.runHead)}: something nobody judged is on it. Nothing was merged; look at lore history --branch ${l.runBranch}` }
  const merged = await host.lore(['branch', 'merge', l.taskBranch, `--message=${l.message}`], run, LORE_LONG_MS)
  const outcome = mergeOf(merged.exitCode, merged.out)
  // Lore merges a branch's latest: one pushed between the look above and the merge is not the judged revision.
  if (outcome.kind === 'merged' && outcome.source !== l.revision) {
    await host.lore(['branch', 'reset', runHead, '--branch', l.runBranch], run)
    await host.lore(['branch', 'switch', l.runBranch, '--reset'], run, LORE_LONG_MS)
    const took = outcome.source === undefined ? 'a revision lore did not name' : rev7(outcome.source)

    return { error: `lore took in ${took}, not the judged ${rev7(l.revision)}: the branch moved meanwhile. Nothing was pushed; judge it again` }
  }
  if (outcome.kind === 'conflict') {
    await host.lore(['branch', 'merge', 'abort'], run, LORE_LONG_MS)

    return { conflict: outcome.files.join(', ') || 'files lore did not name', conflictFiles: outcome.files }
  }
  if (outcome.kind === 'failed') {
    await host.lore(['branch', 'merge', 'abort'], run, LORE_LONG_MS)

    return { error: `lore did not merge it: ${outcome.reason}` }
  }
  const pushed = await host.lore(['push'], run, LORE_LONG_MS)
  const sent = pushOf(pushed.exitCode, pushed.out)
  if (sent.kind !== 'pushed') return { error: `the merge could not be pushed: ${sent.kind === 'refused' ? sent.text : 'lore pushed nothing'}` }
  // Its locks are let go.
  await host.lore(['lock', 'release', '--branch', l.taskBranch], run)

  return { landed: sent.revision }
}

/**
 * The run branch merged into the base branch, from the switch to the run
 * branch to the base protected again: `revision` is the head that was
 * approved and `baseAt` where the base stood then; either moving stops the
 * merge. The base is protected again whatever the merge did; a protect that
 * fails is answered as `unprotected` (with `protectError`), which the caller
 * must make a blocker. `fromPlan` only words the advice in a refusal.
 */
export async function landBase(
  host: LoreHost,
  l: { runWorkspace: string; runBranch: string; base: string; baseAt: string; revision: string; message: string; fromPlan?: boolean },
): Promise<OnBase> {
  const run = l.runWorkspace
  const synced = await host.lore(['branch', 'switch', l.runBranch, '--reset'], run, LORE_LONG_MS)
  const status = statusOf((await host.lore(['status'], run)).out)
  if (synced.exitCode !== 0 || status === undefined) return { error: `the run's workspace could not be brought to ${l.runBranch}` }
  if (status.revision !== l.revision) return { error: `${l.runBranch} moved after the approval (it is at ${rev7(status.revision)}, ${rev7(l.revision)} was approved): ${l.fromPlan ? 'review/check the new revision, then retry run_merge_main under the existing plan approval' : 'approve again'}` }
  let outcome: ReturnType<typeof mergeOf> = { kind: 'failed', reason: 'it did not run' }
  let protectedAgain: Ran | undefined
  try {
    // Even an unprotect that failed may have gone through on the server before it timed out: the finally protects again.
    const unprotected = await host.lore(['branch', 'unprotect', l.base], run)
    if (unprotected.exitCode !== 0) outcome = { kind: 'failed', reason: `${l.base} could not be unprotected for the merge: ${lastLine(unprotected)}` }
    else {
      // The base is read once more right before the merge: another merge may have landed since the look before the approval.
      const baseAgain = branchInfoOf((await host.lore(['branch', 'info', l.base], run)).out)?.remoteLatest
      if (baseAgain !== l.baseAt) outcome = { kind: 'failed', reason: `${l.base} moved during the approval (it is at ${baseAgain === undefined ? 'a revision lore did not say' : rev7(baseAgain)}): bring it in with run_sync_base and ${l.fromPlan ? 'review/check, then retry run_merge_main under the existing plan approval' : 'approve again'}` }
      else {
        const merged = await host.lore(['branch', 'merge', 'into', l.base, l.message], run, LORE_LONG_MS)
        outcome = mergeOf(merged.exitCode, merged.out)
      }
    }
  } finally {
    // Whatever the merge did, the base branch is protected again.
    protectedAgain = await host.lore(['branch', 'protect', l.base], run)
  }
  const unprotectedNow = protectedAgain.exitCode === 0 ? {} : { unprotected: true as const, protectError: lastLine(protectedAgain) }
  if (outcome.kind !== 'merged') return { error: outcome.kind === 'conflict' ? `lore did not merge it into ${l.base}: conflicts in ${outcome.files.join(', ')}` : outcome.reason, ...unprotectedNow }

  return { landed: outcome.revision, ...unprotectedNow }
}

/**
 * The base branch brought into the run branch, from the switch to the run
 * branch to the push. `baseAt` is where the base stood when it was claimed and
 * `runHead` where the run branch did; a base that moved meanwhile resets the
 * run branch and pushes nothing. A conflict is aborted and answered by its
 * files; each `error` is the whole sentence the orchestrator is told.
 */
export async function bringBase(host: LoreHost, b: { runWorkspace: string; runBranch: string; base: string; baseAt: string; runHead: string }): Promise<Brought> {
  const run = b.runWorkspace
  const synced = await host.lore(['branch', 'switch', b.runBranch, '--reset'], run, LORE_LONG_MS)
  if (synced.exitCode !== 0) return { error: `the run's workspace could not be brought to ${b.runBranch}: ${lastLine(synced)}.` }
  const merged = await host.lore(['branch', 'merge', b.base, `--message=Bring ${b.base} into ${b.runBranch}`], run, LORE_LONG_MS)
  const outcome = mergeOf(merged.exitCode, merged.out)
  if (outcome.kind === 'conflict') {
    await host.lore(['branch', 'merge', 'abort'], run, LORE_LONG_MS)

    return { conflict: outcome.files.join(', ') || 'files lore did not name' }
  }
  if (outcome.kind === 'failed') {
    await host.lore(['branch', 'merge', 'abort'], run, LORE_LONG_MS)

    return { error: `lore did not bring ${b.base} in: ${outcome.reason}.` }
  }
  if (outcome.source !== undefined && outcome.source !== b.baseAt) {
    await host.lore(['branch', 'reset', b.runHead, '--branch', b.runBranch], run)
    await host.lore(['branch', 'switch', b.runBranch, '--reset'], run, LORE_LONG_MS)

    return { error: `${b.base} moved while it was brought in. Nothing was pushed: call run_sync_base again.` }
  }
  const sent = await host.lore(['push'], run, LORE_LONG_MS)
  const result = pushOf(sent.exitCode, sent.out)
  if (result.kind === 'refused') return { error: `the run branch could not be pushed: ${result.text}.` }

  return { head: result.kind === 'pushed' ? result.revision : outcome.revision }
}
