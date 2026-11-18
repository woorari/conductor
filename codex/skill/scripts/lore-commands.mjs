// The Lore commands of the command interface: the approval of a Lore run's plan and the start of a Lore worker.
// A long step holds no lock: it is claimed under the lock, run without it, and recorded under the lock again.
import fs from 'node:fs';
import path from 'node:path';
import { RUN_ID, parseLedger } from './core/ledger.mjs';
import { LORE_LONG_MS, approveStep, bringBase, landBase, landTask, lastLine, prepareWorkspace, readyMark } from './core/lore-steps.mjs';
import { branchInfoOf, repositoryInfoOf, statusOf } from './core/lore.mjs';
import { baseBroughtIn, conflicted, letGo, loreReady, mainDecision, onBase, onRunBranch, approvedMain, readyForBase, rev7, startLoreMerge, syncEnded } from './core/lore-merge.mjs';
import { checkRunning, claimsAcross, staleOwn, stuckText, stuckWhy, unprotectedBy, unprotectedText } from './core/lore-claims.mjs';
import { complexityOf, selectModel } from './core/models.mjs';
import { LORE_DEFAULTS } from './core/project.mjs';
import { MAX_BUILDING, route } from './core/router.mjs';
import * as signals from './core/signals.mjs';
import { checkWorkspaceOf, isInside, runBranchOf, runWorkspaceOf, taskBranchOf, workspaceOf, workspacesOf } from './core/workspace.mjs';
import { nodeHost, runProgram } from './lore-host.mjs';

const now = () => new Date().toISOString();
const why = cause => (cause instanceof Error ? cause.message : String(cause));
const refused = (text, isChanged = false) => ({ isError: true, isChanged, text });
// The steps reason over `/` paths: every path handed to them is spelled so, which Node accepts on Windows too.
const fwd = folder => folder.split(path.sep).join('/');
// The claim an approval holds while its Lore steps run: a `sync` claim names no task of the run.
const APPROVAL = '_approve';

/** Why a disk has no room for every worker the run may start at once, or undefined. */
async function roomForWorkers(host, root, workers, minFreeGB) {
  let free;
  try { free = await host.freeGb(root); } catch (cause) { return `${why(cause)}.`; }
  const needed = workers * minFreeGB;
  if (free >= needed) return undefined;
  return `only ${free} GB are free on the disk that holds ${root} and its workspaces, and ${workers} workers at once need ${needed} GB (${minFreeGB} GB each, lore.minFreeGB in .claude/conductor/config.json). Free ${needed - free} GB more, or lower lore.minFreeGB.`;
}

/** A workspace made before and finished is reused; a half-made one the steps made is made again; anything else is made. */
async function workspaceFor(host, making) {
  try {
    const hasLore = await host.exists(`${making.path}/.lore`).catch(() => false);
    if (hasLore && (await host.exists(readyMark(making.home, making.runId, making.taskId)).catch(() => false))) return { path: making.path };
    if (hasLore && isInside(making.base, making.path)) await host.remove(making.path);
    const made = await prepareWorkspace(host, making);
    return made.error === undefined ? { path: making.path } : { error: made.error };
  } catch (cause) {
    return { error: why(cause) };
  }
}

