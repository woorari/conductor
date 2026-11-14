import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildSkill } from '../build.mjs';
const built = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-built-'));
const skillPath = buildSkill(path.join(built, 'conductor'));
const { Conductor, board } = await import(pathToFileURL(path.join(skillPath, 'scripts', 'conductor.mjs')).href);
const { closeBoard } = await import(pathToFileURL(path.join(skillPath, 'scripts/board-launcher.mjs')).href);
process.on('exit', () => fs.rmSync(built, { recursive: true, force: true }));

const owner = { kind: 'owner' };
const worker = id => ({ kind: 'worker', taskId: id });
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-codex-test-'));
  t.after(async () => { if (fs.existsSync(root)) await closeBoard(root, 'run'); await new Promise(r => setTimeout(r, 100)); fs.rmSync(parent, { recursive: true, force: true }); });
  const root = path.join(parent, 'project');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Adapter Test');
  git('config', 'user.email', 'adapter@example.invalid');
  fs.writeFileSync(path.join(root, 'source.txt'), 'original\n');
  git('add', 'source.txt');
  git('commit', '-m', 'initial');
  return { app: new Conductor(root), root, parent, git };
}
const add = (app, id, files = [id + '.txt'], dependsOn = []) => app.apply('run', 'task_add', { id, title: `Task ${id}`, tier: 'sonnet', tierReason: 'Implementation task', files, dependsOn });
const propose = app => app.apply('run', 'run_plan');
const approve = app => app.apply('run', 'approve', {}, owner);
async function started(t) {
  const fixtureValue = fixture(t);
  fixtureValue.app.init();
  await fixtureValue.app.conduct({ id: 'run', source: 'Test request', title: 'Test run' });
  return fixtureValue;
}

test('draft/proposed approval gate, owner requirement, pause and workspace isolation', async t => {
  const { app, root, git } = await started(t);
  await add(app, 'one');
  const initialHead = git('rev-parse', 'HEAD');
  assert.equal((await app.worktree('run', { task: 'one' })).isError, true);
  await propose(app);
  assert.equal((await app.worktree('run', { task: 'one' })).isError, true);
  await assert.rejects(() => app.apply('run', 'approve'), /owner/);
  await approve(app);
  await app.apply('run', 'pause', {}, owner);
  assert.equal((await app.worktree('run', { task: 'one' })).isError, true);
  await app.apply('run', 'unpause', {}, owner);
  const result = await app.worktree('run', { task: 'one' });
  assert.equal(result.isError, false);
  fs.writeFileSync(path.join(result.workspace, 'source.txt'), 'worker\n');
  assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'original\n');
  assert.equal(git('rev-parse', 'HEAD'), initialHead);
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(app.load('run').tasks[0].status, 'building');
});

test('a proposed plan returns the complete approval board without starting workers', async t => {
  const { app } = await started(t);
  await add(app, 'one', ['src/upload.js']);
  await add(app, 'two', ['tests/upload.test.js'], ['one']);
  await app.apply('run', 'task_update', { task: 'one', note: 'Keep existing retries' });
  const result = await app.apply('run', 'run_plan', { title: 'Upload fixes' });
  assert.equal(result.approvalRequired, true);
  assert.match(result.board, /Upload fixes/);
  assert.match(result.board, /one: Task one/);
  assert.match(result.board, /two: Task two/);
  assert.match(result.board, /src\/upload.js/);
  assert.match(result.board, /tests\/upload.test.js/);
  assert.match(result.board, /Keep existing retries/);
  assert.match(result.board, /\| two: Task two \| queued \| implementation \| current Codex model \| one \|/);
  assert.equal(app.load('run').run.plan, 'proposed');
  assert.ok(app.load('run').tasks.every(task => task.status === 'queued'));
  assert.equal((await app.worktree('run', { task: 'one' })).isError, true);
  const cli = path.join(skillPath, 'scripts', 'conductor.mjs');
  const visible = JSON.parse(execFileSync(process.execPath, [cli, 'run_plan', '--root', app.root, '--run', 'run'], { encoding: 'utf8' }));
  assert.equal(visible.approvalRequired, true);
  assert.equal(visible.board, result.board);
  await add(app, 'three', ['docs/upload.md']);
  assert.match((await app.apply('run', 'run_plan')).board, /three: Task three/);
  const denied = await app.apply('run', 'run_plan', {}, worker('one'));
  assert.equal(denied.isError, true);
  assert.equal(denied.board, undefined);
});

