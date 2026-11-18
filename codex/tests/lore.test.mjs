import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSkill } from '../build.mjs';
import { BRANCH_SWITCH, MERGE_CLEAN, MERGE_INTO_DONE, PROTECTED, PUSH_FIRST, PUSH_RUN, REPOSITORY_INFO, REV_MAIN, REV_ON_MAIN, REV_RUN, REV_T1, REV_T2, STATUS_CLEAN, UNPROTECTED, ZEROS } from '../../tests/lore-output.ts';

const built = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-lore-built-'));
const skillPath = buildSkill(path.join(built, 'conductor'));
const { Conductor } = await import(pathToFileURL(path.join(skillPath, 'scripts', 'conductor.mjs')).href);
process.on('exit', () => fs.rmSync(built, { recursive: true, force: true }));

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-lore.mjs');
const owner = { kind: 'owner' };
const RUN = 'eng/run-test-run';
const info = (name, latest, remote) => `Branch ${name}\n  ID: 01a1b056f6bb701783e7a1beb2aa49a0\n  Latest: ${latest}\n  Remote Latest: ${remote}\n  Created: Fri, 6 Nov 2026 10:10:51 +0000\n`;
const TABLE = [
  { match: 'repository info', out: REPOSITORY_INFO },
  { match: 'repository update-path' },
  { match: 'status --scan', out: STATUS_CLEAN },
  { match: 'branch switch', out: BRANCH_SWITCH },
  { match: 'branch info main', out: info('main', REV_MAIN, REV_MAIN) },
  { match: `branch info ${RUN}/a`, out: info(`${RUN}/a`, ZEROS, ZEROS) },
  { match: `branch info ${RUN}`, answers: [info(RUN, REV_MAIN, ZEROS), info(RUN, REV_MAIN, REV_MAIN)] },
  { match: 'branch create' },
  { match: 'push', out: PUSH_FIRST },
  { match: 'branch protect main', out: PROTECTED },
];

// The project's check: it writes where it ran and whether it saw a caller token, then passes, fails or hangs as check-mode.txt says.
const CHECK_PROGRAM = `import fs from 'node:fs';
import path from 'node:path';
const dir = path.dirname(process.argv[1]);
fs.writeFileSync(path.join(dir, 'check-seen.json'), JSON.stringify({ cwd: process.cwd(), token: process.env.CONDUCTOR_TOKEN ?? null }));
const file = path.join(dir, 'check-mode.txt');
const mode = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : 'pass';
if (mode === 'fail') { console.error('3 tests failed'); process.exit(1); }
if (mode === 'hang') setInterval(() => {}, 1000);
`;

// What the fake lore answers once the run is approved: one place for each call a merge, a check or a sync makes.
const statusAt = revision => `Repository 01a1b056c981721b88ecc4b6b66d6f45\nOn branch ${RUN} revision 3 -> ${revision}\nRemote revision 3 -> ${revision}\nLocal branch in sync with remote\nNo tracked changes\n`;
const MERGE_BASE = MERGE_CLEAN.replace(REV_T1, REV_ON_MAIN).replace(REV_RUN, REV_T2);
const PUSH_SYNC = PUSH_RUN.replaceAll(REV_RUN, REV_T2);
const after = (o = {}) => [
  { match: 'repository update-path' },
  { match: 'status --scan', out: STATUS_CLEAN },
  { match: 'status', out: statusAt(o.status ?? REV_RUN) },
  { match: 'branch switch', out: BRANCH_SWITCH },
  { match: `branch info ${RUN}/a`, out: info(`${RUN}/a`, REV_T1, o.task ?? REV_T1) },
  { match: `branch info ${RUN}`, out: info(RUN, o.runHead ?? REV_MAIN, o.runHead ?? REV_MAIN) },
  { match: 'branch info main', out: info('main', o.main ?? REV_MAIN, o.main ?? REV_MAIN) },
  { match: 'branch merge into main', out: o.into ?? MERGE_INTO_DONE },
  { match: 'branch merge abort' },
  { match: 'branch merge main', out: MERGE_BASE },
  { match: 'branch merge', out: o.merge ?? MERGE_CLEAN },
  { match: 'branch reset' },
  { match: 'push', out: o.push ?? PUSH_RUN },
  { match: 'lock release' },
  { match: 'branch unprotect main', out: UNPROTECTED },
  { match: 'branch protect main', ...(o.protectFails ? { exit: 1, err: 'Not authorized' } : { out: PROTECTED }) },
];