/** The run's own workspace, made and checked, outside any lock; what the run's Lore record becomes, or why not. */
async function makeRunWorkspace(host, home, go) {
  try {
    const settings = go.config?.lore ?? {};
    const minFreeGB = settings.minFreeGB ?? LORE_DEFAULTS.minFreeGB;
    // Each worker's copy grows as it builds: a disk with room for one fills under three.
    const roomless = await roomForWorkers(host, go.root, go.maxParallel ?? MAX_BUILDING, minFreeGB);
    if (roomless !== undefined) return { error: roomless };
    let lore = go.lore;
    if (lore === undefined) {
      const asked = await host.lore(['repository', 'info'], go.root);
      const info = asked.exitCode === 0 ? repositoryInfoOf(asked.out) : undefined;
      if (info === undefined) return { error: `lore could not read the repository of ${go.root}: ${asked.out.trim() || `exit ${asked.exitCode}`}` };
      lore = { remote: info.remote, repository: info.name, base: go.base, branch: runBranchOf(settings.branchPrefix ?? LORE_DEFAULTS.branchPrefix, go.source, go.runId, go.title) };
    }
    const base = workspacesOf(go.root, settings.workspaces);
    const workspace = lore.workspace ?? runWorkspaceOf(base, go.runId);
    const made = await workspaceFor(host, { home, root: go.root, base, path: workspace, branch: lore.branch, from: lore.base, carry: settings.carry ?? LORE_DEFAULTS.carry, minFreeGB, runId: go.runId, taskId: '_run' });
    if (made.error !== undefined) return { error: `the run's Lore workspace could not be made: ${made.error}.` };
    const stepped = await approveStep(host, { root: go.root, runWorkspace: workspace, base: lore.base, runBranch: lore.branch, head: lore.head });
    if (stepped.error !== undefined) return { error: stepped.error };
    return { lore: { ...lore, workspace, baseAt: stepped.baseAt, head: stepped.head } };
  } catch (cause) {
    return { error: why(cause) };
  }
}

/**
 * The owner's approval of a Lore run's plan. `gate(raw, at)` is the approval's own checks (the owner, the plan,
 * its hash) and answers the decision, or throws. A plan that is proposed first needs the run's workspace, made
 * from the place's local copy, and the base branch protected: the claim is taken under the lock, the steps run
 * without it, and the result is recorded under it. Anything else is the approval as a Git run has it.
 */
export async function approveLore({ app, id, input, gate, host = nodeHost() }) {
  const delivery = input.delivery ?? 'complete';
  const approve = (raw, decision) => {
    const result = signals.approvePlan(raw, delivery, raw.codex.base, decision);
    if (!result.isError && result.isChanged) app.save(id, raw);
    return result;
  };
  const started = await app.locked(async () => {
    const raw = app.load(id);
    const at = now();
    const decision = gate(raw, at);
    if (raw.run.plan !== 'proposed') return { result: approve(raw, decision) };
    const { root: where, place, base } = raw.run.workspace;
    const root = fwd(where);
    if (!(await host.exists(`${root}/.lore`).catch(() => false))) {
      const text = `Place ${place}: no local workspace exists on this machine (the folder has no .lore). A Lore workspace is copied from it, never cloned from the server. Approval waits until the place is set up here.`;
      const said = signals.reportProblem(raw, at, { kind: 'orchestrator' }, { text, severity: 'blocker' });
      if (said.isChanged) app.save(id, raw);
      return { result: refused(`${text} ${root} has no .lore. A blocker is recorded on the board.`, said.isChanged) };
    }
    const claimed = startLoreMerge(raw, at, { task: APPROVAL, revision: '0'.repeat(64), target: 'sync' });
    if (claimed.isError) return { result: claimed };
    app.save(id, raw);
    const run = raw.run;
    return { go: { root, base, runId: id, source: run.source, title: run.title, config: run.config, maxParallel: run.maxParallel, lore: run.lore === undefined ? undefined : { ...run.lore } } };
  });
  if (started.result !== undefined) return started.result;
  const made = await makeRunWorkspace(host, fwd(app.home), started.go);

  return app.locked(() => {
    const raw = app.load(id);
    if (raw.merge?.task === APPROVAL && raw.merge.target === 'sync') syncEnded(raw);
    if (made.error !== undefined) {
      app.save(id, raw);
      return refused(`The plan is not approved: ${made.error}`, true);
    }
    raw.run.lore = made.lore;
    let decision;
    try {
      // The plan may have changed while the steps ran: the approval covers the plan as it is now.
      decision = gate(raw, now());
    } catch (cause) {
      app.save(id, raw);
      throw cause;
    }
    const result = signals.approvePlan(raw, delivery, raw.codex.base, decision);
    app.save(id, raw);
    return result;
  });
}

/**
 * Starts a Lore worker: the task is reserved under the lock (so no second start takes it), its workspace is
 * copied from the place without it, and the result is recorded under it. A start that fails gives the task back.
 */
