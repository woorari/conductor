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
const { issueCaller, resolveCaller, revokeCaller, callerMay, decisionMay, callersFolder, callersBound, withAgent } = callers;
const { Conductor } = await import(pathToFileURL(path.join(skillPath, 'scripts', 'conductor.mjs')).href);
const cli = path.join(skillPath, 'scripts', 'conductor.mjs');
process.on('exit', () => fs.rmSync(built, { recursive: true, force: true }));

const hours = n => new Date(Date.now() + n * 3600_000).toISOString();
const orchestrator = (run = 'run') => ({ kind: 'orchestrator', department: 'engineering', run, expiresAt: hours(12) });
const worker = (task, run = 'run') => ({ kind: 'worker', department: 'engineering', run, task, expiresAt: hours(12) });
const decider = (department = 'engineering') => ({ kind: 'decider', department, agent: 'lead-a', expiresAt: hours(24) });
const dispatcher = (department = 'engineering', person) => ({ kind: 'dispatcher', department, ...(person === undefined ? {} : { person }), expiresAt: hours(1) });
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
  ['worktree', { task: 'a' }, dispatcher(), worker('a')],
  ['worktree', { task: 'a' }, dispatcher(), decider()],
  ['merge_check', {}, orchestrator(), worker('a')],
  ['merge', {}, orchestrator(), dispatcher()],
  ['run_sync_base', {}, orchestrator(), worker('a')],
  ['run_check', {}, orchestrator(), decider()],
  ['handover', {}, orchestrator(), worker('a')],
  ['reconcile', {}, orchestrator(), decider()],
  ['quarantine', {}, worker('a'), orchestrator()],
  ['board_rule', {}, orchestrator(), worker('a')],
  ['problem_report', {}, orchestrator(), decider()],
  ['problem_assign', {}, orchestrator(), worker('a')],
  ['problem_resolve', {}, orchestrator(), dispatcher()],
  ['brief', { task: 'b' }, orchestrator(), worker('a')],
  ['brief', { task: 'a' }, worker('a'), worker('b')],
  ['task_update', { task: 'b', files: ['x'] }, orchestrator(), worker('a')],
  ['task_update', { task: 'a', status: 'review' }, worker('a'), worker('b')],
  ['task_update', { task: 'a', status: 'green' }, orchestrator(), worker('a')],
  ['task_update', { task: 'a', status: 'returned' }, dispatcher(), decider()],
  ['task_update', { task: 'a', status: 'blocked', note: 'No slot' }, dispatcher(), decider()],
  ['board_post', {}, worker('a'), decider()],
  ['board_post', {}, orchestrator(), dispatcher()],
  ['approve', {}, decider(), worker('a')],
  ['approve_main', {}, dispatcher(), orchestrator()],
  ['approve_merge', {}, decider(), orchestrator()],
  ['tier', {}, decider(), worker('a')],
  ['model_policy', {}, dispatcher(), orchestrator()],
  ['pause', {}, decider(), orchestrator()],
  ['unpause', {}, dispatcher(), worker('a')],
  ['run_merge_main', {}, dispatcher(), decider()],
  ['run_merge_main', {}, orchestrator(), worker('a')],
  ['run_merge_main', {}, orchestrator(), orchestrator('other')],
  ['run_merge_main', {}, dispatcher(), worker('a')],
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

test('a dispatcher may reserve a worker with worktree', () => {
  assert.equal(may(dispatcher(), 'worktree', { task: 'a' }), true);
  assert.ok(may(dispatcher(), 'worktree', { task: 'a', tier: 'opus' }).refused, 'worktree takes the task and nothing else');
  assert.ok(may(dispatcher(), 'worktree', {}).refused, 'worktree names its task');
  assert.ok(may(dispatcher(), 'worktree', { task: 7 }).refused, 'the task is a name');
});

test('a dispatcher sets a task returned or blocked and nothing else', () => {
  for (const status of ['returned', 'blocked']) assert.equal(may(dispatcher(), 'task_update', { task: 'a', status }), true, status);
  assert.equal(may(dispatcher(), 'task_update', { task: 'a', status: 'blocked', note: 'No slot' }), true, 'with a note');
  assert.ok(may(dispatcher(), 'task_update', { task: 'a' }).refused, 'a status is required');
  assert.ok(may(dispatcher(), 'task_update', { task: 'a', note: 'only a note' }).refused, 'a note alone is not enough');
  assert.ok(may(dispatcher(), 'task_update', { status: 'returned' }).refused, 'the task is named');
});