test('overlapping plans are refused; failed changes do not modify the ledger', async t => {
  const { app } = await started(t);
  await add(app, 'one', ['src']);
  await add(app, 'two', ['src/api.js']);
  const before = fs.readFileSync(app.ledgerFile('run'), 'utf8');
  await assert.rejects(() => propose(app), /could run at once/);
  assert.equal(fs.readFileSync(app.ledgerFile('run'), 'utf8'), before);
  const refusal = await app.apply('run', 'task_update', { task: 'one', status: 'review', note: 'x'.repeat(201) });
  assert.equal(refusal.isError, true);
  assert.equal(fs.readFileSync(app.ledgerFile('run'), 'utf8'), before);
});

test('dependencies and capacity constrain starts; one green branch supplies the base', async t => {
  const { app, git } = await started(t);
  await add(app, 'one');
  await add(app, 'two', ['two.txt'], ['one']);
  await propose(app); await approve(app);
  assert.equal((await app.worktree('run', { task: 'two' })).isError, true);
  const one = await app.worktree('run', { task: 'one' });
  fs.writeFileSync(path.join(one.workspace, 'one.txt'), 'dependency change');
  execFileSync('git', ['-C', one.workspace, 'add', 'one.txt']);
  execFileSync('git', ['-C', one.workspace, 'commit', '-m', 'dependency change'], { stdio: 'pipe' });
  await app.apply('run', 'task_update', { task: 'one', status: 'review' }, worker('one'));
  await app.apply('run', 'task_update', { task: 'one', status: 'green' });
  const two = await app.worktree('run', { task: 'two' });
  assert.equal(fs.readFileSync(path.join(two.workspace, 'one.txt'), 'utf8'), 'dependency change');
  assert.equal(app.load('run').tasks[1].builtOn, 'one');
  assert.equal(git('branch', '--show-current'), 'main');
});

test('worker cannot approve, finish, change another task or perform orchestrator actions', async t => {
  const { app } = await started(t);
  await add(app, 'one'); await add(app, 'two');
  await propose(app); await approve(app);
  await app.worktree('run', { task: 'one' });
  assert.equal((await app.apply('run', 'task_update', { task: 'two', status: 'review' }, worker('one'))).isError, true);
  assert.equal((await app.apply('run', 'task_update', { task: 'one', status: 'green' }, worker('one'))).isError, true);
  assert.equal((await app.apply('run', 'task_update', { task: 'one', status: 'done' }, worker('one'))).isError, true);
  await assert.rejects(() => app.apply('run', 'pause', {}, worker('one')), /owner/);
  assert.equal((await app.apply('run', 'board_rule', { text: 'Change scope' }, worker('one'))).isError, true);
});

test('questions, rulings, problems and handover survive a new adapter instance', async t => {
  const { app, root } = await started(t);
  await add(app, 'one'); await propose(app); await approve(app);
  await app.worktree('run', { task: 'one' });
  await app.apply('run', 'board_post', { kind: 'question', text: 'Which format?', files: ['one.txt'] }, worker('one'));
  await app.apply('run', 'board_rule', { text: 'Use UTF-8', answers: 'Q1', tasks: ['one'] });
  await app.apply('run', 'problem_report', { text: 'Missing fixture', severity: 'warning' }, worker('one'));
  const saved = await app.handover('run', 'Inspect the fixture, then resume agent 123.');
  const reopened = new Conductor(root);
  const raw = reopened.load('run');
  assert.equal(raw.posts[0].answeredBy, 'R1');
  assert.equal(raw.problems[0].status, 'open');
  assert.match(board(raw), /Missing fixture/);
  assert.match(reopened.brief('run', 'one'), /Use UTF-8/);
  assert.match(fs.readFileSync(saved.file, 'utf8'), /agent 123/);
});

