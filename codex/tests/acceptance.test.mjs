// A whole Lore run with no person present: every step is a CLI call by a proven caller (--callers), and no call uses --caller.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSkill } from '../build.mjs';
import { BRANCH_SWITCH, MERGE_CLEAN, MERGE_INTO_DONE, PROTECTED, PUSH_FIRST, PUSH_RUN, REPOSITORY_INFO, REV_MAIN, REV_ON_MAIN, REV_RUN, REV_T1, REV_T2, STATUS_CLEAN, UNPROTECTED, ZEROS } from '../../tests/lore-output.ts';

const built = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-acceptance-built-'));
const skillPath = buildSkill(path.join(built, 'conductor'));
const { issueCaller } = await import(pathToFileURL(path.join(skillPath, 'scripts', 'callers.mjs')).href);
const cli = path.join(skillPath, 'scripts', 'conductor.mjs');
process.on('exit', () => fs.rmSync(built, { recursive: true, force: true }));

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-lore.mjs');
const RUN = 'eng/run-test-run';
const HEAD2 = 'b'.repeat(64);
const hours = n => new Date(Date.now() + n * 3600_000).toISOString();
const info = (name, latest, remote) => `Branch ${name}\n  ID: 01a1b056f6bb701783e7a1beb2aa49a0\n  Latest: ${latest}\n  Remote Latest: ${remote}\n  Created: Fri, 6 Nov 2026 10:10:51 +0000\n`;
const statusAt = revision => `Repository 01a1b056c981721b88ecc4b6b66d6f45\nOn branch ${RUN} revision 3 -> ${revision}\nRemote revision 3 -> ${revision}\nLocal branch in sync with remote\nNo tracked changes\n`;
const MERGE_B = MERGE_CLEAN.replace(REV_T1, REV_T2).replace(REV_RUN, HEAD2);
const PUSH_B = PUSH_RUN.replaceAll(REV_RUN, HEAD2);
const INTO_DONE = MERGE_INTO_DONE.replaceAll(REV_ON_MAIN, HEAD2);

// What the fake lore answers before the approval: the repository, the branches not yet pushed, the run branch made.
const BEFORE = [
  { match: 'repository info', out: REPOSITORY_INFO },
  { match: 'repository update-path' },
  { match: 'status --scan', out: STATUS_CLEAN },
  { match: 'branch switch', out: BRANCH_SWITCH },
  { match: 'branch info main', out: info('main', REV_MAIN, REV_MAIN) },
  { match: `branch info ${RUN}/a`, out: info(`${RUN}/a`, ZEROS, ZEROS) },
  { match: `branch info ${RUN}/b`, out: info(`${RUN}/b`, ZEROS, ZEROS) },
  { match: `branch info ${RUN}`, answers: [info(RUN, REV_MAIN, ZEROS), info(RUN, REV_MAIN, REV_MAIN)] },
  { match: 'branch create' },
  { match: 'push', out: PUSH_FIRST },
  { match: 'branch protect main', out: PROTECTED },
];

// What it answers once the tasks are handed back: where each branch stands, what the workspace is at, what a merge and a push say.
const AFTER = (o = {}) => [
  { match: 'repository update-path' },
  { match: 'status --scan', out: STATUS_CLEAN },
  { match: 'status', out: statusAt(o.status ?? REV_MAIN) },
  { match: 'branch switch', out: BRANCH_SWITCH },
  { match: `branch info ${RUN}/a`, out: info(`${RUN}/a`, REV_T1, REV_T1) },
  { match: `branch info ${RUN}/b`, out: info(`${RUN}/b`, REV_T2, REV_T2) },
  { match: `branch info ${RUN}`, out: info(RUN, o.runHead ?? REV_MAIN, o.runHead ?? REV_MAIN) },
  { match: 'branch info main', out: info('main', REV_MAIN, REV_MAIN) },
  { match: 'branch merge into main', out: INTO_DONE },
  { match: 'branch merge abort' },
  { match: 'branch merge', out: o.merge ?? MERGE_CLEAN },
  { match: 'branch reset' },
  { match: 'push', out: o.push ?? PUSH_RUN },
  { match: 'lock release' },
  { match: 'branch unprotect main', out: UNPROTECTED },
  { match: 'branch protect main', out: PROTECTED },
];

