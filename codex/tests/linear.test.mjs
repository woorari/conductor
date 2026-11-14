import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildSkill } from '../build.mjs';

const built = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-linear-built-'));
const skill = buildSkill(path.join(built, 'conductor'));
const cli = path.join(skill, 'scripts', 'conductor.mjs');
const { Conductor, board } = await import(pathToFileURL(cli).href);
const { linearApiFromEnvironment } = await import(pathToFileURL(path.join(skill, 'scripts', 'linear.mjs')).href);
const { linearIssueComplete } = await import(pathToFileURL(path.join(skill, 'scripts', 'core', 'linear.mjs')).href);
process.on('exit', () => fs.rmSync(built, { recursive: true, force: true }));
const owner = { kind: 'owner' };
const states = [
  { id: 'review-state', name: 'Review', type: 'started', position: 20 },
  { id: 'doing-state', name: 'Doing', type: 'started', position: 10 },
  { id: 'shipped-state', name: 'Shipped', type: 'completed', position: 30 },
];

function transport() {
  const current = new Map();
  const writes = [];
  let unavailable = false;
  let loseReply = false;
  const api = async (query, variables) => {
    if (unavailable) throw new Error('Simulated unavailable service');
    if (query.includes('issueUpdate')) {
      const key = variables.id.replace('uuid-', '');
      const type = variables.input.stateId === 'shipped-state' ? 'completed' : 'started';
      writes.push({ key, stateId: variables.input.stateId });
      current.set(key, type);
      if (loseReply) { loseReply = false; throw new Error('Response lost after applying update'); }
      return { issueUpdate: { success: true } };
    }
    return { issue: {
      id: `uuid-${variables.id}`, identifier: variables.id,
      state: { name: 'Custom label', type: current.get(variables.id) ?? 'backlog' },
      team: { id: 'team-id', key: 'ENG', states: { nodes: states } },
    } };
  };
  return { api, current, writes, outage: value => { unavailable = value; }, loseNextReply: () => { loseReply = true; } };
}

async function fixture(t, api = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-linear-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = new Conductor(root, { linearApi: api });
  await app.conduct({ args: 'ENG-1' });
  const add = (id, ticket) => app.apply('ENG-1', 'task_add', { id, title: id, tier: 'sonnet', tierReason: 'Implementation', files: [`${id}.txt`], ...(ticket ? { ticket } : {}) });
  const approve = async () => { await app.apply('ENG-1', 'run_plan'); await app.apply('ENG-1', 'approve', {}, owner); };
  const update = (task, status) => app.apply('ENG-1', 'task_update', { task, status });
  const sync = () => app.linearSync('ENG-1');
  return { app, root, add, approve, update, sync };
}

test('Linear issue is inferred from the source and stays untouched until plan approval', async t => {
  const remote = transport();
  const f = await fixture(t, remote.api);
  assert.equal(f.app.load('ENG-1').run.tickets, 'linear');
  assert.equal(f.app.load('ENG-1').run.issue, 'ENG-1');
  await f.add('one', 'ENG-2');
  await f.sync();
  assert.deepEqual(remote.writes, []);
  await f.approve(); await f.sync();
  assert.deepEqual(remote.writes, [{ key: 'ENG-1', stateId: 'doing-state' }]);
  await f.sync();
  assert.equal(remote.writes.length, 1);
});

test('shared task tickets and parent complete only after all associated work is done', async t => {
  const remote = transport();
  const f = await fixture(t, remote.api);
  await f.add('one', 'ENG-2'); await f.add('two', 'ENG-2');
  await f.approve(); await f.sync();
  await f.update('one', 'review'); await f.sync();
  assert.equal(remote.current.get('ENG-2'), 'started');
  await f.update('one', 'green'); await f.sync();
  assert.equal(remote.current.get('ENG-1'), 'started');
  assert.equal(remote.current.get('ENG-2'), 'started');
  await f.update('one', 'done'); await f.sync();
  assert.equal(remote.current.get('ENG-2'), 'started');
  await f.update('two', 'done'); await f.sync();
  assert.equal(remote.current.get('ENG-2'), 'completed');
  assert.equal(remote.current.get('ENG-1'), 'completed');
  assert.equal(remote.writes.filter(one => one.key === 'ENG-2' && one.stateId === 'shipped-state').length, 1);
});

test('both hosts share a completion rule that refuses every unfinished task status', async t => {
  const f = await fixture(t);
  await f.add('one', 'ENG-1'); await f.add('two', 'ENG-1'); await f.approve();
  const raw = f.app.load('ENG-1');
  raw.tasks[0].status = 'done';
  for (const status of ['queued', 'building', 'returned', 'review', 'green', 'blocked', 'failed']) {
    raw.tasks[1].status = status;
    assert.equal(linearIssueComplete(raw, 'ENG-1'), false, status);
  }
  raw.tasks[1].status = 'done';
  assert.equal(linearIssueComplete(raw, 'ENG-1'), true);
  raw.run.lore = { remote: 'lores://example.test', repository: 'game', base: 'main', branch: 'conductor/ENG-1' };
  assert.equal(linearIssueComplete(raw, 'ENG-1'), false);
  raw.run.merged = { revision: 'a'.repeat(64), at: new Date().toISOString() };
  assert.equal(linearIssueComplete(raw, 'ENG-1'), true);
});