export async function worktreeLore({ app, id, taskId, parsed, host = nodeHost() }) {
  const started = await app.locked(() => {
    const raw = app.load(id);
    const ledger = parsed(raw);
    const decision = route(ledger, { name: taskId, subagentType: 'worker' });
    if (decision.kind !== 'worker') return { result: { isError: true, isChanged: false, text: decision.text ?? 'No worker route.' } };
    if (!raw.codex) throw new Error('This is not a Codex adapter ledger; do not write Claude run files.');
    if (raw.run.lore === undefined) return { result: refused('This Lore run has no Lore branch recorded: approve its plan first.') };
    if (decision.base && !decision.base.branch) throw new Error('A green dependency needs its branch recorded before another task can build on it.');
    const task = ledger.tasks.find(one => one.id === taskId);
    const modelSelection = selectModel('codex', task.tier, raw.codex.models);
    const before = signals.reserved(raw, now(), { taskId, name: taskId, slot: decision.slot, ...(decision.base ? { builtOn: decision.base.taskId } : {}) });
    app.save(id, raw);
    return { go: { lore: { ...raw.run.lore }, from: decision.base?.branch ?? raw.run.lore.branch, settings: raw.run.config?.lore ?? {}, root: fwd(raw.run.workspace.root), before, modelSelection, slot: decision.slot } };
  });
  if (started.result !== undefined) return started.result;
  const { go } = started;
  const base = workspacesOf(go.root, go.settings.workspaces);
  const branch = taskBranchOf(go.lore.branch, taskId);
  let made;
  try {
    made = await workspaceFor(host, { home: fwd(app.home), root: go.root, base, path: workspaceOf(base, id, taskId), branch, from: go.from, carry: go.settings.carry ?? LORE_DEFAULTS.carry, minFreeGB: go.settings.minFreeGB ?? LORE_DEFAULTS.minFreeGB, runId: id, taskId });
  } catch (cause) {
    made = { error: why(cause) };
  }

  return app.locked(() => {
    const raw = app.load(id);
    if (made.error !== undefined) {
      signals.released(raw, go.before);
      app.save(id, raw);
      return refused(`The Lore workspace for ${taskId} could not be made: ${made.error}`, true);
    }
    const task = raw.tasks.find(one => one.id === taskId);
    raw.codex.workspaces ??= {};
    raw.codex.workspaces[taskId] = made.path;
    task.branch = branch;
    app.save(id, raw);
    return { isChanged: true, isError: false, text: `Workspace ready for ${taskId}. Start its Codex subagent there; on spawn failure set the task returned.`, workspace: made.path, branch, tier: task.tier, ...(task.agent ? { agent: task.agent } : {}), ...(task.effort ? { effort: task.effort } : {}), complexity: complexityOf(task.tier), modelSelection: go.modelSelection, slot: go.slot };
  });
}

/** A ledger as the pure modules read it, or the reason it is not one. */
function ledgerOf(raw) {
  const result = parseLedger(JSON.stringify(raw));
  if (result.error) throw new Error(result.error);
  return result.ledger;
}

