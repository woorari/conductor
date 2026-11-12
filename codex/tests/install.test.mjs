import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { install, defaultTarget } from '../install.mjs';
import { checkRuntime } from '../build.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor installer with spaces '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('uses CODEX_HOME or current user home without machine-specific defaults', t => {
  const home = temporary(t);
  assert.equal(defaultTarget({}, home), path.join(home, '.codex', 'skills', 'conductor'));
  assert.equal(defaultTarget({ CODEX_HOME: path.join(home, 'custom') }, home), path.join(home, 'custom', 'skills', 'conductor'));
  assert.throws(() => checkRuntime('22.17.0'), /22.18/);
  assert.doesNotThrow(() => checkRuntime('22.18.0'));
  assert.doesNotThrow(() => checkRuntime('24.0.0'));
});

test('dry run creates no directories', t => {
  const root = temporary(t);
  const target = path.join(root, 'not created', 'conductor');
  assert.equal(install({ target, dryRun: true }).dryRun, true);
  assert.equal(fs.existsSync(path.dirname(target)), false);
});

test('install builds an executable skill in a path with spaces', async t => {
  const root = temporary(t);
  const target = path.join(root, 'user home', 'skills', 'conductor');
  const result = install({ target });
  assert.equal(result.destination, target);
  assert.equal(result.backup, null);
  const cli = path.join(target, 'scripts', 'conductor.mjs');
  await import(pathToFileURL(cli).href);
  const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help, /merge_check/);
  const provenance = JSON.parse(fs.readFileSync(path.join(target, 'scripts', 'core', 'provenance.json')));
  assert.equal(provenance.repository, 'https://github.com/woorari/conductor');
  assert.equal(JSON.stringify(provenance).includes('/Users/'), false);
  const skill = fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8');
  assert.equal(skill.includes('/Volumes/'), false);
  assert.match(skill, /default to English/);
});

test('update requires --force and preserves the entire earlier installation', t => {
  const root = temporary(t);
  const target = path.join(root, 'conductor');
  install({ target });
  fs.writeFileSync(path.join(target, 'local-note.txt'), 'preserve this');
  assert.throws(() => install({ target }), /--force/);
  const result = install({ target, force: true });
  assert.equal(fs.readFileSync(path.join(result.backup, 'local-note.txt'), 'utf8'), 'preserve this');
  assert.equal(fs.existsSync(path.join(target, 'local-note.txt')), false);
  assert.ok(fs.existsSync(path.join(target, 'SKILL.md')));
});

test('refuses a target that could replace the parent skills directory', t => {
  const root = temporary(t);
  assert.throws(() => install({ target: path.join(root, 'skills'), force: true }), /must name the conductor/);
  assert.equal(fs.existsSync(path.join(root, 'skills')), false);
});