// A project home with one Lore place (a seed workspace) and the fake lore on LORE_BIN.
function fixture(t, { minFreeGB = 0, check = false } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-lore-test-'));
  const saved = Object.fromEntries(['LORE_BIN', 'FAKE_LORE_TABLE', 'FAKE_LORE_LOG', 'CONDUCTOR_TOKEN'].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const root = path.join(parent, 'project');
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const checkScript = path.join(parent, 'check.mjs');
  put(checkScript, CHECK_PROGRAM);
  const place = { folder: 'game-code', teams: ['ABC'], about: 'The game code.', lore: { branchPrefix: 'eng/', carry: ['Content'], minFreeGB }, ...(check ? { check: { argv: [process.execPath, checkScript], timeoutMin: 1 } } : {}) };
  put(path.join(root, '.claude/conductor/config.json'), JSON.stringify({ places: [place] }));
  const seed = path.join(root, 'game-code');
  put(path.join(seed, '.lore/state.txt'), 'lore state\n');
  put(path.join(seed, '.loreignore'), 'Saved/\nContent/\n*.log\n');
  put(path.join(seed, 'Source/a.cpp'), 'int a;\n');
  put(path.join(seed, 'Source/debug.log'), 'noise\n');
  put(path.join(seed, 'game.cfg'), 'cfg\n');
  put(path.join(seed, 'Saved/cache.bin'), 'cache\n');
  put(path.join(seed, 'Content/big.bin'), 'content\n');
  const table = path.join(parent, 'table.json');
  const log = path.join(parent, 'lore.log');
  fs.writeFileSync(table, JSON.stringify(TABLE));
  Object.assign(process.env, { LORE_BIN: FAKE, FAKE_LORE_TABLE: table, FAKE_LORE_LOG: log });
  const app = new Conductor(root, { home: path.join(parent, 'state') });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);

  // Another table from here on, and a log that counts from nothing again.
  const use = rows => { fs.writeFileSync(table, JSON.stringify(rows)); fs.rmSync(log, { force: true }); };
  const mode = how => fs.writeFileSync(path.join(parent, 'check-mode.txt'), how);
  const seen = () => JSON.parse(fs.readFileSync(path.join(parent, 'check-seen.json'), 'utf8'));

  return { app, parent, seed, calls, use, mode, seen, said: () => calls().map(call => call.args.join(' ')), workspaces: path.join(app.root, 'game-code.conductor') };
}

// A run on the place with one task, its plan proposed.
async function proposed(t, options) {
  const f = fixture(t, options);
  f.app.init();
  await f.app.conduct({ id: 'run', source: 'Test request', title: 'Test run', place: 'game-code' });
  await f.app.apply('run', 'task_add', { id: 'a', title: 'Task a', tier: 'sonnet', tierReason: 'Implementation task', files: ['a.txt'], dependsOn: [] });
  f.hash = (await f.app.apply('run', 'run_plan')).planSha256;

  return f;
}
const approve = app => app.apply('run', 'approve', {}, owner);
const DECIDED = { by: 'person:rene', ref: 'chat' };

