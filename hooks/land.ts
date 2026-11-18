/**
 * How work lands, host-neutral: a pull request of a run merged into the
 * base branch on GitHub (`mergeRun`), a Lore run branch merged into the base
 * (`mergeRunMain`, `landOnBase`) and the base brought into the run branch
 * (`bringBaseIn`). The order is the mod's: the board's own side first, then
 * the facts, then the claim, then the write, then the record. The requests,
 * the Lore programs, the ledger queue, the session's background work and the
 * folders are a host's (the mod's `$`); nothing here touches the engine. The
 * Codex script has its own merge, so only the mod calls this module.
 */

import type { Ledger } from '../types'
import type { ApprovalHost } from './approvals'
import { loreRunOf } from './approvals'
import type { CheckJob } from './checks'
import { planDeliversMain, mergeApproved } from './delivery'
import { flights, settle, survey } from './github-merge'
import type { FlightHost, SettleHost, SurveyHost } from './github-merge'
import { LINEAR_KEY, parseLedger } from './ledger'
import { branchInfoOf, notInLore, someOf, statusOf } from './lore'
import { approvedMain, baseBroughtIn, letGo, onBase, readyForBase, rev7, startLoreMerge, syncEnded } from './lore-merge'
import { LONG_MS, LORE_LONG_MS, bringBase, landBase } from './lore-steps'
import type { LoreHost } from './lore-steps'
import { abandoned, closes, closingLine, messageOf, obstacles, onMain, precheck, pullOf, short, startMerge } from './merge'
import { parseConfig } from './project'
import type { ProjectConfig } from './project'
import { refused, reportProblem } from './signals'
import type { Caller } from './signals'
import { isInside, runWorkspaceOf, taskBranchOf, workspaceOf, workspacesOf } from './workspace'

/** What a tool that says "not done" begins with. */
export const NOT_DONE = 'Not done.'
/** The merge tool's name, as a message names it. */
export const TOOL_MERGE = 'mcp__conductor__merge'

/**
 * A Lore claim older than this was not heard of again: longer than the
 * longest a live merge holds its claim (a switch, a merge and a push of up
 * to LORE_LONG_MS each, then a scan and a removal of up to LONG_MS each).
 */
export const LORE_CLAIM_STALE_MIN = (3 * LORE_LONG_MS + 3 * LONG_MS) / 60_000

const iso = (ms: number): string => new Date(ms).toISOString()

/** Why something broke off, in words. */
export const because = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** What a merge tool answers. */
export type Said = { result: string; text: string; isError?: true }

/** A tool call as the signals read it: the tool, the loop it ran in, and its own arguments. */
export type MergeCall = { tool: string; agentId?: string } & Record<string, unknown>

/** What the merge tool answers. */
export type MergeOutcome = { result: string; text: string; isError?: undefined } | { isError: true; result: string; text: string }

/** An approval, claimed: what merging the run branch into the base works from. */
export type ApproveJob = {
  fromPlan?: boolean
  path: string
  ledger: Ledger
  runLore: NonNullable<Ledger['run']['lore']>
  run: string
  base: string
  head: string
  baseNow: string
  at: string
}

/** Bringing the base branch in, claimed: what the merge after the claim works from. */
export type SyncJob = {
  path: string
  base: string
  baseNow: string
  runHead: string
  run: string
  runLore: NonNullable<Ledger['run']['lore']>
}

/** The Lore work of this module the session runs its own way. */
export type LandWork = { kind: 'sync'; job: SyncJob } | { kind: 'approve'; job: ApproveJob }

/**
 * What landing needs from the mod: GitHub, the Lore programs and disk, the
 * ledger queue, the session's background work and the board.
 */
