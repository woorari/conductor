import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSkill } from '../build.mjs';
import { BRANCH_SWITCH, PROTECTED, PUSH_FIRST, REPOSITORY_INFO, REV_MAIN, STATUS_CLEAN, ZEROS } from '../../tests/lore-output.ts';

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

// A project home with one Lore place (a seed workspace) and the fake lore on LORE_BIN.
function fixture(t, { minFreeGB = 0 } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-lore-test-'));
  const saved = Object.fromEntries(['LORE_BIN', 'FAKE_LORE_TABLE', 'FAKE_LORE_LOG'].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const root = path.join(parent, 'project');
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const place = { folder: 'game-code', teams: ['ABC'], about: 'The game code.', lore: { branchPrefix: 'eng/', carry: ['Content'], minFreeGB } };
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

  return { app, parent, seed, calls, said: () => calls().map(call => call.args.join(' ')), workspaces: path.join(app.root, 'game-code.conductor') };
}

// A run on the place with one task, its plan proposed.
async function proposed(t, options) {
  const f = fixture(t, options);
  f.app.init();
  await f.app.conduct({ id: 'run', source: 'Test request', title: 'Test run', place: 'game-code' });
  await f.app.apply('run', 'task_add', { id: 'a', title: 'Task a', tier: 'sonnet', tierReason: 'Implementation task', files: ['a.txt'], dependsOn: [] });
  await f.app.apply('run', 'run_plan');

  return f;
}
const approve = app => app.apply('run', 'approve', {}, owner);

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
