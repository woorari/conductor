#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
function protectedPath(file, home = os.homedir()) {
  const value = path.resolve(file).replaceAll('\\', '/').toLowerCase();
  const library = path.resolve(home, 'Library').replaceAll('\\', '/').toLowerCase();
  return value === library || value.startsWith(library + '/') || ['/system', '/library', '/bin', '/sbin', '/usr', '/etc', '/private/etc', '/applications', '/dev', '/proc', '/sys', '/boot', '/private/var/db', '/var/db', 'c:/program files', 'c:/program files (x86)', 'c:/programdata', 'c:/windows', (process.env.SystemRoot ?? 'C:/Windows').replaceAll('\\', '/').toLowerCase()].some(root => value === root || value.startsWith(root + '/'));
}
function noLinks(root, file) {
  let current = root;
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Quarantine cannot follow symbolic links.');
  for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Quarantine cannot follow symbolic links.'); }
}

function ignoreQuarantine(root) {
  let exclude;
  try { exclude = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8', stdio: 'pipe' }).trim(); }
  catch { return; } // Folder and Lore projects have no Git metadata.
  exclude = path.resolve(root, exclude);
  if (protectedPath(exclude)) throw new Error('Git quarantine exclusions cannot access protected files.');
  const parent = fs.realpathSync(path.dirname(exclude));
  if (protectedPath(parent) || (fs.existsSync(exclude) && fs.lstatSync(exclude).isSymbolicLink())) throw new Error('Git quarantine exclusions cannot follow protected paths or links.');
  const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  // Local metadata shared by linked worktrees; never add retained private files to a task PR.
  if (!existing.split(/\r?\n/).includes('_deleted/')) fs.appendFileSync(exclude, `${existing.endsWith('\n') || !existing ? '' : '\n'}# Conductor: retained local files\n_deleted/\n`);
}

/** Move aside reversibly. Validate every source before moving the first; never overwrite or delete. */
export function quarantine(root, files, managed = [], gitWorktree = false, deletedDirectory) {
  if (protectedPath(root)) throw new Error('System files and ~/Library are outside automatic quarantine.');
  const originalRoot = path.resolve(root);
  root = fs.realpathSync(root);
  if (protectedPath(root)) throw new Error('System files and ~/Library are outside automatic quarantine.');
  if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || !file)) throw new Error('Give files or folders to move into _deleted.');
  const mappings = [{ original: originalRoot, real: root }, ...managed.map(folder => {
    if (protectedPath(folder) || fs.lstatSync(folder).isSymbolicLink()) throw new Error('A managed source is protected or is a link.');
    const real = fs.realpathSync(folder);
    if (protectedPath(real)) throw new Error('A managed source is protected.');
    return { original: path.resolve(folder), real };
  })];
  const roots = mappings.map(one => one.real);
  const sources = [...new Set(files.map(file => {
    const resolved = path.resolve(originalRoot, file);
    const mapping = mappings.find(one => inside(one.original, resolved));
    return mapping ? path.join(mapping.real, path.relative(mapping.original, resolved)) : resolved;
  }))];
  for (const source of sources) {
    if (protectedPath(source) || roots.includes(source) || !roots.some(folder => inside(folder, source))) throw new Error('Quarantine is limited to project or explicitly managed workspace files.');
    if (source.split(path.sep).some(part => ['.git', '_deleted'].includes(part.toLowerCase()))) throw new Error('Git metadata and existing quarantine folders cannot be moved.');
    const parent = roots.find(folder => inside(folder, source)); noLinks(parent, source);
    if (sources.some(other => other !== source && inside(source, other))) throw new Error('Do not list both a folder and its contents.');
  }
  const requested = path.resolve(originalRoot, deletedDirectory ?? '_deleted');
  if (!inside(originalRoot, requested) || path.basename(requested) !== '_deleted' || protectedPath(requested)) throw new Error('The quarantine destination must be an _deleted folder inside the project.');
  const deleted = path.join(root, path.relative(originalRoot, requested));
  let existingParent = deleted;
  while (!fs.existsSync(existingParent)) existingParent = path.dirname(existingParent);
  noLinks(root, existingParent);
  if (sources.some(source => inside(source, deleted))) throw new Error('The quarantine destination cannot be inside a source.');
  const destination = path.join(deleted, `${Date.now()}-${randomBytes(6).toString('hex')}`);
  const planned = sources.map((source, index) => ({ from: source, to: path.join(destination, inside(root, source) ? path.relative(root, source) : path.join('workspaces', String(index), path.basename(source))) }));
  if (planned.some((one, index) => planned.some((other, otherIndex) => index !== otherIndex && inside(one.to, other.to)))) throw new Error('Quarantine destinations overlap; move those items separately.');
  ignoreQuarantine(root);
  fs.mkdirSync(deleted, { recursive: true });
  fs.mkdirSync(destination); // Reserve the destination; never replace a previous quarantine.
  const moved = [];
  for (const { from: source, to: target } of planned) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (gitWorktree) execFileSync('git', ['-C', root, 'worktree', 'move', source, target], { stdio: 'pipe' });
    else fs.renameSync(source, target);
    moved.push({ from: source, to: target });
  }
  return { isChanged: true, isError: false, text: `Moved ${moved.length} item(s) into _deleted; no files were deleted.`, moved };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); let root; let deletedDirectory; let gitWorktree = false; const managed = []; const files = [];
  while (args.length) { const key = args.shift(); if (key === '--git') gitWorktree = true; else if (key === '--root') root = args.shift(); else if (key === '--destination') deletedDirectory = args.shift(); else if (key === '--managed') managed.push(args.shift()); else if (key === '--') { files.push(...args); break; } else throw new Error('Use --root <project> [--managed <workspace-parent>] [--destination <project/_deleted>] -- <files...>.'); }
  try { console.log(JSON.stringify(quarantine(root, files, managed, gitWorktree, deletedDirectory))); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