test('a problem under completed task work keeps that task ticket and its parent open', async t => {
  const remote = transport();
  const f = await fixture(t, remote.api);
  await f.add('one', 'ENG-2'); await f.approve();
  await f.app.apply('ENG-1', 'problem_report', { task: 'one', severity: 'warning', text: 'Task work needs verification' });
  await f.update('one', 'done'); await f.sync();
  assert.equal(remote.current.get('ENG-2'), 'started');
  assert.equal(remote.current.get('ENG-1'), 'started');
  await f.app.apply('ENG-1', 'problem_resolve', { problem: 'P1', resolution: 'Verified' });
  await f.sync();
  assert.equal(remote.current.get('ENG-2'), 'completed');
  assert.equal(remote.current.get('ENG-1'), 'completed');
});

test('a paused run stays open even when all its tasks have finished', async t => {
  const remote = transport();
  const f = await fixture(t, remote.api);
  await f.add('one', 'ENG-1'); await f.approve(); await f.sync();
  await f.app.apply('ENG-1', 'pause', {}, owner);
  await f.update('one', 'done'); await f.sync();
  assert.equal(remote.current.get('ENG-1'), 'started');
  await f.app.apply('ENG-1', 'unpause', {}, owner); await f.sync();
  assert.equal(remote.current.get('ENG-1'), 'completed');
});

test('root ticket used by one task is not completed ahead of the rest of the run', async t => {
  const remote = transport();
  const f = await fixture(t, remote.api);
  await f.add('one', 'ENG-1'); await f.add('two', 'ENG-2');
  await f.approve();
  await f.update('one', 'done'); await f.sync();
  assert.equal(remote.current.get('ENG-1'), 'started');
});

test('legacy runs infer their parent from an issue key followed by source context', async t => {
  const remote = transport();
  const f = await fixture(t, remote.api);
  await f.add('one', 'ENG-1'); await f.add('two', 'ENG-2'); await f.approve();
  const raw = f.app.load('ENG-1');
  delete raw.run.issue; delete raw.run.tickets;
  raw.run.source = 'ENG-1 https://linear.app/example/issue/ENG-1; implementation notes';
  f.app.save('ENG-1', raw);
  await f.update('one', 'done'); await f.sync();
  assert.equal(remote.current.get('ENG-1'), 'started');
  await f.update('two', 'done'); await f.sync();
  assert.equal(remote.current.get('ENG-1'), 'completed');
});

test('open warnings hold parent completion until their resolution is saved', async t => {
  const remote = transport();
  const f = await fixture(t, remote.api);
  await f.add('one', 'ENG-2'); await f.approve();
  await f.app.apply('ENG-1', 'problem_report', { severity: 'warning', text: 'Needs follow-up' });
  await f.update('one', 'done'); await f.sync();
  assert.equal(remote.current.get('ENG-2'), 'completed');
  assert.equal(remote.current.get('ENG-1'), 'started');
  await f.app.apply('ENG-1', 'problem_resolve', { problem: 'P1', resolution: 'Follow-up verified' });
  await f.sync();
  assert.equal(remote.current.get('ENG-1'), 'completed');
});

test('in-scope follow-ups retain approval and the parent waits for all their work', async t => {
  const remote = transport();
  const f = await fixture(t, remote.api);
  await f.add('one'); await f.approve(); await f.sync();
  await f.add('two');
  await f.update('one', 'done'); await f.sync();
  assert.equal(f.app.load('ENG-1').run.plan, 'approved');
  assert.equal(remote.current.get('ENG-1'), 'started');
  await f.update('two', 'done'); await f.sync();
  assert.equal(remote.current.get('ENG-1'), 'completed');
});

test('API failure keeps board changes durable and a restart can retry the pending update', async t => {
  const remote = transport();
  const f = await fixture(t, remote.api);
  await f.add('one'); await f.approve();
  remote.outage(true);
  const failed = await f.sync();
  assert.equal(failed.pending.length, 1);
  assert.match(board(f.app.load('ENG-1')), /not confirmed/);
  await f.update('one', 'done');
  assert.equal(f.app.load('ENG-1').tasks[0].status, 'done');
  remote.outage(false);
  const restarted = new Conductor(f.root, { linearApi: remote.api });
  assert.deepEqual((await restarted.linearSync('ENG-1')).pending, []);
  assert.equal(remote.current.get('ENG-1'), 'completed');
});

