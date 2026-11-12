import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { install, defaultTarget, defaultBackupDirectory } from '../install.mjs';
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
  assert.equal(defaultBackupDirectory({}, home), path.join(home, '.codex', 'skill-backups'));
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
  const target = path.join(root, 'skills', 'conductor');
  install({ target });
  fs.writeFileSync(path.join(target, 'local-note.txt'), 'preserve this');
  assert.throws(() => install({ target }), /--force/);
  const result = install({ target, force: true, backupDir: path.join(root, 'backups') });
  assert.equal(fs.readFileSync(path.join(result.backup, 'local-note.txt'), 'utf8'), 'preserve this');
  assert.equal(fs.existsSync(path.join(target, 'local-note.txt')), false);
  assert.ok(fs.existsSync(path.join(target, 'SKILL.md')));
  assert.equal(path.dirname(result.backup), path.join(root, 'backups'));
  assert.deepEqual(fs.readdirSync(path.join(root, 'skills')), ['conductor']);
});

test('old installer backups are preserved outside skill discovery', t => {
  const root = temporary(t);
  const target = path.join(root, 'skills', 'conductor');
  const backups = path.join(root, 'backups');
  install({ target });
  const legacy = path.join(root, 'skills', 'conductor.backup-123-456');
  fs.mkdirSync(legacy);
  fs.copyFileSync(path.join(target, 'SKILL.md'), path.join(legacy, 'SKILL.md'));
  fs.writeFileSync(path.join(legacy, 'local-note.txt'), 'preserve old backup');
  install({ target, force: true, backupDir: backups });
  assert.deepEqual(fs.readdirSync(path.join(root, 'skills')), ['conductor']);
  assert.equal(fs.readFileSync(path.join(backups, 'conductor.backup-123-456', 'local-note.txt'), 'utf8'), 'preserve old backup');
  assert.throws(() => install({ target, force: true, backupDir: path.join(root, 'skills', 'backups') }), /outside the skills directory/);
});

test('refuses a target that could replace the parent skills directory', t => {
  const root = temporary(t);
  assert.throws(() => install({ target: path.join(root, 'skills'), force: true }), /must name the conductor/);
  assert.equal(fs.existsSync(path.join(root, 'skills')), false);
});