export interface LandHost extends SurveyHost, FlightHost, SettleHost {
  /** The Lore programs and the disk of this machine. */
  steps: LoreHost
  /** The owner's approvals, as the run is found for them. */
  approvals: ApprovalHost
  now(): Promise<number>
  caller(agentId: string | undefined): Caller
  /** Writes the run's ledger path down for a later session. */
  remember(path: string): Promise<void>
  /** Removes a done task's worktree the mod made, unless it holds what is not committed. */
  retireWorktree(ledger: Ledger, taskId: string): Promise<void>
  /** Moves the finished Linear issues of the run. */
  issueDone(path: string): Promise<void>
  /** Moves the Linear issue to its completed state. */
  moveIssue(path: string, key: string): Promise<void>
  /** The merge method the mod is set to: merge, squash or rebase. */
  method(): string
  /** The root of the repository or Lore workspace the session is in, if any. */
  hereRoot(): Promise<string | null>
  /** The untracked entries of a task's workspace that came with the copy. */
  copiedIn(root: string, folder: string, untracked: readonly string[]): Promise<Set<string>>
  /** Starts the project's check on a revision. */
  startCheck(path: string, ledger: Ledger, target: CheckJob): Promise<void>
  /**
   * Claimed Lore work, run on the session's own way and waited for a while:
   * what it said when it ended by then, else undefined, and the orchestrator
   * is told once it ends.
   */
  outlasting(key: string, work: LandWork, signal: AbortSignal | undefined, broke: (cause: unknown) => Said): Promise<Said | undefined>
}

/** A run's config, checked again as it is read: a hand-edited ledger may hold what /conduct would have refused. */
export function projectOf(ledger: Ledger): ProjectConfig | undefined {
  const read = parseConfig(JSON.stringify(ledger.run.config ?? {}))

  return 'config' in read ? read.config : undefined
}

/** Whether a folder is one of this run's own workspaces, safe to remove: inside its workspaces folder, apart from the owner's workspace. */
export function isRemovable(root: string, ledger: Ledger, folder: string): boolean {
  const project = projectOf(ledger)
  if (project === undefined) return false
  const base = workspacesOf(root, project.lore?.workspaces)
  const isOwners = folder === root || folder.startsWith(`${root}/`) || root.startsWith(`${folder}/`)

  return base !== '' && base !== '/' && isInside(base, folder) && !isOwners
}

/** Full plan delivery uses the same checked, pinned, protected-base path without pretending to be an owner command. */
export async function mergeRunMain(host: LandHost, fromPlan: boolean, signal?: AbortSignal): Promise<string> {
  const found = await loreRunOf(host.approvals)
  if ('text' in found) return found.text
  const { path, ledger, runLore, run } = found
  const base = runLore.base
  if (fromPlan && !planDeliversMain(ledger, base)) return 'Nothing was merged: this run has no complete-delivery plan approval for its base. Honor the owner’s review-only limit; an existing explicit full-delivery instruction can be recorded with /approve.'
  const head = branchInfoOf((await host.steps.lore(['branch', 'info', runLore.branch], run)).out)?.remoteLatest
  const baseNow = branchInfoOf((await host.steps.lore(['branch', 'info', base], run)).out)?.remoteLatest
  if (head === undefined || baseNow === undefined) return `Nothing was merged: lore did not say where ${head === undefined ? runLore.branch : base} stands on the server.`
  const blocks = readyForBase(ledger, head)
  if (blocks.length > 0) return [`The run cannot go into ${base} yet:`, ...blocks.map(one => `- ${one}`)].join('\n')
  const other = (await flights(host, ledger.run.id, await host.now()))[0]
  if (other !== undefined) return `Nothing was merged: Run ${other.run} is merging ${other.task} since ${other.startedAt}. One merge at a time, across runs too: ${fromPlan ? 'retry once it is settled; the plan approval stands' : 'approve again once it is settled'}.`
  if (baseNow !== runLore.baseAt) {
    return `Nothing was merged: ${base} moved since the run branch last took it in (it is at ${rev7(baseNow)}; the run branch took in ${runLore.baseAt === undefined ? 'no revision of it on record' : rev7(runLore.baseAt)}). ${fromPlan ? 'Bring it in with mcp__conductor__run_sync_base, review and check the result, then retry run_merge_main under the existing plan approval.' : 'Merging into it now would land a result nobody approved. Ask the orchestrator to bring it in with mcp__conductor__run_sync_base, then approve again.'}`
  }
  const at = iso(await host.now())
  const claimed = await host.mutate(path, raw => {
    const fresh = parseLedger(JSON.stringify(raw)).ledger
    if (fresh === undefined || (fromPlan && !planDeliversMain(fresh, base))) return { value: refused('The delivery approval or pause state changed before the merge.'), isChanged: false }
    const freshBlocks = readyForBase(fresh, head)
    if (freshBlocks.length) return { value: refused(freshBlocks.join('\n')), isChanged: false }
    approvedMain(raw, at, { revision: head, base: baseNow })
    const outcome = startLoreMerge(raw, at, { task: ledger.run.id, revision: head, target: 'base' })

    return { value: outcome, isChanged: true }
  })
  if (claimed.error !== undefined) return `Nothing was merged: ${claimed.error}`
  if (claimed.value.isError) return `Nothing was merged: ${claimed.value.text}`
  // The merge goes on in the session's own way, as a task's merge does: the owner may type or press Stop meanwhile.
  const job: ApproveJob = { path, ledger, runLore, run, base, head, baseNow, at, fromPlan }
  const said = await host.outlasting(`approve ${ledger.run.id}`, { kind: 'approve', job }, signal, cause => {
    const text = `Run ${ledger.run.id} broke off on its way into ${base} (${because(cause)}). The claim stays until the board lets it go, ${LORE_CLAIM_STALE_MIN} minutes after it was made, and ${base} is protected again then; look at lore history --branch ${base} before anything else merges.`

    return { result: text, text }
  })

  return said?.text ?? `Run ${ledger.run.id} is merging into ${base}, and it goes on in the background: a large Lore merge can take up to an hour. The board tells the orchestrator when it has landed or why it did not, and ${base} is protected again either way.`
}

