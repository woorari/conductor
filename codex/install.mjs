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

export function install({ target = defaultTarget(), force = false, dryRun = false } = {}) {
  checkRuntime();
  const destination = path.resolve(target);
  if (path.basename(destination).toLowerCase() !== 'conductor') throw new Error('--target must name the conductor skill folder, not its parent directory.');
  const exists = fs.existsSync(destination);
  if (exists && fs.lstatSync(destination).isSymbolicLink()) throw new Error('Refusing to replace a symbolic link. Choose a concrete skill directory.');
  if (dryRun) return { destination, requiresForce: exists && !force, backup: exists ? 'A backup will be kept beside the installed skill.' : null, dryRun: true };
  if (exists && !force) throw new Error(`Already installed at ${destination}. Use --force to update; the existing folder will be backed up.`);

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.conductor-install-'));
  const staged = path.join(temporary, 'conductor');
  let backup = null;
  try {
    buildSkill(staged);
    fs.writeFileSync(path.join(staged, marker), JSON.stringify({ format: 1, installedAt: new Date().toISOString() }, null, 2) + '\n');
    if (exists) {
      backup = `${destination}.backup-${Date.now()}-${process.pid}`;
      fs.renameSync(destination, backup);
    }
    try { fs.renameSync(staged, destination); }
    catch (error) {
      if (backup) fs.renameSync(backup, destination);
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
      console.log('Usage: node codex/install.mjs [--target <path/to/conductor>] [--force] [--dry-run]\n\nWorks on macOS and Windows with Node.js 22.18+. Defaults to <CODEX_HOME>/skills/conductor or ~/.codex/skills/conductor. No administrator privileges, npm install, shell scripts or changes to config.toml are required. --force preserves the previous installation as a sibling backup.');
      return;
    }
    if (argument === '--force') options.force = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--target' && args.length) options.target = args.shift();
    else throw new Error(`Unknown or incomplete option: ${argument}`);
  }
  console.log(JSON.stringify(install(options), null, 2));
  console.log('Start a new Codex chat, then invoke $conductor with a task, issue key or spec path.');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