test('an uncertain response is settled by reading Linear rather than repeating the write', async t => {
  const remote = transport();
  const f = await fixture(t, remote.api);
  await f.add('one'); await f.approve();
  remote.loseNextReply();
  assert.equal((await f.sync()).pending.length, 1);
  assert.equal(remote.writes.length, 1);
  assert.deepEqual((await f.sync()).pending, []);
  assert.equal(remote.writes.length, 1);
});

test('connector transitions remain pending until observed and stale acknowledgements are refused', async t => {
  const f = await fixture(t);
  await f.add('one'); await f.approve();
  assert.deepEqual((await f.sync()).pending, [{ issue: 'ENG-1', target: 'started' }]);
  await assert.rejects(() => f.app.linearAck('ENG-1', { issue: 'ENG-1', target: 'started', observed: 'backlog' }), /observed/);
  await f.app.linearAck('ENG-1', { issue: 'ENG-1', target: 'started', observed: 'started' });
  assert.deepEqual((await f.sync()).pending, []);
  await f.update('one', 'done');
  await assert.rejects(() => f.app.linearAck('ENG-1', { issue: 'ENG-1', target: 'started', observed: 'started' }), /no longer pending/);
  await f.app.linearAck('ENG-1', { issue: 'ENG-1', target: 'completed', error: true });
  assert.match(board(f.app.load('ENG-1')), /plugin did not confirm/);
  await f.app.linearAck('ENG-1', { issue: 'ENG-1', target: 'completed', observed: 'completed' });
  assert.deepEqual((await f.sync()).pending, []);
});

test('parent completion waits for confirmation of child Linear updates', async t => {
  const f = await fixture(t);
  await f.add('one', 'ENG-2'); await f.approve();
  await f.app.linearAck('ENG-1', { issue: 'ENG-1', target: 'started', observed: 'started' });
  await f.update('one', 'done');
  const pending = (await f.sync()).pending;
  assert.deepEqual(pending.find(one => one.issue === 'ENG-1').waitingFor, ['ENG-2']);
  await assert.rejects(() => f.app.linearAck('ENG-1', { issue: 'ENG-1', target: 'completed', observed: 'completed' }), /linked task/);
  await f.app.linearAck('ENG-1', { issue: 'ENG-2', target: 'completed', observed: 'completed' });
  await f.app.linearAck('ENG-1', { issue: 'ENG-1', target: 'completed', observed: 'completed' });
  assert.deepEqual((await f.sync()).pending, []);
});

test('an API failure for a child defers the parent until the child retry succeeds', async t => {
  const remote = transport();
  let failChild = true;
  const f = await fixture(t, (query, variables) => {
    if (failChild && variables.id === 'ENG-2') throw new Error('Child cannot be read');
    return remote.api(query, variables);
  });
  await f.add('one', 'ENG-2'); await f.approve(); await f.sync();
  await f.update('one', 'done');
  const result = await f.sync();
  assert.equal(remote.current.get('ENG-1'), 'started');
  assert.deepEqual(result.pending.find(one => one.issue === 'ENG-1').waitingFor, ['ENG-2']);
  failChild = false;
  assert.deepEqual((await f.sync()).pending, []);
  assert.equal(remote.current.get('ENG-2'), 'completed');
  assert.equal(remote.current.get('ENG-1'), 'completed');
});

test('completed, canceled and duplicate tickets are not reopened', async t => {
  for (const state of ['completed', 'canceled', 'duplicate']) {
    const remote = transport(); remote.current.set('ENG-1', state);
    const f = await fixture(t, remote.api);
    await f.add('one'); await f.approve();
    assert.deepEqual((await f.sync()).pending, []);
    assert.equal(remote.current.get('ENG-1'), state);
    assert.deepEqual(remote.writes, []);
  }
});

test('CLI approval automatically returns durable connector work without an API key', async t => {
  const f = await fixture(t);
  await f.add('one'); await f.app.apply('ENG-1', 'run_plan');
  const output = execFileSync(process.execPath, [cli, 'approve', '--root', f.root, '--run', 'ENG-1', '--caller', 'owner'], { encoding: 'utf8', env: { ...process.env, LINEAR_API_KEY: '' } });
  const result = JSON.parse(output);
  assert.equal(result.isError, false);
  assert.deepEqual(result.linear.pending, [{ issue: 'ENG-1', target: 'started' }]);
  assert.equal(f.app.load('ENG-1').codex.linear.issues['ENG-1'].target, 'started');
});

test('API credentials and rejected response bodies never enter synchronization output', async t => {
  const secret = 'secret-not-for-the-ledger';
  const api = linearApiFromEnvironment({ LINEAR_API_KEY: secret }, async (_url, options) => {
    assert.equal(options.headers.Authorization, secret);
    return { ok: true, json: async () => ({ errors: [{ message: secret }] }) };
  });
  const f = await fixture(t, api);
  await f.add('one'); await f.approve();
  const result = await f.sync();
  assert.equal(result.pending.length, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(f.app.load('ENG-1')).includes(secret), false);
});