test('in-scope follow-ups retain delivery approval and unsafe run paths are refused', async t => {
  const { app } = await started(t);
  await add(app, 'one'); await propose(app); await approve(app);
  await add(app, 'two');
  assert.equal(app.load('run').run.plan, 'approved');
  assert.equal(app.load('run').run.delivery, 'complete');
  assert.equal((await app.worktree('run', { task: 'two' })).isError, false);
  assert.throws(() => app.load('../outside'), /run\/task id/);
  await assert.rejects(() => app.conduct({ id: '../outside', source: 'no' }), /run\/task id/);
});

test('repository lock prevents concurrent ledger writes and duplicate worker starts', async t => {
  const { app } = await started(t);
  await add(app, 'one'); await propose(app); await approve(app);
  const results = await Promise.allSettled([app.worktree('run', { task: 'one' }), app.worktree('run', { task: 'one' })]);
  assert.equal(results.filter(one => one.status === 'fulfilled').length, 1);
  assert.equal(results.filter(one => one.status === 'rejected').length, 1);
  assert.equal(app.load('run').tasks.filter(one => one.status === 'building').length, 1);
});

test('maxParallel is enforced and restarting a returned worker retains its workspace', async t => {
  const { app } = fixture(t);
  app.init(); await app.conduct({ id: 'run', source: 'Test request', maxParallel: 1 });
  await add(app, 'one'); await add(app, 'two'); await propose(app); await approve(app);
  const first = await app.worktree('run', { task: 'one' });
  assert.equal((await app.worktree('run', { task: 'two' })).isError, true);
  await app.apply('run', 'task_update', { task: 'one', status: 'returned' });
  const resumed = await app.worktree('run', { task: 'one' });
  assert.equal(resumed.workspace, first.workspace);
});

async function githubFixture(t) {
  const fixtureValue = await started(t);
  const { app, parent, git } = fixtureValue;
  git('remote', 'add', 'origin', 'https://github.com/example/project.git');
  await add(app, 'one'); await propose(app); await approve(app);
  await app.apply('run', 'task_update', { task: 'one', pr: 1, status: 'green' });
  await app.apply('run', 'approve_merge', { task: 'one', head: 'a'.repeat(40) }, owner);
  const state = { head: 'a'.repeat(40), baseHead: 'b'.repeat(40), mergeSha: 'c'.repeat(40), writes: [], merged: false, noChecks: false, failBase: false, uncertain: false };
  app.githubApi = async (endpoint, method = 'GET', body) => {
    if (endpoint.endsWith('/merge')) {
      assert.equal(method, 'PUT');
      state.writes.push(structuredClone(body));
      state.merged = true;
      if (state.uncertain) throw new Error('Simulated dropped response');
      return { merged: true, sha: state.mergeSha };
    }
    if (endpoint.includes('/pulls/')) return {
      state: state.merged ? 'closed' : 'open', merged: state.merged,
      mergeable: true, mergeable_state: 'clean', draft: false,
      base: { ref: 'main' }, head: { sha: state.head }, title: 'Change', body: '',
      merge_commit_sha: state.merged ? state.mergeSha : null,
    };
    if (endpoint.includes('/check-runs')) return {
      total_count: state.noChecks ? 0 : 1,
      check_runs: state.noChecks ? [] : [{ name: 'tests', status: 'completed', conclusion: state.failBase && endpoint.includes(state.baseHead) ? 'failure' : 'success' }],
    };
    if (endpoint.includes('/status')) return { total_count: 0, statuses: [] };
    assert.ok(endpoint.includes('/branches/'));
    return { commit: { sha: state.baseHead } };
  };
  return { ...fixtureValue, state, set: update => Object.assign(state, update), read: () => state };
}

test('GitHub refuses missing checks, red base, moved head and pause without a merge', async t => {
  const { app, state, set, read } = await githubFixture(t);
  set({ noChecks: true });
  assert.equal((await app.github('run', { task: 'one' })).isError, true);
  set({ noChecks: false, failBase: true });
  assert.equal((await app.github('run', { task: 'one' })).isError, true);
  set({ failBase: false });
  const check = await app.github('run', { task: 'one' });
  assert.equal(check.head, state.head);
  set({ head: 'd'.repeat(40) });
  await assert.rejects(() => app.github('run', { task: 'one', head: check.head, told: [] }, true), /head changed/);
  assert.equal(read().writes.length, 0);
  await app.apply('run', 'pause', {}, owner);
  assert.equal((await app.github('run', { task: 'one' })).isError, true);
  assert.equal(read().writes.length, 0);
});