/**
 * An approved run, claimed, from the switch to the run branch to its
 * workspaces removed: the run branch merged into the unprotected base, the
 * base protected again whatever happens, the issue moved and the task
 * branches archived. What it says is what /approve-main answers, or what the
 * orchestrator is told when the merge outlasted the command.
 */
export async function landOnBase(host: LandHost, job: ApproveJob): Promise<string> {
  const { path, ledger, runLore, run, base, head, baseNow, at } = job
  const giveUp = async (why: string): Promise<string> => (await settle(host, path, raw => letGo(raw, why)))?.text ?? `Nothing was merged: ${why}.`
  const result = await landBase(host.steps, { runWorkspace: run, runBranch: runLore.branch, base, baseAt: baseNow, revision: head, message: `Run ${ledger.run.id}: ${ledger.run.title}`, fromPlan: job.fromPlan })
  let protectLine = ''
  if (result.unprotected) {
    protectLine = ` ${base} could not be protected again (${result.protectError}): it is a blocker on the board. Protect it by hand with lore branch protect ${base}.`
    const failedAt = iso(await host.now())
    await host.mutate(path, raw => {
      const outcome2 = reportProblem(raw, failedAt, { kind: 'orchestrator' }, { text: `${base} is not protected: lore branch protect ${base} failed after the run's merge (${result.protectError}). Protect it by hand.`, severity: 'blocker' })

      return { value: outcome2, isChanged: outcome2.isChanged }
    })
  }
  if (result.error !== undefined) return `${await giveUp(result.error)}${protectLine}`
  const landed = result.landed
  const done = await settle(host, path, raw => onBase(raw, at, landed, base))
  const issue = ledger.run.issue ?? (LINEAR_KEY.test(ledger.run.source ?? '') ? ledger.run.source : undefined)
  if (issue !== undefined) await host.moveIssue(path, issue)
  const notArchived: string[] = []
  for (const one of ledger.tasks) {
    if (one.branch === undefined) continue
    const archived = await host.steps.lore(['branch', 'archive', taskBranchOf(runLore.branch, one.id)], run)
    if (archived.exitCode !== 0) notArchived.push(one.id)
  }
  const kept: string[] = []
  const hereRoot = await host.hereRoot()
  const ownBase = hereRoot === null ? '' : workspacesOf(hereRoot, projectOf(ledger)?.lore?.workspaces)
  // The folders removed are the ones the mod derives for this run, never a path read off the ledger.
  const derivedFolders = ownBase === '' ? [] : ledger.tasks.flatMap(one => (one.workspace === undefined ? [] : [workspaceOf(ownBase, ledger.run.id, one.id)]))
  for (const folder of [...derivedFolders, ...(ownBase === '' ? [] : [runWorkspaceOf(ownBase, ledger.run.id)])]) {
    const scanned = statusOf((await host.steps.lore(['status', '--scan'], folder, LONG_MS)).out)
    const here = await host.hereRoot()
    const isOwn = here !== null && isRemovable(here, ledger, folder)
    const left = scanned === undefined || here === null || !isOwn ? undefined : notInLore(scanned, await host.copiedIn(here, folder, scanned.untracked))
    if (left !== undefined && left.length === 0) {
      const isMoved = await host.steps.remove(folder).then(
        () => true,
        () => false,
      )
      if (!isMoved) kept.push(folder)
    } else kept.push(folder)
  }
  const tail = [
    notArchived.length === 0 ? "Its tasks' branches are archived." : `The branches of ${notArchived.join(', ')} could not be archived.`,
    kept.length === 0 ? 'Its workspaces were moved into _deleted.' : `Kept for inspection or a retry: ${kept.join(', ')}.`,
  ].join(' ')

  return `${done?.text ?? `Merged: run ${ledger.run.id} is on ${base} as ${rev7(landed)}.`} ${tail}${protectLine}`
}