// A run approved with a recorded decision, its task a started by a worker, handed back at REV_T1 and judged green.
async function green(t, options) {
  const f = await proposed(t, options);
  const approved = await f.app.apply('run', 'approve', { planSha256: f.hash, decision: DECIDED }, owner);
  assert.equal(approved.isError, false, approved.text);
  const made = await f.app.worktree('run', { task: 'a' });
  assert.equal(made.isError, false, made.text);
  const handed = await f.app.apply('run', 'task_update', { task: 'a', status: 'review', revision: REV_T1 });
  assert.equal(handed.isError, false, handed.text);
  const judged = await f.app.apply('run', 'task_update', { task: 'a', status: 'green' });
  assert.equal(judged.isError, false, judged.text);
  f.use(after({ status: REV_T1 }));

  return f;
}
const taskMerged = async f => {
  f.use(after({ runHead: REV_MAIN }));
  const merged = await f.app.github('run', { task: 'a' }, true);
  assert.equal(merged.isError, false, merged.text);
  f.use(after({ runHead: REV_RUN, status: REV_RUN }));
};

test('a Lore task gets a workspace copied from the place', async t => {
  const f = await proposed(t);
  assert.equal((await approve(f.app)).isError, false);
  const made = await f.app.worktree('run', { task: 'a' });
  assert.equal(made.isError, false, made.text);
  assert.equal(path.normalize(made.workspace), path.join(f.workspaces, 'run', 'a'));
  assert.equal(made.branch, `${RUN}/a`);
  const has = file => fs.existsSync(path.join(made.workspace, file));
  assert.ok(has('Source/a.cpp') && has('game.cfg') && has('.loreignore'), 'the tracked files are copied');
  assert.ok(has('Content/big.bin'), 'a carried folder is copied though it is ignored');
  assert.ok(!has('Saved'), 'an ignored folder is not copied');
  assert.ok(!has('Source/debug.log'), 'an ignored file inside a copied folder is removed');
  assert.ok(has('.lore/state.txt'), 'the copy keeps its lore state');
  assert.ok(!f.calls().some(call => call.args[0] === 'clone'), 'nothing is cloned from the server');
  const created = f.calls().find(call => call.args.join(' ') === `branch create ${RUN}/a`);
  assert.equal(fs.realpathSync(created.cwd), fs.realpathSync(made.workspace), 'the branch is made in the copy');
  const raw = f.app.load('run');
  assert.equal(raw.codex.workspaces.a, made.workspace);
  assert.equal(raw.tasks[0].branch, made.branch);
  assert.equal(raw.tasks[0].status, 'building');
});

test('no local workspace stops the run', async t => {
  const f = await proposed(t);
  // The ledger came from a machine that had the place; this one does not.
  fs.rmSync(path.join(f.seed, '.lore'), { recursive: true });
  const result = await approve(f.app);
  assert.equal(result.isError, true);
  assert.match(result.text, /game-code/);
  const raw = f.app.load('run');
  assert.equal(raw.run.plan, 'proposed', 'the plan is not approved');
  const problem = raw.problems.find(one => one.severity === 'blocker');
  assert.match(problem.text, /game-code/);
  assert.match(problem.text, /no local workspace exists on this machine/);
  assert.deepEqual(f.calls(), [], 'no lore call is made');
  assert.equal(raw.merge, undefined);
});