/** The other runs of this home, read: a ledger that cannot be read stops the merge, since it may hold a claim. */
function othersOf(app, id) {
  const dir = path.join(app.home, 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(one => one !== id && RUN_ID.test(one) && fs.existsSync(app.ledgerFile(one))).map(one => {
    try { return ledgerOf(app.load(one)); } catch { throw new Error(`Unreadable ledger for run ${one}; inspect it before merging.`); }
  });
}

/**
 * A claim of this run that is older than any call can last is let go, with a blocker that asks for a look at the
 * branch first: the call that took it may have landed the merge before it stopped. A claim on the base also gets
 * the base protected again, outside any lock, since the call may have stopped between unprotecting and protecting.
 */
async function settleStale(app, id, host) {
  const found = await app.locked(() => {
    const raw = app.load(id);
    const claim = staleOwn(ledgerOf(raw), Date.now());
    const lore = raw.run.lore;
    return claim === undefined ? undefined : { claim: { ...claim }, base: lore?.base, branch: lore?.branch, workspace: lore?.workspace };
  });
  if (found === undefined) return;
  let unprotected;
  if (found.claim.target === 'base' && found.workspace !== undefined) {
    const again = await host.lore(['branch', 'protect', found.base], found.workspace);
    if (again.exitCode !== 0) unprotected = unprotectedText(found.base, lastLine(again));
  }
  await app.locked(() => {
    const raw = app.load(id);
    if (raw.merge?.startedAt !== found.claim.startedAt) return;
    const at = now();
    letGo(raw, stuckWhy);
    const into = found.claim.target === 'base' ? found.base : found.branch;
    signals.reportProblem(raw, at, { kind: 'orchestrator' }, { text: stuckText(found.claim.task, into), severity: 'blocker' });
    if (unprotected !== undefined) signals.reportProblem(raw, at, { kind: 'orchestrator' }, { text: unprotected, severity: 'blocker' });
    app.save(id, raw);
  });
}

/** The run's own record for a Lore step: refused unless its plan is approved and its workspace made. */
function approvedLore(raw) {
  if (raw.run.plan !== 'approved') return refused('The plan must be approved.');
  if (raw.run.lore?.workspace === undefined) return refused('This Lore run has no run workspace: approve its plan first.');
  return undefined;
}

/**
 * `merge` and `merge_check` of a task in a Lore run: a task judged green goes into the run branch, in the run's
 * own workspace. The board's checks and the server's are read first; the claim is taken under the lock, the steps
 * run without it, and the result is recorded under it. `merge_check` stops before the claim and changes nothing.
 */
export async function mergeLore({ app, id, input, isCheckOnly, host = nodeHost() }) {
  if (!isCheckOnly) await settleStale(app, id, host);
  const ready = () => {
    const raw = app.load(id);
    const no = approvedLore(raw);
    if (no !== undefined) return { result: no };
    const asked = loreReady(ledgerOf(raw), { kind: 'orchestrator' }, input, claimsAcross(othersOf(app, id), id, Date.now()));
    return asked.error === undefined ? { lore: { ...raw.run.lore }, asked, workspace: raw.codex?.workspaces?.[asked.task.id] } : { result: refused(asked.error) };
  };
  const first = await app.locked(ready);
  if (first.result !== undefined) return first.result;
  const { asked, lore } = first;
  const blocks = [...asked.blocks];
  // What is judged is what is on the server: a branch pushed again, or not pushed, is not the revision that was reviewed.
  const there = branchInfoOf((await host.lore(['branch', 'info', asked.branch], lore.workspace)).out)?.remoteLatest;
  if (there === undefined) blocks.push(`lore did not say where ${asked.branch} stands on the server.`);
  else if (there !== asked.revision) blocks.push(`${asked.branch} is at ${rev7(there)} on the server, not the judged ${rev7(asked.revision)}: it was pushed again or not pushed. Judge the revision it is at now.`);
  if (blocks.length > 0) return { isChanged: false, isError: true, text: `Not merged: ${blocks.join(' ')}`, blocks };
  if (isCheckOnly) return { isChanged: false, isError: false, text: `${asked.task.id} can merge into ${lore.branch} at ${rev7(asked.revision)}.`, head: asked.revision };

  const claimed = await app.locked(() => {
    const again = ready();
    if (again.result !== undefined) return again;
    if (again.asked.revision !== asked.revision || again.asked.blocks.length > 0) return { result: refused(`${asked.task.id} changed meanwhile: ${again.asked.blocks.join(' ') || 'its revision is not the one judged'}. Ask again.`) };
    const raw = app.load(id);
    const result = startLoreMerge(raw, now(), { task: asked.task.id, revision: asked.revision, target: 'run' });
    if (result.isError) return { result: result };
    app.save(id, raw);
    return again;
  });
  if (claimed.result !== undefined) return claimed.result;

  let landed;
  try {
    landed = await landTask(host, { runWorkspace: lore.workspace, runBranch: lore.branch, taskBranch: asked.branch, revision: asked.revision, runHead: lore.head, message: `${asked.task.id}: ${asked.task.title}` });
  } catch (cause) {
    landed = { error: why(cause) };
  }
  return app.locked(() => {
    const raw = app.load(id);
    const at = now();
    if (landed.landed !== undefined) {
      const kept = claimed.workspace === undefined ? '' : `Its workspace is kept at ${claimed.workspace}.`;
      const result = onRunBranch(raw, at, asked.task.id, landed.landed, lore.branch, kept);
      app.save(id, raw);
      return result;
    }
    const result = landed.conflict === undefined ? letGo(raw, landed.error) : conflicted(raw, at, asked.task.id, landed.conflictFiles ?? []);
    app.save(id, raw);
    return { ...result, isError: true };
  });
}

/** The record that holds a check: a task's, or the run's. */
const holderOf = (raw, taskId) => (taskId === undefined ? raw.run : raw.tasks.find(one => one.id === taskId));

/**
 * `run_check`: the project's check, run now, on a green task's revision or (with no task) on the run branch's head
 * once every task is merged. It runs in the run's check workspace, put at exactly that revision, as the program and
 * arguments the project named, with no shell and without the caller token. Its verdict is recorded on the task or
 * the run; a check that fails or runs past its limit is a failed verdict, not a failed command.
 */
export async function checkLore({ app, id, input, host = nodeHost() }) {
  await settleStale(app, id, host);
  const started = await app.locked(() => {
    const raw = app.load(id);
    const no = approvedLore(raw);
    if (no !== undefined) return { result: no };
    const check = raw.run.config?.check;
    if (check === undefined) return { result: refused('This run has no check to run: the project names none in .claude/conductor/config.json.') };
    const lore = raw.run.lore;
    const taskId = input.task;
    const task = taskId === undefined ? undefined : raw.tasks.find(one => one.id === taskId);
    if (taskId !== undefined && (task === undefined || task.status !== 'green' || task.revision === undefined)) return { result: refused(`${String(taskId)} is no green task with a revision: a check runs on what you judged green.`) };
    if (taskId === undefined && (lore.head === undefined || raw.tasks.some(one => one.status !== 'done'))) return { result: refused("The run branch's check runs once every task is merged into it.") };
    const at = Date.now();
    const busy = [...raw.tasks.map(one => one.check), raw.run.check].some(one => checkRunning(one, check.timeoutMin, at));
    if (busy) return { result: refused('A check is running already: one at a time. Ask again when it has ended.') };
    const revision = task === undefined ? lore.head : task.revision;
    const startedAt = new Date(at).toISOString();
    holderOf(raw, taskId).check = { revision, verdict: 'running', at: startedAt };
    app.save(id, raw);
    return { go: { check: { ...check }, lore: { ...lore }, settings: raw.run.config?.lore ?? {}, root: fwd(raw.run.workspace.root), taskId, revision, startedAt, branch: task === undefined ? lore.branch : (task.branch ?? taskBranchOf(lore.branch, task.id)) } };
  });
  if (started.result !== undefined) return started.result;
  const { go } = started;
  const verdict = await runCheckSteps(app, id, go, host);
  const text = verdict.verdict === 'passed' ? `The check passed on ${rev7(go.revision)}.` : `The check failed on ${rev7(go.revision)}: ${verdict.line}`;

  return app.locked(() => {
    const raw = app.load(id);
    const holder = holderOf(raw, go.taskId);
    if (holder?.check?.revision !== go.revision || holder.check.verdict !== 'running' || holder.check.at !== go.startedAt) return refused(`The check on ${rev7(go.revision)} ended (${verdict.verdict}), but the board no longer waits for it, so nothing was recorded.`);
    holder.check = { revision: go.revision, verdict: verdict.verdict, at: now(), ...(verdict.line === undefined ? {} : { line: verdict.line }) };
    app.save(id, raw);
    return { isChanged: true, isError: false, text, verdict: verdict.verdict, revision: go.revision, ...(verdict.line === undefined ? {} : { line: verdict.line }) };
  });
}

/** The workspace put at the revision and the program run in it, outside any lock: a verdict, with the last line of what it printed when it failed. */
async function runCheckSteps(app, id, go, host) {
  const failed = line => ({ verdict: 'failed', line: line.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) });
  try {
    const base = workspacesOf(go.root, go.settings.workspaces);
    const cwd = fwd(checkWorkspaceOf(base, id));
    const made = await workspaceFor(host, { home: fwd(app.home), root: go.root, base, path: cwd, branch: go.branch, from: go.branch, carry: go.settings.carry ?? LORE_DEFAULTS.carry, minFreeGB: go.settings.minFreeGB ?? LORE_DEFAULTS.minFreeGB, runId: id, taskId: '_check' });
    if (made.error !== undefined) return failed(`the check workspace could not be made: ${made.error}`);
    const pinned = await host.lore(['branch', 'switch', go.branch, go.revision, '--reset'], cwd, LORE_LONG_MS);
    const standing = statusOf((await host.lore(['status'], cwd)).out);
    if (pinned.exitCode !== 0 || standing?.revision !== go.revision) return failed(`the check workspace could not be put at ${rev7(go.revision)}: ${lastLine(pinned)}`);
    const [program, ...args] = go.check.argv;
    const ran = await runProgram(program, args, cwd, go.check.timeoutMin * app.minuteMs, `${program} could not be run: it is not on the PATH.`);
    if (ran.timedOut) return failed(`the check ran longer than ${go.check.timeoutMin} minute${go.check.timeoutMin === 1 ? '' : 's'} and was stopped`);
    return ran.exitCode === 0 ? { verdict: 'passed' } : failed(lastLine(ran));
  } catch (cause) {
    return failed(`the check could not run: ${why(cause)}`);
  }
}

