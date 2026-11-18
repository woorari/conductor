import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSkill } from '../build.mjs';
const built = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-home-built-'));
const skillPath = buildSkill(path.join(built, 'conductor'));
const { Conductor } = await import(pathToFileURL(path.join(skillPath, 'scripts', 'conductor.mjs')).href);
process.on('exit', () => fs.rmSync(built, { recursive: true, force: true }));

const place = { folder: 'game-code', teams: ['ABC'], about: 'The game code.', check: { argv: ['./check.sh'], timeoutMin: 5 }, lore: { branchPrefix: 'eng/' } };
function project(t, config, folders = []) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-home-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project');
  fs.mkdirSync(path.join(root, '.claude/conductor'), { recursive: true });
  if (config !== undefined) fs.writeFileSync(path.join(root, '.claude/conductor/config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  for (const folder of folders) fs.mkdirSync(path.join(root, folder), { recursive: true });
  return { root, parent, state: path.join(parent, 'state') };
}
const start = { id: 'run', source: 'Test request', title: 'Test run' };

test('a call without home or callers behaves as before', async t => {
  const { root } = project(t, { staffing: { agents: [{ id: 'lead-a', about: 'Leads.' }] } });
  const app = new Conductor(root);
  app.init();
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /\.codex\/conductor\/runs\//);
  await app.conduct(start);
  const ledger = JSON.parse(fs.readFileSync(path.join(root, '.codex/conductor/runs/run/ledger.json'), 'utf8'));
  assert.deepEqual(ledger.run.config, { staffing: { agents: [{ id: 'lead-a', about: 'Leads.' }] } });
  assert.equal(ledger.run.workspace, undefined);
});

test('a repository home keeps the whole config in the run', async t => {
  const config = { tickets: 'linear', linear: { team: 'ABC' }, check: { argv: ['./check.sh'], timeoutMin: 5 } };
  const { root } = project(t, config);
  const app = new Conductor(root);
  await app.conduct(start);
  assert.deepEqual(app.load('run').run.config, config);
});

test('a home keeps the ledger outside the project', async t => {
  const { root, state } = project(t, {});
  const app = new Conductor(root, { home: state });
  const before = fs.existsSync(path.join(root, '.gitignore'));
  app.init();
  await app.conduct(start);
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), before, '.gitignore is untouched');
  assert.equal(fs.existsSync(path.join(root, '.codex')), false, 'nothing is written in the project');
  assert.equal(fs.existsSync(path.join(state, 'runs/run/ledger.json')), true);
  assert.equal(fs.existsSync(path.join(state, '.adapter.lock')), false, 'the lock lives in the home and is released');
  assert.equal(app.load('run').run.id, 'run');
});

test('a folder home needs a place', async t => {
  const { root, state } = project(t, { places: [place] }, ['game-code']);
  const app = new Conductor(root, { home: state });
  await assert.rejects(() => app.conduct(start), /name the place the run works in, one of game-code/);
  assert.equal(fs.existsSync(path.join(state, 'runs/run/ledger.json')), false);
  await app.conduct({ ...start, place: 'game-code' });
  const run = app.load('run').run;
  assert.equal(run.workspace.place, 'game-code');
  assert.equal(run.workspace.root, path.join(fs.realpathSync(root), 'game-code'));
  assert.equal(run.workspace.base, 'main');
  assert.deepEqual(run.config.check, place.check);
  assert.deepEqual(run.config.lore, place.lore);
  assert.deepEqual(run.config.linear, { team: 'ABC' });
});

test("a place's own base is the run's one base", async t => {
  const { root, state } = project(t, { places: [{ ...place, base: 'develop' }] }, ['game-code']);
  const app = new Conductor(root, { home: state });
  await app.conduct({ ...start, place: 'game-code', base: 'ignored' });
  const raw = app.load('run');
  assert.equal(raw.run.workspace.base, 'develop');
  assert.equal(raw.codex.base, 'develop');
  const plain = project(t, {});
  const other = new Conductor(plain.root, { home: plain.state });
  await other.conduct({ ...start, base: 'trunk' });
  assert.equal(other.load('run').codex.base, 'trunk');
});

test('a place whose folder is missing is refused', async t => {
  const { root, state } = project(t, { places: [place] });
  const app = new Conductor(root, { home: state });
  await assert.rejects(() => app.conduct({ ...start, place: 'game-code' }), /is no folder in this home/);
  assert.equal(fs.existsSync(path.join(state, 'runs')), false, 'no ledger written');
});

test('a repository home refuses places', async t => {
  const { root, state } = project(t, {});
  const app = new Conductor(root, { home: state });
  await assert.rejects(() => app.conduct({ ...start, place: 'game-code' }), /lists no places/);
});

test('a config that does not parse stops conduct', async t => {
  const { root } = project(t, '{ nope');
  await assert.rejects(() => new Conductor(root).conduct(start), /config\.json is not valid JSON/);
  const folder = project(t, { places: [place], check: place.check }, ['game-code']);
  await assert.rejects(() => new Conductor(folder.root).conduct({ ...start, place: 'game-code' }), /check belongs in a place/);
});
