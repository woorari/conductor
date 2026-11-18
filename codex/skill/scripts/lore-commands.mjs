// The Lore commands of the command interface: the approval of a Lore run's plan and the start of a Lore worker.
// A long step holds no lock: it is claimed under the lock, run without it, and recorded under the lock again.
import path from 'node:path';
import { approveStep, prepareWorkspace, readyMark } from './core/lore-steps.mjs';
import { repositoryInfoOf } from './core/lore.mjs';
import { startLoreMerge, syncEnded } from './core/lore-merge.mjs';
import { complexityOf, selectModel } from './core/models.mjs';
import { LORE_DEFAULTS } from './core/project.mjs';
import { MAX_BUILDING, route } from './core/router.mjs';
import * as signals from './core/signals.mjs';
import { isInside, runBranchOf, runWorkspaceOf, taskBranchOf, workspaceOf, workspacesOf } from './core/workspace.mjs';
import { nodeHost } from './lore-host.mjs';

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