/** The two revisions a step reads on the server: where the base stands and where the run branch does. */
async function standing(host, lore) {
  const read = async branch => branchInfoOf((await host.lore(['branch', 'info', branch], lore.workspace)).out)?.remoteLatest;
  return { baseNow: await read(lore.base), head: await read(lore.branch) };
}

/**
 * `run_sync_base`: the base branch, moved since the run branch last took it in, is merged into the run branch and
 * pushed. What the run branch is then has had no check and no approval: the check runs again on the new head.
 */
export async function syncBaseLore({ app, id, host = nodeHost() }) {
  await settleStale(app, id, host);
  const started = await app.locked(() => {
    const raw = app.load(id);
    const no = approvedLore(raw);
    if (no !== undefined) return { result: no };
    const claimed = startLoreMerge(raw, now(), { task: raw.run.lore.base, revision: '0'.repeat(64), target: 'sync' });
    if (claimed.isError) return { result: claimed };
    app.save(id, raw);
    return { lore: { ...raw.run.lore } };
  });
  if (started.result !== undefined) return started.result;
  const { lore } = started;
  let outcome;
  try {
    const here = await standing(host, lore);
    if (here.baseNow === undefined || here.head === undefined) outcome = { error: `lore did not say where ${here.baseNow === undefined ? lore.base : lore.branch} stands on the server.` };
    else if (here.head !== lore.head) outcome = { error: `${lore.branch} is at ${rev7(here.head)}, but the board left it at ${rev7(lore.head)}: something nobody judged is on it. Look at lore history --branch ${lore.branch} first.` };
    else if (here.baseNow === lore.baseAt) outcome = { same: true };
    else outcome = { ...(await bringBase(host, { runWorkspace: lore.workspace, runBranch: lore.branch, base: lore.base, baseAt: here.baseNow, runHead: lore.head })), baseNow: here.baseNow };
  } catch (cause) {
    outcome = { error: why(cause) };
  }
  return app.locked(() => {
    const raw = app.load(id);
    const at = now();
    if (outcome.head !== undefined) {
      const result = baseBroughtIn(raw, outcome.baseNow, outcome.head);
      app.save(id, raw);
      return { ...result, text: `${result.text} It is now at ${rev7(outcome.head)}: run the check on it again (run_check) before the run goes into ${lore.base}.`, head: outcome.head };
    }
    syncEnded(raw);
    if (outcome.same) {
      app.save(id, raw);
      return { isChanged: false, isError: false, text: `${lore.branch} has taken in ${lore.base} at ${rev7(lore.baseAt)} already: there is nothing to bring in.` };
    }
    const text = outcome.conflict === undefined ? `${outcome.error}` : `Bringing ${lore.base} into ${lore.branch} conflicts in: ${outcome.conflict}. Give it a task that resolves it on the run branch, then call run_sync_base again.`;
    if (outcome.conflict !== undefined) signals.reportProblem(raw, at, { kind: 'orchestrator' }, { text, severity: 'blocker' });
    app.save(id, raw);
    return refused(text, true);
  });
}