test('a dispatcher cannot set building, review, green, done or failed', () => {
  for (const status of ['building', 'review', 'green', 'done', 'failed', 'queued', 'nonsense']) {
    assert.ok(may(dispatcher(), 'task_update', { task: 'a', status }).refused, status);
  }
});

test('a dispatcher task_update with files, dependsOn, tier, agent or effort is refused', () => {
  const extra = { files: ['x'], dependsOn: ['b'], tier: 'opus', agent: 'x', effort: 'high', tierReason: 'r', pr: 1, branch: 'b', revision: REV('a'), scopeReason: 's' };
  for (const [key, value] of Object.entries(extra)) {
    assert.ok(may(dispatcher(), 'task_update', { task: 'a', status: 'returned', [key]: value }).refused, key);
  }
});

test('a dispatcher of another department or run is refused', () => {
  assert.ok(may(dispatcher('art'), 'worktree', { task: 'a' }).refused);
  assert.ok(may(dispatcher('art'), 'task_update', { task: 'a', status: 'returned' }).refused);
  assert.ok(may({ ...dispatcher(), run: 'other' }, 'worktree', { task: 'a' }).refused);
  assert.ok(may({ ...dispatcher(), run: 'other' }, 'task_update', { task: 'a', status: 'blocked' }).refused);
  assert.equal(may({ ...dispatcher(), run: 'run' }, 'worktree', { task: 'a' }), true, 'a record bound to this run reaches it');
});

test('a worker still may not call worktree, and a dispatcher still may not call the rest of the orchestrator gate', () => {
  assert.ok(may(worker('a'), 'worktree', { task: 'a' }).refused);
  for (const command of ['merge', 'merge_check', 'handover', 'run_sync_base', 'run_check', 'reconcile', 'linear_sync', 'linear_ack', 'task_add', 'run_plan', 'init', 'board_open']) {
    assert.ok(may(dispatcher(), command, { task: 'a' }).refused, command);
  }
});

