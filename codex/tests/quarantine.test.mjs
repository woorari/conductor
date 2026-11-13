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
  assert.ok(git(['worktree', 'list', '--porcelain']).includes(result.moved[0].to.replaceAll('\\', '/')));
  assert.equal(fs.readFileSync(path.join(root, 'code.txt'), 'utf8'), 'approved code');
});