test('GitHub merge sends the reviewed SHA and records verified completion', async t => {
  const { app, state, read } = await githubFixture(t);
  const result = await app.github('run', { task: 'one', head: state.head, told: [], closes: [], method: 'squash' }, true);
  assert.equal(result.isError, false);
  assert.deepEqual(read().writes, [{ sha: state.head, merge_method: 'squash' }]);
  const raw = app.load('run');
  assert.equal(raw.tasks[0].status, 'done');
  assert.equal(raw.tasks[0].mergeCommit, state.mergeSha);
  assert.equal(raw.merge, undefined);
});

test('an uncertain merge is never retried; reconciliation verifies it with a read', async t => {
  const { app, state, set, read } = await githubFixture(t);
  set({ uncertain: true });
  await assert.rejects(() => app.github('run', { task: 'one', head: state.head, told: [] }, true), /uncertain/);
  assert.ok(app.load('run').merge);
  await assert.rejects(() => app.github('run', { task: 'one', head: state.head, told: [] }, true), /merging already/);
  assert.equal(read().writes.length, 1);
  await app.reconcile('run', {});
  assert.equal(app.load('run').tasks[0].status, 'done');
  assert.equal(read().writes.length, 1);
});

test('Codex takeover resolves a prior Claude worker to session inheritance and separates complexity from model', async t => {
  const { app } = await started(t);
  await add(app, 'one'); await propose(app); await approve(app);
  const raw = app.load('run'); raw.tasks[0].model = 'claude-sonnet-prior'; app.save('run', raw);
  const before = board(app.load('run'));
  assert.match(before, /implementation \| current Codex model/);
  assert.doesNotMatch(before, /claude-sonnet-prior/);
  const result = await app.worktree('run', { task: 'one' });
  assert.deepEqual(result.modelSelection, { kind: 'inherit', label: 'current Codex model' });
  assert.equal(result.complexity, 'implementation'); assert.equal(app.load('run').tasks[0].model, undefined);
  assert.match(app.brief('run', 'one'), /Model selection: current Codex model/);
  assert.doesNotMatch(app.brief('run', 'one'), /claude-sonnet-prior/);
  const next = app.load('run'); next.tasks[0].model = 'gpt-observed-worker'; app.save('run', next);
  assert.match(board(app.load('run')), /Recorded worker models/);
  assert.match(board(app.load('run')), /gpt-observed-worker/);
});

test('owner model mappings are explicit and a host takeover can reset them without changing the approved plan or history', async t => {
  const { app } = await started(t);
  await add(app, 'one'); await propose(app); await approve(app);
  await assert.rejects(() => app.apply('run', 'model_policy', { models: { sonnet: 'gpt-owner-choice' } }), /owner/);
  await assert.rejects(() => app.apply('run', 'model_policy', { models: { sonnet: 'claude-sonnet-prior' } }, owner), /Codex model mappings/);
  await app.apply('run', 'model_policy', { models: { sonnet: 'gpt-owner-choice' } }, owner);
  assert.match(board(app.load('run')), /gpt-owner-choice/);
  const result = await app.worktree('run', { task: 'one' });
  assert.deepEqual(result.modelSelection, { kind: 'explicit', model: 'gpt-owner-choice', label: 'gpt-owner-choice' });
  const raw = app.load('run'); raw.tasks[0].model = 'gpt-owner-choice'; app.save('run', raw);
  await assert.rejects(() => app.apply('run', 'model_policy', {}, worker('one')), /orchestrator/);
  await app.apply('run', 'model_policy');
  assert.equal(app.load('run').run.plan, 'approved');
  assert.equal(app.load('run').tasks[0].status, 'building');
  assert.equal(app.load('run').tasks[0].model, 'gpt-owner-choice');
  assert.deepEqual(app.load('run').codex.models, {});
  assert.match(board(app.load('run')), /current Codex model/);
});

