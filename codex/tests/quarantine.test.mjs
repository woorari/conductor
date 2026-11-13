import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quarantine } from '../skill/scripts/quarantine.mjs';

test('quarantine validates all sources first and never follows a link outside the project', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-quarantine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'old.txt'), 'original');
  assert.throws(() => quarantine(root, ['old.txt', '../outside']), /limited/);
  assert.equal(fs.readFileSync(path.join(root, 'old.txt'), 'utf8'), 'original');
  if (process.platform !== 'win32') { fs.symlinkSync(os.homedir(), path.join(root, 'link')); assert.throws(() => quarantine(root, ['link']), /symbolic/); }
  assert.throws(() => quarantine(path.join(os.homedir(), 'Library'), ['file']), /outside automatic quarantine/);
  assert.throws(() => quarantine(process.platform === 'win32' ? 'C:\\Windows' : '/System', ['file']), /outside automatic quarantine/);
  const moved = quarantine(root, ['old.txt']); assert.equal(fs.readFileSync(moved.moved[0].to, 'utf8'), 'original');
  assert.throws(() => quarantine(root, ['_deleted']), /quarantine folders/);
  fs.mkdirSync(path.join(root, '.GIT'));
  assert.throws(() => quarantine(root, ['.GIT']), /Git metadata/);
});

test('a Git workspace moves into _deleted while Git retains its correct worktree registration', async t => {
  const { execFileSync } = await import('node:child_process');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-git-quarantine-'));
  const root = path.join(parent, 'project'); fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Quarantine Test']); git(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(root, 'code.txt'), 'approved code'); git(['add', 'code.txt']); git(['commit', '-m', 'initial']);
  const source = path.join(parent, 'workspace'); git(['worktree', 'add', '-b', 'task', source]);
  fs.writeFileSync(path.join(source, 'uncommitted.txt'), 'retain even unfinished content');
  const result = quarantine(root, [source], [parent], true);
  assert.equal(fs.existsSync(source), false); assert.equal(fs.readFileSync(path.join(result.moved[0].to, 'uncommitted.txt'), 'utf8'), 'retain even unfinished content');
  const registered = git(['worktree', 'list', '--porcelain', '-z']).split('\0').filter(line => line.startsWith('worktree ')).map(line => fs.realpathSync(line.slice(9)));
  assert.ok(registered.some(folder => path.relative(folder, fs.realpathSync(result.moved[0].to)) === ''), `Moved worktree must stay registered: ${JSON.stringify(registered)}`);
  assert.equal(fs.readFileSync(path.join(root, 'code.txt'), 'utf8'), 'approved code');
  assert.equal(git(['ls-files', '--others', '--exclude-standard']).trim(), '');
  const active = path.join(parent, 'active'); git(['worktree', 'add', '-b', 'another-task', active]);
  fs.writeFileSync(path.join(active, 'private.txt'), 'private retained content');
  const { moved } = quarantine(active, ['private.txt']);
  assert.equal(fs.readFileSync(moved[0].to, 'utf8'), 'private retained content');
  assert.equal(execFileSync('git', ['-C', active, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim(), '');
});

test('an ignored native run can retain cleanup files without widening source or destination scope', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-native-quarantine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'old.txt'), 'retained');
  assert.throws(() => quarantine(root, ['old.txt'], [], false, '../_deleted'), /inside the project/);
  const result = quarantine(root, ['old.txt'], [], false, '.claude/conductor/runs/run/_deleted');
  assert.ok(result.moved[0].to.includes(path.join('.claude', 'conductor', 'runs', 'run', '_deleted')));
  assert.equal(fs.readFileSync(result.moved[0].to, 'utf8'), 'retained');
});