test('a whole Lore run with no person present', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-acceptance-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const root = path.join(parent, 'project');
  const home = path.join(parent, 'state');
  const dir = path.join(parent, 'callers');
  const checkScript = path.join(parent, 'check.mjs');
  put(checkScript, "import fs from 'node:fs'; fs.writeFileSync(new URL('./check-ran.txt', import.meta.url), process.cwd());\n");
  const place = { folder: 'game-code', teams: ['ABC'], about: 'The game code.', lore: { branchPrefix: 'eng/', carry: [], minFreeGB: 0 }, check: { argv: [process.execPath, checkScript], timeoutMin: 1 } };
  put(path.join(root, '.claude/conductor/config.json'), JSON.stringify({ places: [place] }));
  const seed = path.join(root, 'game-code');
  put(path.join(seed, '.lore/state.txt'), 'lore state\n');
  put(path.join(seed, '.loreignore'), 'Saved/\n');
  put(path.join(seed, 'Source/a.cpp'), 'int a;\n');
  const table = path.join(parent, 'table.json');
  const log = path.join(parent, 'lore.log');
  const use = rows => { fs.writeFileSync(table, JSON.stringify(rows)); fs.rmSync(log, { force: true }); };
  const lore = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).args.join(' ')) : []);
  use(BEFORE);

  const env = { ...process.env, LORE_BIN: FAKE, FAKE_LORE_TABLE: table, FAKE_LORE_LOG: log };
  delete env.CONDUCTOR_TOKEN;
  const argvs = [];
  const call = (command, token, input, { run = 'run' } = {}) => {
    const args = [cli, command, '--root', root, '--home', home, '--callers', dir, ...(run ? ['--run', run] : [])];
    if (input !== undefined) {
      const file = path.join(parent, `input-${argvs.length}.json`);
      fs.writeFileSync(file, JSON.stringify(input));
      args.push('--input', file);
    }
    argvs.push(args);
    const done = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...env, CONDUCTOR_TOKEN: token } });
    assert.equal(done.status, 0, `${command}: ${done.stdout}${done.stderr}`);
    return JSON.parse(done.stdout);
  };

  const orchestrator = issueCaller(dir, { kind: 'orchestrator', department: 'engineering', run: 'run', expiresAt: hours(12) });
  const decider = issueCaller(dir, { kind: 'decider', department: 'engineering', agent: 'lead-a', expiresAt: hours(24) });
  const dispatcher = issueCaller(dir, { kind: 'dispatcher', department: 'engineering', person: 'p1', expiresAt: hours(1) });
  const worker = task => issueCaller(dir, { kind: 'worker', department: 'engineering', run: 'run', task, expiresAt: hours(12) });

  call('conduct', orchestrator, { id: 'run', source: 'Test request', title: 'Test run', place: 'game-code', department: 'engineering' }, { run: undefined });
  for (const id of ['a', 'b']) call('task_add', orchestrator, { id, title: `Task ${id}`, tier: 'sonnet', tierReason: 'Implementation task', files: [`${id}.txt`], dependsOn: [] });
  const hash = call('run_plan', orchestrator).planSha256;
  assert.match(hash, /^[0-9a-f]{64}$/);
  call('approve', decider, { planSha256: hash, decision: { by: 'decider:engineering', ref: 'D-1' } });
  for (const id of ['a', 'b']) call('worktree', orchestrator, { task: id });
  for (const [id, revision] of [['a', REV_T1], ['b', REV_T2]]) {
    call('task_update', worker(id), { task: id, status: 'review', revision });
    call('task_update', orchestrator, { task: id, status: 'green' });
  }

  // The check, then the merge, of each task; then the check of the run branch's head.
  for (const [id, revision] of [['a', REV_T1], ['b', REV_T2]]) {
    use(AFTER({ status: revision }));
    assert.equal(call('run_check', orchestrator, { task: id }).verdict, 'passed');
  }
  use(AFTER({ runHead: REV_MAIN }));
  call('merge', orchestrator, { task: 'a' });
  use(AFTER({ runHead: REV_RUN, merge: MERGE_B, push: PUSH_B }));
  call('merge', orchestrator, { task: 'b' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'runs/run/ledger.json'), 'utf8')).run.lore.head, HEAD2);
  use(AFTER({ runHead: HEAD2, status: HEAD2 }));
  assert.equal(call('run_check', orchestrator, {}).verdict, 'passed');

  // A dispatcher merges the run into the base, by the plan decision that covers the head.
  use(AFTER({ runHead: HEAD2, status: HEAD2 }));
  call('run_merge_main', dispatcher);
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'runs/run/ledger.json'), 'utf8'));
  assert.equal(raw.run.merged.revision, HEAD2);
  assert.equal(raw.run.merged.revision, raw.run.lore.head, 'what went into the base is the head that was checked and decided');
  assert.deepEqual(raw.tasks.map(one => one.status), ['done', 'done']);
  assert.equal(raw.run.check.verdict, 'passed');
  const said = lore();
  assert.ok(said.indexOf('branch unprotect main') >= 0 && said.indexOf('branch protect main') > said.indexOf('branch unprotect main'), 'the base is unprotected for the merge and protected again');
  assert.ok(argvs.length >= 17);
  assert.equal(argvs.some(args => args.includes('--caller')), false, 'no call used --caller');
});