/**
 * The base branch brought into the run branch, from the switch to the run
 * branch to the push: a conflict is a blocker on the board, and whatever does
 * not go through lets the claim go and leaves the run branch where it stood.
 * What it says is what run_sync_base answers, or what the orchestrator is
 * told when it outlasted the tool call.
 */
export async function bringBaseIn(host: LandHost, job: SyncJob): Promise<Said> {
  const { path, base, baseNow, runHead, run, runLore } = job
  const fail = (reason: string) => ({ isError: true as const, result: `${NOT_DONE} ${reason}`, text: `${NOT_DONE} ${reason}` })
  const say = (text: string) => ({ result: text, text })
  const giveUp = async (reason: string): Promise<Said> => {
    await settle(host, path, syncEnded)

    return fail(reason)
  }
  const result = await bringBase(host.steps, { runWorkspace: run, runBranch: runLore.branch, base, baseAt: baseNow, runHead })
  if (result.conflict !== undefined) {
    const files = result.conflict
    const at = iso(await host.now())
    await host.mutate(path, raw => {
      syncEnded(raw)
      const reported = reportProblem(raw, at, { kind: 'orchestrator' }, { text: `Bringing ${base} into ${runLore.branch} conflicts in: ${files}. Give it a task that resolves it on the run branch, then call run_sync_base again.`, severity: 'blocker' })

      return { value: reported, isChanged: true }
    })

    return fail(`${base} conflicts with ${runLore.branch} in: ${files}. Nothing was merged; it is a blocker on the board.`)
  }
  if (result.error !== undefined) return giveUp(result.error)
  const broughtHead = result.head
  const written = await settle(host, path, raw => baseBroughtIn(raw, baseNow, broughtHead))
  if (written === undefined) return fail('the board could not be written.')
  const now2 = parseLedger((await host.steps.readText(path)) ?? '').ledger
  if (now2 !== undefined) await host.startCheck(path, now2, { cwd: run, revision: broughtHead })

  return say(`Brought ${base} into ${runLore.branch} as ${rev7(broughtHead)}. ${now2 && planDeliversMain(now2, base) ? 'Review and check the result, then use run_merge_main. The complete-delivery plan approval stands.' : 'A new approval is needed: tell the owner what changed and ask them to type /approve-main.'}`)
}

/**
 * `merge` and `merge_check`: the one way a pull request of a run reaches the
 * base branch. The board's own side first, then GitHub's facts read just now,
 * then the claim, then the merge pinned to the head those facts graded.
 * `merge_check` stops before the claim and changes nothing. `path` is the
 * ledger of the bound run, and the host is in a repository on GitHub: both
 * are the caller's to have settled.
 */
