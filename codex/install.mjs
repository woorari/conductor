#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSkill, checkRuntime } from './build.mjs';

const marker = '.conductor-codex-install.json';

export function defaultTarget(env = process.env, home = os.homedir()) {
  return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills', 'conductor');
}

export function defaultBackupDirectory(env = process.env, home = os.homedir()) {
  return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skill-backups');
}

function moveDirectory(source, target) {
  if (fs.existsSync(target)) throw new Error(`Backup destination already exists: ${target}`);
  try { fs.renameSync(source, target); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
    fs.rmSync(source, { recursive: true });
  }
}

function migrateLegacyBackups(destination, backups) {
  const parent = path.dirname(destination);
  const prefix = `${path.basename(destination)}.backup-`;
  for (const name of fs.readdirSync(parent)) {
    if (!name.startsWith(prefix) || !/^\d+-\d+$/.test(name.slice(prefix.length))) continue;
    const source = path.join(parent, name);
    if (!fs.lstatSync(source).isDirectory() || !fs.existsSync(path.join(source, 'SKILL.md'))) continue;
    fs.mkdirSync(backups, { recursive: true });
    moveDirectory(source, path.join(backups, name));
  }
}

export function install({ target = defaultTarget(), force = false, dryRun = false, backupDir = defaultBackupDirectory() } = {}) {
  checkRuntime();
  const destination = path.resolve(target);
  if (path.basename(destination).toLowerCase() !== 'conductor') throw new Error('--target must name the conductor skill folder, not its parent directory.');
  const exists = fs.existsSync(destination);
  if (exists && fs.lstatSync(destination).isSymbolicLink()) throw new Error('Refusing to replace a symbolic link. Choose a concrete skill directory.');
  const backups = path.resolve(backupDir);
  const relative = path.relative(path.dirname(destination), backups);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Backup directory must be outside the skills directory so backup skills are not discovered.');
  if (dryRun) return { destination, requiresForce: exists && !force, backupDirectory: backups, dryRun: true };
  if (exists && !force) throw new Error(`Already installed at ${destination}. Use --force to update; the existing folder will be backed up.`);

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.conductor-install-'));
  const staged = path.join(temporary, 'conductor');
  let backup = null;
  try {
    buildSkill(staged);
    fs.writeFileSync(path.join(staged, marker), JSON.stringify({ format: 1, installedAt: new Date().toISOString() }, null, 2) + '\n');
    migrateLegacyBackups(destination, backups);
    if (exists) {
      fs.mkdirSync(backups, { recursive: true });
      backup = path.join(backups, `conductor.backup-${Date.now()}-${process.pid}`);
      moveDirectory(destination, backup);
    }
    try { fs.renameSync(staged, destination); }
    catch (error) {
      if (backup) moveDirectory(backup, destination);
      throw error;
    }
    return { destination, backup, dryRun: false };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function main(args = process.argv.slice(2)) {
  const options = {};
  while (args.length) {
    const argument = args.shift();
    if (argument === '--help' || argument === '-h') {
      console.log('Usage: node codex/install.mjs [--target <path/to/conductor>] [--force] [--dry-run] [--backup-dir <path>]\n\nWorks on macOS and Windows with Node.js 22.18+. Defaults to <CODEX_HOME>/skills/conductor or ~/.codex/skills/conductor. No administrator privileges, npm install, shell scripts or changes to config.toml are required. --force preserves the previous installation in <CODEX_HOME>/skill-backups, outside skill discovery.');
      return;
    }
    if (argument === '--force') options.force = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--target' && args.length) options.target = args.shift();
    else if (argument === '--backup-dir' && args.length) options.backupDir = args.shift();
    else throw new Error(`Unknown or incomplete option: ${argument}`);
  }
  console.log(JSON.stringify(install(options), null, 2));
  console.log('Start a new Codex chat, then invoke $conductor with a task, issue key or spec path.');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