/**
 * `run_merge_main`: the run branch goes into the base branch. The board's refusals are all read again here, at
 * merge time, and every one that stands is told: the tasks, the check on the head, an open problem, the claims and
 * unprotected bases of other runs, a base that moved since the run branch took it in, and the recorded decision
 * that covers this head. Only when none stands is the merge claimed and the base unprotected for it.
 */
export async function mergeMainLore({ app, id, host = nodeHost() }) {
  await settleStale(app, id, host);
  const started = await app.locked(() => {
    const raw = app.load(id);
    const no = approvedLore(raw);
    return no === undefined ? { lore: { ...raw.run.lore } } : { result: no };
  });
  if (started.result !== undefined) return started.result;
  let here;
  try { here = await standing(host, started.lore); } catch (cause) { return refused(`Nothing was merged: ${why(cause)}`); }
  if (here.baseNow === undefined || here.head === undefined) return refused(`Nothing was merged: lore did not say where ${here.baseNow === undefined ? started.lore.base : started.lore.branch} stands on the server.`);

  const claimed = await app.locked(() => {
    const raw = app.load(id);
    const ledger = ledgerOf(raw);
    const lore = raw.run.lore;
    const others = othersOf(app, id);
    const blocks = readyForBase(ledger, here.head);
    for (const one of claimsAcross(others, id, Date.now())) blocks.push(`Run ${one.run} is merging ${one.task} since ${one.startedAt}: one merge at a time, across runs too. Retry once it is settled.`);
    for (const one of unprotectedBy(others, id, lore.base)) blocks.push(`Run ${one} left ${lore.base} unprotected: protect it by hand and resolve that blocker before another run merges into it.`);
    if (here.baseNow !== lore.baseAt) blocks.push(`${lore.base} moved since the run branch last took it in (it is at ${rev7(here.baseNow)}; the run branch took in ${lore.baseAt === undefined ? 'no revision of it on record' : rev7(lore.baseAt)}): bring it in with run_sync_base, review and check the result, then retry.`);
    const undecided = mainDecision(ledger, here.head, lore.baseAt ?? '');
    if (undecided !== undefined) blocks.push(undecided);
    if (blocks.length > 0) return { result: refused(`Nothing was merged: ${blocks.join(' ')}`) };
    const at = now();
    approvedMain(raw, at, { revision: here.head, base: here.baseNow });
    const result = startLoreMerge(raw, at, { task: id, revision: here.head, target: 'base' });
    if (result.isError) return { result: refused(`Nothing was merged: ${result.text}`) };
    app.save(id, raw);
    return { lore: { ...lore }, title: raw.run.title, fromPlan: raw.run.decisions?.plan?.delivery === 'complete' };
  });
  if (claimed.result !== undefined) return claimed.result;
  const { lore } = claimed;

  let landed;
  try {
    landed = await landBase(host, { runWorkspace: lore.workspace, runBranch: lore.branch, base: lore.base, baseAt: lore.baseAt, revision: here.head, message: `Run ${id}: ${claimed.title}`, fromPlan: claimed.fromPlan });
  } catch (cause) {
    landed = { error: why(cause) };
  }
  return app.locked(() => {
    const raw = app.load(id);
    const at = now();
    const result = landed.landed === undefined ? letGo(raw, landed.error) : onBase(raw, at, landed.landed, lore.base);
    if (landed.unprotected) signals.reportProblem(raw, at, { kind: 'orchestrator' }, { text: unprotectedText(lore.base, landed.protectError ?? ''), severity: 'blocker' });
    app.save(id, raw);
    const warning = landed.unprotected ? ` ${lore.base} is not protected: lore branch protect failed (${landed.protectError}). A blocker is on the board; protect it by hand.` : '';
    return landed.landed === undefined ? { ...result, isError: true, text: `Nothing was merged: ${landed.error}.${warning}` } : { ...result, text: `${result.text}${warning}` };
  });
}