export async function mergeRun(host: LandHost, path: string, call: MergeCall, isCheckOnly: boolean): Promise<MergeOutcome> {
  const base = await host.base()
  const say = (text: string) => ({ result: text, text })
  const fail = (reason: string) => {
    const text = `${NOT_DONE} ${reason}`

    return { isError: true as const, result: text, text }
  }
  await host.remember(path)
  let ledger: Ledger
  try {
    const parsed = parseLedger(await host.read(path))
    if (parsed.ledger === undefined) return fail(`The ledger does not read: ${parsed.error}.`)
    ledger = parsed.ledger
  } catch {
    return fail(`There is no ledger at ${path}.`)
  }
  const now = await host.now()
  const asked = precheck(ledger, host.caller(call.agentId), call, await flights(host, ledger.run.id, now), isCheckOnly)
  if ('error' in asked) return fail(asked.error)
  const surveyed = await survey(host, asked.pr)
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
    const adopted = await settle(host, path, raw => onMain(raw, iso(now), pull.commit ?? pull.head, base, { isAdopted: true, task: id, pr: asked.pr }))
    await host.retireWorktree(ledger, id)
    if (adopted !== undefined) await host.issueDone(path)

    return adopted === undefined ? fail(`${id} could not be taken over: the board could not be written.`) : say(adopted.text)
  }

  const blocks = obstacles(facts, asked)
  if (isCheckOnly) {
    if (blocks.length > 0) return say(`${id} cannot merge yet:\n${blocks.map(one => `- ${one}`).join('\n')}`)

    return say(
      `${id} may merge now. PR ${asked.pr} is open and mergeable into ${base}, its checks are green on ${short(pull.head)} (${facts.checks.line}), the checks on ${base} are ${facts.main.verdict} for ${short(facts.baseHead)}, and ${closingLine(closes(`${pull.title}\n${pull.body}`))}. GitHub would merge it with its ${host.method()} method. Before you call ${TOOL_MERGE}: tell the other sessions that may merge (ListAgents shows them) and name them in told.`,
    )
  }
  if (blocks.length > 0) return fail(`Nothing was merged. ${id} cannot merge now:\n${blocks.map(one => `- ${one}`).join('\n')}`)

  const claimed = await host.mutate(path, raw => {
    const current = parseLedger(JSON.stringify(raw)).ledger
    if (current === undefined || !mergeApproved(current, id, pull.head, base)) return { value: { isChanged: false, isError: true, text: `Main/base merge needs owner approval: /approve-merge ${id} ${pull.head}.` }, isChanged: false }
    const outcome = startMerge(raw, iso(now), { task: id, pr: asked.pr, head: pull.head, told: asked.told, closes: asked.closes })

    return { value: outcome, isChanged: outcome.isChanged }
  })
  await host.redraw()
  if (claimed.error !== undefined) return fail(`Nothing was merged. ${claimed.error}`)
  if (claimed.value.isError) return fail(`Nothing was merged. ${claimed.value.text}`)

  // The merge itself: pinned, so GitHub refuses it if the head moved since it was graded.
  const sent = await host.github(`/pulls/${asked.pr}/merge`, { method: 'PUT', body: JSON.stringify({ sha: pull.head, merge_method: host.method() }) })
  const said = sent.error === undefined ? messageOf(sent.text) : ''
  const answer = sent.error !== undefined ? sent.error : `HTTP ${sent.status}${said === '' ? '' : `: ${said}`}`
  // Whatever the call answered, the pull request itself says whether it is merged.
  const after = await host.github(`/pulls/${asked.pr}`)
  const now2 = iso(await host.now())
  const settled = after.error !== undefined || after.status !== 200 ? undefined : pullOf(after.json)
  if (settled?.isMerged === true) {
    const commit = settled.commit ?? pull.head
    const done = await settle(host, path, raw => onMain(raw, now2, commit, base))
    await host.retireWorktree(ledger, id)
    if (done !== undefined) await host.issueDone(path)

    return say(done?.text ?? `Merged: PR ${asked.pr} (${id}) is on ${base} as ${short(commit)}, but the board could not be written. Set it right with ${TOOL_MERGE} for ${id} again: it is taken over.`)
  }
  if (settled !== undefined) {
    await host.mutate(path, raw => {
      const outcome = abandoned(raw, `GitHub answered ${answer}`)

      return { value: outcome, isChanged: outcome.isChanged }
    })
    await host.redraw()

    return fail(`Nothing was merged: GitHub did not merge PR ${asked.pr} (${answer}). The claim is let go and ${id} stands where it stood. If its head moved, have it graded again.`)
  }

  return say(`Not known yet. The merge call for PR ${asked.pr} went out (${answer}), but GitHub could not be asked afterwards whether it merged. The board keeps ${id} as merging, looks again within a few minutes and settles it either way. Merge nothing meanwhile.`)
}