test('a dispatcher reserves a worker and returns or blocks its task through the command', async t => {
  const f = await proposed(t);
  const git = (...args) => spawnSync('git', ['-C', f.root, ...args], { encoding: 'utf8' });
  assert.equal(git('init', '-b', 'main').status, 0);
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(f.root, 'source.txt'), 'x\n');
  git('add', 'source.txt');
  assert.equal(git('commit', '-m', 'initial').status, 0);
  const dispatch = issueCaller(f.dir, dispatcher());
  assert.equal(f.call('approve', { token: issueCaller(f.dir, decider()), input: { planSha256: f.hash, decision: asDecider('D-1') } }).status, 0);
  const worktree = f.call('worktree', { token: dispatch, input: { task: 'a' } });
  assert.equal(worktree.status, 0, worktree.all);
  assert.equal(ledgerOf(f).tasks[0].status, 'building');
  const returned = f.call('task_update', { token: dispatch, input: { task: 'a', status: 'returned', note: 'Spawn failed' } });
  assert.equal(returned.status, 0, returned.all);
  assert.equal(ledgerOf(f).tasks[0].status, 'returned');
  assert.match(ledgerOf(f).tasks[0].activity.text, /^Dispatcher: /);
  const again = f.call('worktree', { token: dispatch, input: { task: 'a' } });
  assert.equal(again.status, 0, again.all);
  assert.equal(ledgerOf(f).tasks[0].status, 'building', 'a returned task starts again');
  const blocked = f.call('task_update', { token: dispatch, input: { task: 'a', status: 'blocked', note: 'No slot' } });
  assert.equal(blocked.status, 0, blocked.all);
  assert.equal(ledgerOf(f).tasks[0].status, 'blocked');
  const before = fs.readFileSync(f.ledger);
  for (const input of [{ task: 'a', status: 'green' }, { task: 'a', status: 'returned', files: ['z.txt'], scopeReason: 'r' }, { task: 'a', status: 'returned', tier: 'opus' }]) {
    assert.notEqual(f.call('task_update', { token: dispatch, input }).status, 0, JSON.stringify(input));
  }
  assert.deepEqual(fs.readFileSync(f.ledger), before, 'a refused call writes nothing');
  for (const command of ['merge', 'handover', 'run_sync_base', 'merge_check']) {
    const done = f.call(command, { token: dispatch, input: { task: 'a' } });
    assert.notEqual(done.status, 0, command);
  }
  const refused = f.call('worktree', { token: issueCaller(f.dir, worker('a')), input: { task: 'a' } });
  assert.notEqual(refused.status, 0, 'a worker may not reserve');
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
  assert.deepEqual(run.run.callers, { department: 'engineering', dir: fs.realpathSync(f.dir) });
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

// Gates: the plan hash and approvals by a recorded decision.
const HASH = /[0-9a-f]{64}/;
const REV = ch => ch.repeat(64);
const asDecider = (ref, extra = {}) => ({ by: 'decider:engineering', agent: 'lead-a', ref, ...extra });
const ledgerOf = f => JSON.parse(fs.readFileSync(f.ledger, 'utf8'));
async function proposed(t) {
  const f = await started(t);
  const app = new Conductor(f.root, { home: f.home, callers: f.dir });
  const plan = await app.apply('run', 'run_plan', {}, { kind: 'orchestrator' });
  assert.equal(plan.isError, false, plan.text);
  return { ...f, app, plan, orchestrator: f.token, hash: plan.planSha256 };
}

test('run_plan and digest output the plan hash, and digest the facts of the run', async t => {
  const f = await proposed(t);
  assert.match(f.hash, /^[0-9a-f]{64}$/);
  const read = f.call('digest', { token: issueCaller(f.dir, decider()) });
  assert.equal(read.status, 0, read.all);
  assert.ok(read.out.includes(`Plan sha256: ${f.hash}`));
  for (const piece of ['Department: engineering', 'Delivery:', 'Check:']) assert.ok(read.out.includes(piece), piece);
  const plain = spawnSync(process.execPath, [cli, 'digest', '--root', f.root, '--home', f.home, '--run', 'run', '--caller', 'worker:a'], { encoding: 'utf8' });
  assert.equal(plain.status, 0, 'a call without --callers still reads');
  assert.equal(plain.stdout.includes('Plan sha256'), false, 'and prints what it printed before');
});

test('a decider approval is recorded and the board shows who decided', async t => {
  const f = await proposed(t);
  const token = issueCaller(f.dir, decider());
  const done = f.call('approve', { token, input: { planSha256: f.hash, delivery: 'review-only', decision: asDecider('D-1') } });
  assert.equal(done.status, 0, done.all);
  const run = ledgerOf(f).run;
  assert.equal(run.plan, 'approved');
  assert.equal(run.delivery, 'review-only');
  assert.deepEqual({ ...run.decisions.plan, at: undefined }, { by: 'decider:engineering', agent: 'lead-a', ref: 'D-1', sha256: f.hash, delivery: 'review-only', at: undefined });
  assert.ok(Date.parse(run.decisions.plan.at) > 0, 'the time is the CI\'s own');
  const board = spawnSync(process.execPath, [cli, 'board', '--root', f.root, '--home', f.home, '--run', 'run'], { encoding: 'utf8' });
  for (const piece of ['decider:engineering', 'lead-a', 'D-1', f.hash]) assert.ok(board.stdout.includes(piece), `the board shows ${piece}`);
  assert.ok(f.call('digest', { token }).out.includes('D-1'));
  const handover = f.call('handover', { token: f.orchestrator });
  assert.equal(handover.status, 0, handover.all);
  assert.ok(fs.readFileSync(path.join(f.home, 'runs/run/handover.md'), 'utf8').includes('D-1'));
});

test('a stale plan hash is refused and the plan stays proposed', async t => {
  const f = await proposed(t);
  const added = f.call('task_add', { token: f.orchestrator, input: { id: 'b', title: 'Task b', tier: 'sonnet', tierReason: 'Implementation task', files: ['b.txt'] } });
  assert.equal(added.status, 0, added.all);
  const before = fs.readFileSync(f.ledger);
  const done = f.call('approve', { token: issueCaller(f.dir, decider()), input: { planSha256: f.hash, decision: asDecider('D-1') } });
  assert.notEqual(done.status, 0);
  assert.ok(done.err.includes(f.hash), 'names the hash that was approved');
  assert.equal(done.err.match(new RegExp(HASH, 'g')).length >= 2, true, 'and the hash the plan has now');
  assert.deepEqual(fs.readFileSync(f.ledger), before);
  assert.equal(ledgerOf(f).run.plan, 'proposed');
  const fresh = f.call('digest', { token: f.orchestrator }).out.match(/Plan sha256: ([0-9a-f]{64})/)[1];
  assert.notEqual(fresh, f.hash);
  assert.equal(f.call('approve', { token: issueCaller(f.dir, decider()), input: { planSha256: fresh, decision: asDecider('D-2') } }).status, 0);
});

test('a proven approval carries the hash and a decision bound to its caller', async t => {
  const f = await proposed(t);
  const token = issueCaller(f.dir, decider());
  const dispatch = issueCaller(f.dir, dispatcher('engineering', 'p1'));
  const person = { by: 'person:p1', ref: 'D-9' };
  const cases = [
    ['a decider without a decision', token, { planSha256: f.hash }],
    ['a decider without the hash', token, { decision: asDecider('D-1') }],
    ['a decider deciding as a person', token, { planSha256: f.hash, decision: person }],
    ['a decider deciding for another department', token, { planSha256: f.hash, decision: asDecider('D-1', { by: 'decider:art' }) }],
    ['a decision without a ref', token, { planSha256: f.hash, decision: { by: 'decider:engineering' } }],
    ['a dispatcher deciding as a decider', dispatch, { planSha256: f.hash, decision: asDecider('D-1') }],
    ['a dispatcher without a decision', dispatch, { planSha256: f.hash }],
    ['a dispatcher deciding as a bare person', dispatch, { planSha256: f.hash, decision: { by: 'person:', ref: 'D-9' } }],
  ];
  const before = fs.readFileSync(f.ledger);
  for (const [name, who, input] of cases) {
    const done = f.call('approve', { token: who, input });
    assert.notEqual(done.status, 0, `${name}: refused`);
    assert.deepEqual(fs.readFileSync(f.ledger), before, `${name}: the ledger is unchanged`);
  }
  const done = f.call('approve', { token: dispatch, input: { planSha256: f.hash, decision: person } });
  assert.equal(done.status, 0, done.all);
  assert.equal(ledgerOf(f).run.decisions.plan.by, 'person:p1');
  assert.equal(ledgerOf(f).run.decisions.plan.agent, undefined);
});

test('without --callers a hash is checked and a decision recorded when given, and nothing is needed', async t => {
  const f = fixture(t);
  const plain = (command, input, extra = []) => {
    const file = path.join(f.parent, `in-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(input ?? {}));
    return spawnSync(process.execPath, [cli, command, '--root', f.root, '--home', f.home, '--run', 'run', '--input', file, ...extra], { encoding: 'utf8' });
  };
  const made = spawnSync(process.execPath, [cli, 'conduct', '--root', f.root, '--home', f.home, '--input', (() => { const file = path.join(f.parent, 'start.json'); fs.writeFileSync(file, JSON.stringify({ id: 'run', source: 'Test request', title: 'Test run' })); return file; })()], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  assert.equal(plain('task_add', { id: 'a', title: 'Task a', tier: 'sonnet', tierReason: 'Implementation task', files: ['a.txt'] }).status, 0);
  const app = new Conductor(f.root, { home: f.home });
  const plan = await app.apply('run', 'run_plan', {}, { kind: 'orchestrator' });
  const stale = plain('approve', { planSha256: REV('0') }, ['--caller', 'owner']);
  assert.notEqual(stale.status, 0);
  assert.equal(ledgerOf(f).run.plan, 'proposed');
  const done = plain('approve', { planSha256: plan.planSha256, decision: { by: 'person:p1', ref: 'D-3' } }, ['--caller', 'owner']);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(ledgerOf(f).run.decisions.plan.ref, 'D-3');
});

test('approve with no hash and no decision is the typed approve, and records no decision', async t => {
  const f = fixture(t);
  const app = new Conductor(f.root, { home: f.home });
  await app.conduct({ id: 'run', source: 'Test request', title: 'Test run' });
  await app.apply('run', 'task_add', { id: 'a', title: 'Task a', tier: 'sonnet', tierReason: 'Implementation task', files: ['a.txt'] });
  await app.apply('run', 'run_plan');
  const done = await app.apply('run', 'approve', {}, { kind: 'owner' });
  assert.equal(done.isError, false, done.text);
  assert.equal(app.load('run').run.plan, 'approved');
  assert.equal('decisions' in app.load('run').run, false);
});

test('approve_main binds the revision the run branch is at', async t => {
  const f = await proposed(t);
  const dispatch = issueCaller(f.dir, dispatcher('engineering', 'p1'));
  const raw = ledgerOf(f);
  raw.run.lore = { remote: 'lores://example.test', repository: 'game', base: 'main', branch: 'run/run', head: REV('c'), baseAt: REV('d') };
  fs.writeFileSync(f.ledger, JSON.stringify(raw, null, 2) + '\n');
  const person = { by: 'person:p1', ref: 'D-4' };
  const before = fs.readFileSync(f.ledger);
  for (const [name, who, input] of [
    ['another revision', dispatch, { revision: REV('e'), base: REV('d'), decision: person }],
    ['no decision', dispatch, { revision: REV('c'), base: REV('d') }],
    ['a decider as a person', issueCaller(f.dir, decider()), { revision: REV('c'), base: REV('d'), decision: person }],
  ]) {
    const done = f.call('approve_main', { token: who, input });
    assert.notEqual(done.status, 0, `${name}: refused`);
    assert.deepEqual(fs.readFileSync(f.ledger), before, `${name}: the ledger is unchanged`);
  }
  const done = f.call('approve_main', { token: dispatch, input: { revision: REV('c'), base: REV('d'), decision: person } });
  assert.equal(done.status, 0, done.all);
  const run = ledgerOf(f).run;
  assert.equal(run.approval.revision, REV('c'));
  assert.deepEqual({ ...run.decisions.main, at: undefined }, { ...person, revision: REV('c'), base: REV('d'), at: undefined });
  const board = spawnSync(process.execPath, [cli, 'board', '--root', f.root, '--home', f.home, '--run', 'run'], { encoding: 'utf8' });
  assert.ok(board.stdout.includes('D-4') && board.stdout.includes(REV('c')));
});

test('a decision is checked against its caller by one function', () => {
  const run = { department: 'engineering' };
  const ask = (record, command, input) => decisionMay(record, command, { input, runCallers: run });
  const good = { planSha256: REV('a'), decision: asDecider('D-1') };
  assert.equal(ask(decider(), 'approve', good), true);
  assert.equal(ask(dispatcher('engineering', 'p1'), 'approve', { planSha256: REV('a'), decision: { by: 'person:p1', ref: 'D-1' } }), true);
  assert.equal(ask(decider(), 'approve_main', { revision: REV('c'), base: REV('d'), decision: asDecider('D-1') }), true);
  assert.equal(ask(orchestrator(), 'approve', {}), true, 'only deciders and dispatchers are bound; callerMay refuses the rest');
  assert.equal(ask(decider(), 'pause', {}), true, 'only approve and approve_main carry a decision');
  assert.equal(decisionMay(null, 'approve', { input: {}, runCallers: undefined }), true, 'no --callers, nothing is required');
  assert.ok(ask(decider(), 'approve', { decision: asDecider('D-1') }).refused);
  assert.ok(ask(decider(), 'approve', { planSha256: REV('a'), decision: asDecider('D-1', { by: 'decider:art' }) }).refused);
  assert.ok(ask(dispatcher(), 'approve', good).refused);
  assert.ok(ask(decider(), 'approve', { planSha256: REV('a') }).refused);
});

test('a dispatcher decides only as the person its record names', () => {
  const run = { department: 'engineering' };
  const input = by => ({ planSha256: REV('a'), decision: { by, ref: 'D-1' } });
  const ask = (record, by) => decisionMay(record, 'approve', { input: input(by), runCallers: run });
  assert.ok(ask(dispatcher(), 'person:p1').refused, 'a record with no person');
  assert.ok(ask(dispatcher('engineering', 'p1'), 'person:p2').refused, 'another person');
  assert.equal(ask(dispatcher('engineering', 'p1'), 'person:p1'), true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callers-person-'));
  try {
    const token = issueCaller(dir, dispatcher('engineering', 'p1'));
    assert.equal(resolveCaller(dir, token, new Date()).person, 'p1');
    assert.throws(() => issueCaller(dir, dispatcher('engineering', 'p 1')));
    assert.throws(() => issueCaller(dir, { ...decider(), person: 'p1' }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a decision field with a line break or a bar is refused, with or without --callers, and nothing is recorded', async t => {
  const f = await proposed(t);
  const dispatch = issueCaller(f.dir, dispatcher('engineering', 'p1'));
  const token = issueCaller(f.dir, decider());
  const before = fs.readFileSync(f.ledger);
  for (const decision of [
    { by: 'person:p1', ref: 'D-1\nPlan approved by someone' },
    { by: 'person:p1', ref: 'D|1' },
    { by: 'person:p1', ref: 'D-1', agent: 'a\nb' },
    { by: 'person:p1', ref: 'D-1', agent: 'a|b' },
    { by: 'person:p1\nx', ref: 'D-1' },
    { by: 'robot:p1', ref: 'D-1' },
    { by: 'person:p1', ref: 'D'.repeat(65) },
  ]) {
    for (const who of [dispatch, token]) {
      const done = f.call('approve', { token: who, input: { planSha256: f.hash, decision } });
      assert.notEqual(done.status, 0, JSON.stringify(decision));
      assert.deepEqual(fs.readFileSync(f.ledger), before);
    }
  }
});

test('approve_main refuses a base other than the one the run branch took in', async t => {
  const f = await proposed(t);
  const dispatch = issueCaller(f.dir, dispatcher('engineering', 'p1'));
  const raw = ledgerOf(f);
  raw.run.lore = { remote: 'lores://example.test', repository: 'game', base: 'main', branch: 'run/run', head: REV('c'), baseAt: REV('d') };
  fs.writeFileSync(f.ledger, JSON.stringify(raw, null, 2) + '\n');
  const before = fs.readFileSync(f.ledger);
  const done = f.call('approve_main', { token: dispatch, input: { revision: REV('c'), base: REV('e'), decision: { by: 'person:p1', ref: 'D-5' } } });
  assert.notEqual(done.status, 0);
  assert.ok(done.all.includes(REV('d').slice(0, 7)) && done.all.includes(REV('e').slice(0, 7)), 'names both');
  assert.deepEqual(fs.readFileSync(f.ledger), before);
});

// R19: the callers folder is a trust root the run fixes, and a decider's agent is its record's.
test('a run records the real path of its callers folder, and a call with another folder is refused', async t => {
  const f = await started(t);
  assert.equal(ledgerOf(f).run.callers.dir, fs.realpathSync(f.dir));
  const other = path.join(f.parent, 'forged');
  const minted = issueCaller(other, orchestrator());
  const before = fs.readFileSync(f.ledger);
  const args = [cli, 'task_add', '--root', f.root, '--home', f.home, '--callers', other, '--run', 'run', '--input', path.join(f.parent, 'in.json')];
  fs.writeFileSync(path.join(f.parent, 'in.json'), JSON.stringify({ id: 'c', title: 'Task c', tier: 'sonnet', tierReason: 'Implementation task', files: ['c.txt'] }));
  const done = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, CONDUCTOR_TOKEN: minted } });
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /callers folder/);
  assert.equal((done.stdout + done.stderr).includes(minted), false, 'the refusal holds no token text');
  assert.deepEqual(fs.readFileSync(f.ledger), before, 'the ledger is unchanged');
  const link = path.join(f.parent, 'link');
  fs.symlinkSync(f.dir, link);
  assert.equal(callersBound(callersFolder(link).dir, ledgerOf(f).run.callers), true, 'a link to the same folder is the same folder');
});

test('a callers folder others can write to, or that is not a folder, is no trust root', { skip: process.platform === 'win32' }, t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'callers-root-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const open = path.join(parent, 'open');
  fs.mkdirSync(open, { mode: 0o700 });
  assert.equal(typeof callersFolder(open).dir, 'string');
  fs.chmodSync(open, 0o770);
  assert.ok(callersFolder(open).refused, 'group-writable');
  fs.chmodSync(open, 0o707);
  assert.ok(callersFolder(open).refused, 'world-writable');
  assert.ok(callersFolder(path.join(parent, 'missing')).refused, 'missing');
  fs.writeFileSync(path.join(parent, 'file'), '');
  assert.ok(callersFolder(path.join(parent, 'file')).refused, 'a file');
  assert.ok(callersBound(fs.realpathSync(parent), { department: 'engineering' }).refused, 'a run that recorded no folder trusts none');
  assert.ok(callersBound(fs.realpathSync(parent), { department: 'engineering', dir: '/elsewhere' }).refused.includes('/elsewhere'));
});

test('a run is not conducted from a callers folder others can write to', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const token = issueCaller(f.dir, orchestrator());
  fs.chmodSync(f.dir, 0o777);
  const done = f.call('conduct', { token, input: start, run: undefined });
  assert.notEqual(done.status, 0);
  assert.equal(done.all.includes(token), false);
  assert.equal(fs.existsSync(f.ledger), false);
});

test('a decider decides as the agent its record names, and no other', async t => {
  const f = await proposed(t);
  const token = issueCaller(f.dir, decider());
  const before = fs.readFileSync(f.ledger);
  const refused = f.call('approve', { token, input: { planSha256: f.hash, decision: asDecider('D-1', { agent: 'lead-b' }) } });
  assert.notEqual(refused.status, 0);
  assert.deepEqual(fs.readFileSync(f.ledger), before);
  const none = { by: 'decider:engineering', ref: 'D-1' };
  const done = f.call('approve', { token, input: { planSha256: f.hash, decision: none } });
  assert.equal(done.status, 0, done.all);
  assert.equal(ledgerOf(f).run.decisions.plan.agent, 'lead-a', 'recorded from the record, not the input');
});

test('a decider with no agent in its record records none and cannot name one', () => {
  const run = { department: 'engineering' };
  const bare = { kind: 'decider', department: 'engineering' };
  const input = agent => ({ planSha256: REV('a'), decision: { by: 'decider:engineering', ref: 'D-1', ...(agent ? { agent } : {}) } });
  assert.equal(decisionMay(bare, 'approve', { input: input(), runCallers: run }), true);
  assert.ok(decisionMay(bare, 'approve', { input: input('lead-a'), runCallers: run }).refused);
  assert.equal(withAgent(bare, 'approve', input()).decision.agent, undefined);
  assert.equal(withAgent(decider(), 'approve', input()).decision.agent, 'lead-a');
  assert.deepEqual(withAgent(null, 'approve', input('x')), input('x'), 'without --callers the input stands');
});

test('run_merge_main: the run\'s orchestrator or a dispatcher; no call without --callers', async t => {
  const f = await started(t);
  const before = fs.readFileSync(f.ledger);
  // The orchestrator of the run passes the caller gate (a non-Lore run then refuses on its own account: it has no Lore branch).
  const orchestrated = f.call('run_merge_main', { token: f.token });
  assert.doesNotMatch(orchestrated.all, /may not run run_merge_main|needs --callers/);
  for (const [name, record] of [['a worker', worker('a')], ['a decider', decider()], ['another run\'s orchestrator', orchestrator('other')]]) {
    const refused = f.call('run_merge_main', { token: issueCaller(f.dir, record) });
    assert.notEqual(refused.status, 0, name);
  }
  for (const extra of [[], ['--caller', 'owner'], ['--caller', 'orchestrator']]) {
    const plain = spawnSync(process.execPath, [cli, 'run_merge_main', '--root', f.root, '--home', f.home, '--run', 'run', ...extra], { encoding: 'utf8' });
    assert.notEqual(plain.status, 0, `without --callers ${extra.join(' ')}`);
    assert.match(plain.stdout + plain.stderr, /requires proven callers/);
  }
  // A run made without callers is refused by the command's own sentence.
  const open = fixture(t);
  const file = path.join(open.parent, 'start.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'run', source: 'Test request', title: 'Test run' }));
  assert.equal(spawnSync(process.execPath, [cli, 'conduct', '--root', open.root, '--home', open.home, '--input', file], { encoding: 'utf8' }).status, 0);
  for (const extra of [[], ['--caller', 'owner'], ['--caller', 'orchestrator']]) {
    const plain = spawnSync(process.execPath, [cli, 'run_merge_main', '--root', open.root, '--home', open.home, '--run', 'run', ...extra], { encoding: 'utf8' });
    assert.notEqual(plain.status, 0, `no callers ${extra.join(' ')}`);
    assert.match(plain.stdout + plain.stderr, /needs --callers and the run's orchestrator or a dispatcher/);
  }
  assert.deepEqual(fs.readFileSync(f.ledger), before);
});