test('below the disk floor nothing is made', async t => {
  const f = await proposed(t, { minFreeGB: 100_000_000 });
  const result = await approve(f.app);
  assert.equal(result.isError, true);
  assert.match(result.text, /GB are free on the disk/);
  assert.match(result.text, /lore\.minFreeGB/);
  assert.equal(fs.existsSync(f.workspaces), false, 'no workspace is made');
  assert.deepEqual(f.calls(), [], 'no lore call is made');
  const raw = f.app.load('run');
  assert.equal(raw.run.plan, 'proposed');
  assert.equal(raw.merge, undefined, 'the approval claim is let go');
  // A worker's copy has its own floor: raised after the approval, the copy is refused and nothing stays.
  const g = await proposed(t);
  assert.equal((await approve(g.app)).isError, false);
  const later = g.app.load('run');
  later.run.config.lore.minFreeGB = 100_000_000;
  g.app.save('run', later);
  const before = g.said().length;
  const refused = await g.app.worktree('run', { task: 'a' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /GB are free/);
  assert.equal(fs.existsSync(path.join(g.workspaces, 'run', 'a')), false, 'the half-made folder is removed');
  assert.equal(g.said().length, before, 'no lore call is made for the copy');
  assert.equal(g.app.load('run').tasks[0].status, 'queued', 'the task is not left reserved');
});

test('the approval protects the base and makes the run workspace', async t => {
  const f = await proposed(t);
  const result = await approve(f.app);
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(f.said(), [
    'repository info',
    'repository update-path',
    'status --scan',
    'branch switch main --reset',
    `branch info ${RUN}`,
    `branch create ${RUN}`,
    'push',
    'branch protect main',
    'branch info main',
    `branch info ${RUN}`,
  ]);
  const raw = f.app.load('run');
  assert.equal(raw.run.plan, 'approved');
  const workspace = path.join(f.workspaces, 'run', '_run');
  assert.equal(path.normalize(raw.run.lore.workspace), workspace);
  assert.deepEqual({ ...raw.run.lore, workspace: undefined }, { remote: 'lores://lore.example.test:41337', repository: 'conductor-spike', base: 'main', branch: RUN, workspace: undefined, baseAt: REV_MAIN, head: REV_MAIN });
  assert.ok(fs.existsSync(path.join(workspace, '.lore/state.txt')) && fs.existsSync(path.join(workspace, 'Source/a.cpp')), 'the run workspace is a copy of the place');
  const protectedAt = f.calls().find(call => call.args[1] === 'protect');
  assert.equal(fs.realpathSync(protectedAt.cwd), fs.realpathSync(workspace), 'the base is protected from the run workspace');
  assert.equal(raw.merge, undefined, 'the approval claim is let go');
});

test('a worker starts only on an approved plan', async t => {
  const f = await proposed(t);
  const result = await f.app.worktree('run', { task: 'a' });
  assert.equal(result.isError, true);
  assert.match(result.text, /approv/i);
  assert.deepEqual(f.calls(), [], 'no lore call is made');
  assert.equal(fs.existsSync(f.workspaces), false, 'no workspace is made');
  assert.equal(f.app.load('run').tasks[0].status, 'queued');
});

test('on macOS a copy is a clone: cp -c -R, spawned with argv and no shell', async () => {
  const { nodeHost } = await import(pathToFileURL(path.join(skillPath, 'scripts', 'lore-host.mjs')).href);
  const asked = [];
  const host = nodeHost({ platform: 'darwin', program: async (file, args, cwd, ms) => { asked.push({ file, args, ms }); return { exitCode: 0, out: '', err: '' }; } });
  await host.copyTree('/from/place', '/to/copy', ['Source', 'game.cfg']);
  assert.deepEqual(asked.map(one => [one.file, ...one.args]), [['cp', '-c', '-R', '/from/place/Source', '/to/copy/'], ['cp', '-c', '-R', '/from/place/game.cfg', '/to/copy/']]);
  const failing = nodeHost({ platform: 'darwin', program: async () => ({ exitCode: 1, out: '', err: 'cp: no space left' }) });
  await assert.rejects(failing.copyTree('/a', '/b', ['X']), /X could not be copied: .*no space left/);
  // Another system keeps Node's own copy and spawns nothing.
  const other = nodeHost({ platform: 'linux', program: async () => { throw new Error('no program is spawned'); } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-copy-'));
  fs.mkdirSync(path.join(dir, 'from'));
  fs.writeFileSync(path.join(dir, 'from', 'f.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'to'));
  await other.copyTree(path.join(dir, 'from'), path.join(dir, 'to'), ['f.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'to', 'f.txt'), 'utf8'), 'x');
  fs.rmSync(dir, { recursive: true, force: true });
});

const said = (f, start) => f.said().some(one => one.startsWith(start));

test('a green task with a passed check lands on the run branch', async t => {
  const f = await green(t, { check: true });
  const early = await f.app.github('run', { task: 'a' }, true);
  assert.equal(early.isError, true);
  assert.match(early.text, /the check .* has not passed on 53f36f4/);
  assert.equal(said(f, 'branch merge'), false, 'nothing is merged before the check passed');
  const checked = await f.app.runCheck('run', { task: 'a' });
  assert.equal(checked.isError, false, checked.text);
  assert.equal(checked.verdict, 'passed');
  const record = f.app.load('run').tasks[0].check;
  assert.equal(record.revision, REV_T1);
  assert.equal(record.verdict, 'passed');
  assert.equal((await f.app.github('run', { task: 'a' }, false)).isError, false, 'merge_check says it can merge');
  assert.equal(said(f, 'branch merge'), false, 'merge_check merges nothing');
  f.use(after({ runHead: REV_MAIN }));
  const merged = await f.app.github('run', { task: 'a' }, true);
  assert.equal(merged.isError, false, merged.text);
  const raw = f.app.load('run');
  assert.equal(raw.tasks[0].status, 'done');
  assert.equal(raw.tasks[0].mergeCommit, REV_RUN);
  assert.equal(raw.run.lore.head, REV_RUN);
  assert.equal(raw.merge, undefined, 'the claim is let go');
  assert.ok(said(f, `branch merge ${RUN}/a --message=a: Task a`));
  assert.ok(said(f, 'push'));
  const mergedIn = f.calls().find(call => call.args[0] === 'branch' && call.args[1] === 'merge');
  assert.equal(fs.realpathSync(mergedIn.cwd), fs.realpathSync(path.join(f.workspaces, 'run', '_run')), 'it merges in the run workspace');
});

test('a failed check keeps it off', async t => {
  const f = await green(t, { check: true });
  f.mode('fail');
  const checked = await f.app.runCheck('run', { task: 'a' });
  assert.equal(checked.isError, false, 'a failed check is a result, not a failed command');
  assert.equal(checked.verdict, 'failed');
  assert.match(checked.line, /3 tests failed/);
  const record = f.app.load('run').tasks[0].check;
  assert.equal(record.verdict, 'failed');
  assert.match(record.line, /3 tests failed/);
  const refused = await f.app.github('run', { task: 'a' }, true);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /failed/);
  assert.equal(said(f, 'branch merge'), false);
  assert.equal(said(f, 'push'), false);
  assert.equal(f.app.load('run').tasks[0].status, 'green', 'the task stands where it stood');
});

test('run_check runs the project\'s argv in the workspace', async t => {
  const f = await green(t, { check: true });
  const token = 'ab'.repeat(32);
  process.env.CONDUCTOR_TOKEN = token;
  const checked = await f.app.runCheck('run', { task: 'a' });
  assert.equal(checked.verdict, 'passed', checked.text);
  const seen = f.seen();
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(path.join(f.workspaces, 'run', '_check')), 'it runs in the check workspace');
  assert.equal(seen.token, null, 'the caller token never reaches the program');
  assert.ok(!JSON.stringify(checked).includes(token) && !fs.readFileSync(path.join(f.app.home, 'runs', 'run', 'ledger.json'), 'utf8').includes(token));
  const pinned = f.calls().find(call => call.args.join(' ') === `branch switch ${RUN}/a ${REV_T1} --reset`);
  assert.ok(pinned, 'the workspace is put at the judged revision first');
  assert.equal(fs.realpathSync(pinned.cwd), fs.realpathSync(seen.cwd));
  // A check that runs past its limit is stopped, and that is a failure with a line.
  f.app.minuteMs = 300;
  f.mode('hang');
  const slow = await f.app.runCheck('run', { task: 'a' });
  assert.equal(slow.isError, false);
  assert.equal(slow.verdict, 'failed');
  assert.match(slow.line, /ran longer than 1 minute/);
  assert.match(f.app.load('run').tasks[0].check.line, /ran longer than 1 minute/);
  // Another check cannot start over one that is running.
  const raw = f.app.load('run');
  raw.tasks[0].check = { revision: REV_T1, verdict: 'running', at: new Date().toISOString() };
  f.app.save('run', raw);
  const busy = await f.app.runCheck('run', { task: 'a' });
  assert.equal(busy.isError, true);
  assert.match(busy.text, /running/);
});

test('the base moved: sync first', async t => {
  const f = await green(t, { check: true });
  assert.equal((await f.app.runCheck('run', { task: 'a' })).verdict, 'passed');
  await taskMerged(f);
  assert.equal((await f.app.runCheck('run', {})).verdict, 'passed', 'the run branch passes its check at the head');
  f.use(after({ runHead: REV_RUN, status: REV_RUN, main: REV_ON_MAIN }));
  const stale = await f.app.runMergeMain('run', owner);
  assert.equal(stale.isError, true);
  assert.match(stale.text, /run_sync_base/);
  assert.equal(said(f, 'branch unprotect'), false, 'the base is never unprotected for a merge that is refused');
  f.use(after({ runHead: REV_RUN, status: REV_T2, main: REV_ON_MAIN, push: PUSH_SYNC }));
  const synced = await f.app.runSyncBase('run');
  assert.equal(synced.isError, false, synced.text);
  let raw = f.app.load('run');
  assert.equal(raw.run.lore.baseAt, REV_ON_MAIN);
  assert.equal(raw.run.lore.head, REV_T2);
  assert.equal(raw.merge, undefined, 'the sync claim is let go');
  f.use(after({ runHead: REV_T2, status: REV_T2, main: REV_ON_MAIN }));
  const unchecked = await f.app.runMergeMain('run', owner);
  assert.equal(unchecked.isError, true);
  assert.match(unchecked.text, /the check .* has not passed on the run branch's head 33bd575|has not passed on the run branch's head 7dc1ead/);
  assert.equal(said(f, 'branch unprotect'), false);
  assert.equal((await f.app.runCheck('run', {})).verdict, 'passed', 'the check passes again on the new head');
  const merged = await f.app.runMergeMain('run', owner);
  assert.equal(merged.isError, false, merged.text);
  raw = f.app.load('run');
  assert.equal(raw.run.merged.revision, REV_ON_MAIN);
  assert.ok(said(f, 'branch unprotect main') && said(f, 'branch protect main'));
});

test('run_merge_main needs a decision for the head', async t => {
  const none = await proposed(t);
  assert.equal((await approve(none.app)).isError, false);
  await none.app.worktree('run', { task: 'a' });
  await none.app.apply('run', 'task_update', { task: 'a', status: 'review', revision: REV_T1 });
  await none.app.apply('run', 'task_update', { task: 'a', status: 'green' });
  await taskMerged(none);
  const noDecision = await none.app.runMergeMain('run', owner);
  assert.equal(noDecision.isError, true);
  assert.match(noDecision.text, /No recorded decision covers 33bd575/);
  assert.equal(said(none, 'branch unprotect'), false);
  assert.equal(none.app.load('run').run.merged, undefined);

  // A review-only plan is decided too, but not for the base.
  const limited = await proposed(t);
  assert.equal((await limited.app.apply('run', 'approve', { planSha256: limited.hash, decision: DECIDED, delivery: 'review-only' }, owner)).isError, false);
  await limited.app.worktree('run', { task: 'a' });
  await limited.app.apply('run', 'task_update', { task: 'a', status: 'review', revision: REV_T1 });
  await limited.app.apply('run', 'task_update', { task: 'a', status: 'green' });
  await taskMerged(limited);
  const reviewOnly = await limited.app.runMergeMain('run', owner);
  assert.equal(reviewOnly.isError, true);
  assert.match(reviewOnly.text, /No recorded decision covers/);
  assert.equal(said(limited, 'branch unprotect'), false);

  // approve_main for the head the board has: it goes through.
  const approved = await limited.app.apply('run', 'approve_main', { revision: REV_RUN, base: REV_MAIN, decision: DECIDED }, owner);
  assert.equal(approved.isError, false, approved.text);
  // ...but not for another revision than the head it is asked to merge.
  const raw = limited.app.load('run');
  raw.run.decisions.main.revision = REV_T2;
  limited.app.save('run', raw);
  const other = await limited.app.runMergeMain('run', owner);
  assert.equal(other.isError, true);
  assert.match(other.text, /approve_main decision covers 7dc1ead/);
  assert.equal(said(limited, 'branch unprotect'), false);
  raw.run.decisions.main.revision = REV_RUN;
  limited.app.save('run', raw);
  const merged = await limited.app.runMergeMain('run', owner);
  assert.equal(merged.isError, false, merged.text);
  assert.equal(limited.app.load('run').run.merged.revision, REV_ON_MAIN);
});

test('a failed re-protect is a blocker', async t => {
  const f = await green(t);
  await taskMerged(f);
  f.use(after({ runHead: REV_RUN, status: REV_RUN, protectFails: true }));
  const merged = await f.app.runMergeMain('run', owner);
  assert.equal(merged.isError, false, merged.text);
  const raw = f.app.load('run');
  assert.equal(raw.run.merged.revision, REV_ON_MAIN, 'the merge is recorded');
  const blocker = raw.problems.find(one => one.status === 'open' && one.severity === 'blocker');
  assert.match(blocker.text, /^main is not protected:/);
  assert.match(blocker.text, /Not authorized/);
  // Another run of the same home waits for it.
  const second = JSON.parse(fs.readFileSync(f.app.ledgerFile('run'), 'utf8'));
  delete second.problems;
  second.run.id = 'other';
  second.run.merged = undefined;
  delete second.run.merged;
  fs.mkdirSync(path.dirname(f.app.ledgerFile('other')), { recursive: true });
  fs.writeFileSync(f.app.ledgerFile('other'), JSON.stringify(second));
  f.use(after({ runHead: REV_RUN, status: REV_RUN }));
  const waits = await f.app.runMergeMain('other', owner);
  assert.equal(waits.isError, true);
  assert.match(waits.text, /Run run left main unprotected/);
  assert.equal(said(f, 'branch unprotect'), false);
});

test('a claim left by a crashed call blocks nobody for good', async t => {
  const f = await green(t);
  const raw = f.app.load('run');
  raw.merge = { task: 'a', revision: REV_T1, target: 'run', state: 'merging', startedAt: new Date(Date.now() - 5 * 3600_000).toISOString() };
  f.app.save('run', raw);
  // The claim of another run that is young holds the merge; an old one does not.
  const other = JSON.parse(JSON.stringify(raw));
  other.run.id = 'other';
  other.merge.startedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(f.app.ledgerFile('other')), { recursive: true });
  fs.writeFileSync(f.app.ledgerFile('other'), JSON.stringify(other));
  const held = await f.app.github('run', { task: 'a' }, true);
  assert.equal(held.isError, true);
  assert.match(held.text, /one merge at a time, across runs too/);
  other.merge.startedAt = new Date(Date.now() - 5 * 3600_000).toISOString();
  fs.writeFileSync(f.app.ledgerFile('other'), JSON.stringify(other));
  const merged = await f.app.github('run', { task: 'a' }, true);
  assert.equal(merged.isError, false, merged.text);
  const after_ = f.app.load('run');
  assert.equal(after_.tasks[0].status, 'done');
  const blocker = after_.problems.find(one => one.severity === 'blocker');
  assert.match(blocker.text, /was let go unheard after 210 minutes/);
});
