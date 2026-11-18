import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildSkill } from '../build.mjs';
const built = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-callers-built-'));
const skillPath = buildSkill(path.join(built, 'conductor'));
const callers = await import(pathToFileURL(path.join(skillPath, 'scripts', 'callers.mjs')).href);
const { issueCaller, resolveCaller, revokeCaller, callerMay } = callers;
const cli = path.join(skillPath, 'scripts', 'conductor.mjs');
process.on('exit', () => fs.rmSync(built, { recursive: true, force: true }));

const hours = n => new Date(Date.now() + n * 3600_000).toISOString();
const orchestrator = (run = 'run') => ({ kind: 'orchestrator', department: 'engineering', run, expiresAt: hours(12) });
const worker = (task, run = 'run') => ({ kind: 'worker', department: 'engineering', run, task, expiresAt: hours(12) });
const decider = (department = 'engineering') => ({ kind: 'decider', department, agent: 'lead-a', expiresAt: hours(24) });
const dispatcher = (department = 'engineering') => ({ kind: 'dispatcher', department, expiresAt: hours(1) });
const start = { id: 'run', source: 'Test request', title: 'Test run', department: 'engineering' };

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-callers-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project');
  fs.mkdirSync(root);
  const home = path.join(parent, 'state');
  const dir = path.join(parent, 'callers');
  const ledger = path.join(home, 'runs/run/ledger.json');
  const call = (command, { token, input, run = 'run', extra = [] } = {}) => {
    const args = [cli, command, '--root', root, '--home', home, '--callers', dir, ...(run ? ['--run', run] : []), ...extra];
    let file;
    if (input) { file = path.join(parent, `input-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, JSON.stringify(input)); args.push('--input', file); }
    const env = { ...process.env }; delete env.CONDUCTOR_TOKEN;
    if (token !== undefined) env.CONDUCTOR_TOKEN = token;
    const done = spawnSync(process.execPath, args, { encoding: 'utf8', env });
    return { status: done.status, out: done.stdout, err: done.stderr, all: done.stdout + done.stderr };
  };
  return { parent, root, home, dir, ledger, call };
}
async function started(t) {
  const f = fixture(t);
  const token = issueCaller(f.dir, orchestrator());
  const made = f.call('conduct', { token, input: start, run: undefined });
  assert.equal(made.status, 0, made.all);
  const added = f.call('task_add', { token, input: { id: 'a', title: 'Task a', tier: 'sonnet', tierReason: 'Implementation task', files: ['a.txt'] } });
  assert.equal(added.status, 0, added.all);
  return { ...f, token };
}

test('a caller the folder does not prove is refused', async t => {
  const f = await started(t);
  const stranger = crypto.randomBytes(32).toString('hex');
  const expired = issueCaller(f.dir, { ...orchestrator(), expiresAt: new Date(Date.now() - 1000).toISOString() });
  const revoked = issueCaller(f.dir, orchestrator());
  revokeCaller(f.dir, revoked);
  const cases = [
    ['no token', undefined, []],
    ['a made-up token', stranger, []],
    ['an expired record', expired, []],
    ['a revoked token', revoked, []],
    ['a worker token used for another task', issueCaller(f.dir, worker('b')), [], 'task_update', { task: 'a', note: 'x' }],
    ['an orchestrator token of another run', issueCaller(f.dir, orchestrator('other')), []],
    ['--caller owner together with --callers', f.token, ['--caller', 'owner']],
  ];
  const before = fs.readFileSync(f.ledger);
  const input = { id: 'c', title: 'Task c', tier: 'sonnet', tierReason: 'Implementation task', files: ['c.txt'] };
  for (const [name, token, extra, command = 'task_add', body = input] of cases) {
    const done = f.call(command, { token, input: body, extra });
    assert.notEqual(done.status, 0, `${name}: refused`);
    assert.match(done.err, /isError/, name);
    for (const secret of [token, stranger, f.token].filter(Boolean)) assert.equal(done.all.includes(secret), false, `${name}: the refusal holds no token text`);
    assert.deepEqual(fs.readFileSync(f.ledger), before, `${name}: the ledger is unchanged`);
  }
  assert.equal(f.call('task_add', { token: f.token, input }).status, 0, 'the proven orchestrator still works');
});

test('a proven caller reads a token only from its record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callers-unit-'));
  try {
    const token = issueCaller(dir, decider());
    assert.deepEqual({ ...resolveCaller(dir, token, new Date()) }.agent, 'lead-a');
    assert.ok(resolveCaller(dir, undefined, new Date()).refused);
    assert.ok(resolveCaller(dir, 'not-hex', new Date()).refused);
    assert.ok(resolveCaller(dir, token, new Date(Date.now() + 25 * 3600_000)).refused, 'a decider record lapses');
    revokeCaller(dir, token);
    assert.ok(resolveCaller(dir, token, new Date()).refused);
    revokeCaller(dir, token);
    assert.throws(() => issueCaller(dir, { kind: 'worker', department: 'engineering', run: 'run', expiresAt: hours(1) }), /task/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const ctx = { run: 'run', department: undefined, runCallers: { department: 'engineering' } };
const may = (record, command, input = {}) => callerMay(record, command, { ...ctx, input });
const rows = [
  // [command, input, allowed record, refused record]
  ['init', {}, orchestrator(), worker('a')],
  ['board_open', {}, orchestrator(), decider()],
  ['board_close', {}, orchestrator(), dispatcher()],
  ['task_add', {}, orchestrator(), worker('a')],
  ['run_plan', {}, orchestrator(), decider()],
  ['worktree', {}, orchestrator(), worker('a')],
  ['merge_check', {}, orchestrator(), worker('a')],
  ['merge', {}, orchestrator(), dispatcher()],
  ['run_sync_base', {}, orchestrator(), worker('a')],
  ['run_check', {}, orchestrator(), decider()],
  ['handover', {}, orchestrator(), worker('a')],
  ['reconcile', {}, orchestrator(), decider()],
  ['quarantine', {}, orchestrator(), dispatcher()],
  ['board_rule', {}, orchestrator(), worker('a')],
  ['problem_report', {}, orchestrator(), decider()],
  ['problem_assign', {}, orchestrator(), worker('a')],
  ['problem_resolve', {}, orchestrator(), dispatcher()],
  ['brief', { task: 'b' }, orchestrator(), worker('a')],
  ['brief', { task: 'a' }, worker('a'), worker('b')],
  ['task_update', { task: 'b', files: ['x'] }, orchestrator(), worker('a')],
  ['task_update', { task: 'a', status: 'review' }, worker('a'), worker('b')],
  ['task_update', { task: 'a', status: 'green' }, orchestrator(), worker('a')],
  ['board_post', {}, worker('a'), decider()],
  ['approve', {}, decider(), worker('a')],
  ['approve_main', {}, dispatcher(), orchestrator()],
  ['approve_merge', {}, decider(), orchestrator()],
  ['tier', {}, decider(), worker('a')],
  ['model_policy', {}, dispatcher(), orchestrator()],
  ['pause', {}, decider(), orchestrator()],
  ['unpause', {}, dispatcher(), worker('a')],
  ['run_merge_main', {}, dispatcher(), decider()],
  ['merged', {}, dispatcher(), orchestrator()],
  ['conduct', { id: 'run', department: 'engineering' }, orchestrator(), decider()],
];
test('each command takes only its callers', () => {
  for (const [command, input, allowed, refused] of rows) {
    assert.equal(may(allowed, command, input), true, `${command}: ${allowed.kind} may`);
    const verdict = may(refused, command, input);
    assert.equal(typeof verdict.refused, 'string', `${command}: ${refused.kind} may not`);
  }
  for (const command of ['linear_sync', 'linear_ack']) for (const record of [orchestrator(), worker('a'), decider(), dispatcher()]) assert.ok(may(record, command).refused, `${command}: nobody`);
  for (const command of ['list', 'board', 'digest']) assert.equal(callerMay({ refused: 'x' }, command, ctx), true, `${command}: anyone`);
  assert.ok(may(orchestrator(), 'no_such_command').refused, 'a command not in the map is refused');
});

test('a record of another run, task or department does not reach this run', () => {
  assert.ok(may(orchestrator('other'), 'task_add').refused);
  assert.ok(may(worker('a', 'other'), 'board_post').refused);
  assert.ok(may(decider('art'), 'approve').refused);
  assert.ok(may(dispatcher('art'), 'pause').refused);
  assert.ok(may(orchestrator(), 'conduct', { id: 'other', department: 'engineering' }).refused);
  assert.ok(may(orchestrator(), 'conduct', { id: 'run', department: 'art' }).refused);
  assert.ok(may(orchestrator(), 'conduct', { id: 'run' }).refused);
  assert.ok(callerMay(orchestrator(), 'task_add', { run: 'run', input: {} }).refused, 'a run made without callers takes no proven caller');
});

test('a run created with callers refuses a call without them', async t => {
  const f = await started(t);
  const run = JSON.parse(fs.readFileSync(f.ledger, 'utf8'));
  assert.deepEqual(run.run.callers, { department: 'engineering' });
  const before = fs.readFileSync(f.ledger);
  const done = spawnSync(process.execPath, [cli, 'pause', '--root', f.root, '--home', f.home, '--run', 'run', '--caller', 'owner'], { encoding: 'utf8' });
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /requires proven callers/);
  assert.deepEqual(fs.readFileSync(f.ledger), before);
  const peek = spawnSync(process.execPath, [cli, 'board', '--root', f.root, '--home', f.home, '--run', 'run'], { encoding: 'utf8' });
  assert.equal(peek.status, 0, 'reading the board needs no token');
  const decided = f.call('pause', { token: issueCaller(f.dir, decider()) });
  assert.equal(decided.status, 0, decided.all);
  assert.ok(JSON.parse(fs.readFileSync(f.ledger, 'utf8')).run.pausedAt, 'a decider of the department pauses it');
});

test('conduct with callers needs a department', t => {
  const f = fixture(t);
  const token = issueCaller(f.dir, orchestrator());
  const done = f.call('conduct', { token, input: { id: 'run', source: 'x', title: 't' }, run: undefined });
  assert.notEqual(done.status, 0);
  assert.match(done.err, /department/);
  assert.equal(fs.existsSync(f.ledger), false);
});

test('records are stored by hash with mode 0600', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callers-store-'));
  try {
    const record = decider();
    const token = issueCaller(dir, record);
    assert.match(token, /^[0-9a-f]{64}$/);
    const name = crypto.createHash('sha256').update(token).digest('hex') + '.json';
    assert.deepEqual(fs.readdirSync(dir), [name], 'one file, named by the hash, no temp file left');
    assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8').includes(token), false, 'the token is in no file');
    assert.equal(resolveCaller(dir, token, new Date()).department, 'engineering');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