test('legacy/review-only merges retain exact-head owner approval', async t => {
  const { app, state } = await githubFixture(t);
  const raw = app.load('run'); delete raw.run.mergeApprovals; delete raw.run.delivery; delete raw.run.deliveryBase; app.save('run', raw);
  const checked = await app.github('run', { task: 'one' }); assert.equal(checked.approvalRequired, true);
  await assert.rejects(() => app.github('run', { task: 'one', head: state.head, told: [] }, true), /no complete-delivery approval/);
  assert.equal(state.writes.length, 0);
  await assert.rejects(() => app.apply('run', 'approve_merge', { task: 'one', head: state.head }), /owner/);
  await app.apply('run', 'approve_merge', { task: 'one', head: state.head }, owner);
  await app.github('run', { task: 'one', head: state.head, told: [] }, true);
  assert.equal(state.writes.length, 1); assert.equal(app.load('run').run.mergeApprovals.one, undefined);
});

test('one owner plan approval includes reviewed PR delivery without per-head consent', async t => {
  const { app, state } = await githubFixture(t);
  const raw = app.load('run'); delete raw.run.mergeApprovals; app.save('run', raw);
  const checked = await app.github('run', { task: 'one' }); assert.equal(checked.approvalRequired, false);
  await assert.rejects(() => app.github('run', { task: 'one', head: 'b'.repeat(40), told: [] }, true), /head changed/);
  assert.equal(state.writes.length, 0);
  await app.github('run', { task: 'one', head: state.head, told: [] }, true);
  assert.equal(state.writes.length, 1); assert.equal(app.load('run').tasks[0].status, 'done');
});

test('an explicit review-only approval limits delivery until the actual owner broadens it', async t => {
  const { app, state } = await githubFixture(t);
  const raw = app.load('run'); delete raw.run.mergeApprovals; app.save('run', raw);
  await app.apply('run', 'approve', { delivery: 'review-only' }, owner);
  await assert.rejects(() => app.github('run', { task: 'one', head: state.head, told: [] }, true), /no complete-delivery approval/);
  await approve(app);
  assert.equal((await app.github('run', { task: 'one' })).approvalRequired, false);
});

test('implementation files can expand without another approval while live reservations stay safe', async t => {
  const { app } = await started(t);
  await add(app, 'one', ['source.txt']); await add(app, 'two', ['tests/one.test.js']); await propose(app); await approve(app);
  await app.worktree('run', { task: 'one' }); await app.worktree('run', { task: 'two' });
  const input = { task: 'one', files: ['source.txt', 'wake.ts'], scopeReason: 'Required wake validation for the approved routing deliverable' };
  assert.equal((await app.apply('run', 'task_update', input, worker('one'))).isError, true);
  assert.equal((await app.apply('run', 'task_update', input)).isError, false);
  assert.deepEqual(app.load('run').tasks[0].files, ['source.txt', 'wake.ts']); assert.equal(app.load('run').run.plan, 'approved');
  assert.equal((await app.apply('run', 'task_update', { ...input, files: ['source.txt', 'tests/one.test.js'] })).isError, true);
  assert.equal((await app.apply('run', 'task_update', { ...input, files: ['../outside'] })).isError, true);
});

test('only the reserved worker can quarantine its approved files, with contents preserved', async t => {
  const { app } = await started(t);
  await add(app, 'one', ['old.txt']); await propose(app); await approve(app);
  const work = await app.worktree('run', { task: 'one' }); fs.writeFileSync(path.join(work.workspace, 'old.txt'), 'keep this content');
  await assert.rejects(() => app.quarantine('run', { paths: ['old.txt'] }, { kind: 'orchestrator' }), /orchestrator delegates/);
  await assert.rejects(() => app.quarantine('run', { paths: ['source.txt'] }, worker('one')), /approved file scope/);
  const result = await app.quarantine('run', { paths: ['old.txt'] }, worker('one'));
  assert.equal(fs.existsSync(path.join(work.workspace, 'old.txt')), false);
  assert.match(result.moved[0].to, /_deleted/); assert.equal(fs.readFileSync(result.moved[0].to, 'utf8'), 'keep this content');
});
