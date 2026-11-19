// The Node `LoreHost` the shared Lore steps run over: programs spawned with argv and no shell, and the file
// system through `fs`. The commands that use it are in lore-commands.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LONG_MS } from './core/lore-steps.mjs';

const why = cause => (cause instanceof Error ? cause.message : String(cause));

/** How much of a long step's output is kept per stream: its start, where Lore says what it merges, and its end. */
const KEPT_HEAD = 1 << 20;
const KEPT_TAIL = 3 << 20;
function keeper() {
  let head = '';
  let tail = '';
  let isCut = false;
  return {
    add(text) {
      const room = Math.max(0, KEPT_HEAD - head.length);
      head += text.slice(0, room);
      tail += text.slice(room);
      if (tail.length > 2 * KEPT_TAIL) { tail = tail.slice(-KEPT_TAIL); isCut = true; }
    },
    text: () => (isCut || tail.length > KEPT_TAIL ? `${head}\n…\n${tail.slice(-KEPT_TAIL)}` : `${head}${tail}`),
  };
}

const LORE_MISSING = 'lore could not be run: it is not on the PATH. Set its full path in LORE_BIN.';

/** The program that runs lore: LORE_BIN, else `lore` on the PATH. A script is run by this Node, so it needs no shell on any system. */
function loreProgram() {
  const bin = process.env.LORE_BIN;
  if (bin === undefined || bin === '') return { file: 'lore', lead: [] };
  return /\.(mjs|cjs|js)$/i.test(bin) ? { file: process.execPath, lead: [bin] } : { file: bin, lead: [] };
}

/** Runs a program with argv and no shell. Never rejects: a program that could not run, or ran too long, is a non-zero exit with why. */
export function runProgram(file, args, cwd, ms = 30_000, missingText = `${file} could not be run: it is not on the PATH.`) {
  return new Promise(resolve => {
    const [stdout, stderr] = [keeper(), keeper()];
    let isDone = false;
    let isTimedOut = false;
    let timer;
    let hard;
    const done = (exitCode, extra = '') => {
      if (isDone) return;
      isDone = true;
      clearTimeout(timer);
      clearTimeout(hard);
      const err = [stderr.text(), extra].filter(one => one !== '').join('\n');
      resolve({ exitCode, out: `${stdout.text()}${err === '' ? '' : `\n${err}`}`, err, ...(isTimedOut ? { timedOut: true } : {}) });
    };
    // A token for Conductor's callers never reaches a program it starts.
    const env = { ...process.env };
    delete env.CONDUCTOR_TOKEN;
    let child;
    try {
      child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (cause) {
      return done(1, why(cause));
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => stdout.add(text));
    child.stderr.on('data', text => stderr.add(text));
    child.on('error', cause => done(cause.code === 'ENOENT' ? 127 : 1, cause.code === 'ENOENT' ? missingText : why(cause)));
    const stopped = `${file === process.execPath ? 'lore' : path.basename(file)} ${args.slice(0, 3).join(' ')} was still running after ${ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`} and was stopped`;
    child.on('close', (code, signal) => done(code ?? 1, signal === null ? '' : `${path.basename(file)} was ended by ${signal}`));
    timer = setTimeout(() => {
      isTimedOut = true;
      child.kill('SIGTERM');
      // A program that does not end when asked is left behind, and its step is over.
      hard = setTimeout(() => done(1, stopped), 10_000);
    }, ms);
    child.on('close', () => clearTimeout(hard));
    timer.unref?.();
  });
}

/** Runs `lore --non-interactive <args>` with no shell. */
function runLore(args, cwd, ms) {
  const { file, lead } = loreProgram();
  return runProgram(file, [...lead, '--non-interactive', ...args], cwd, ms, LORE_MISSING);
}

/** Every folder (a line ending in `/`) and file below a folder. Lore's own state is named but not entered: no rule of the project applies to it. */
async function walk(folder, at = '', lines = []) {
  for (const entry of await fs.promises.readdir(path.join(folder, at), { withFileTypes: true })) {
    const here = at === '' ? entry.name : `${at}/${entry.name}`;
    lines.push(entry.isDirectory() ? `${here}/` : here);
    if (entry.isDirectory() && here !== '.lore') await walk(folder, here, lines);
  }
  return lines;
}

const missing = cause => cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR';

/** The `LoreHost` of the steps over Node: `child_process.spawn` without a shell, and the file system through `fs`. */
export function nodeHost({ platform = process.platform, program = runProgram } = {}) {
  return {
    lore: (args, cwd, ms) => runLore(args, cwd, ms),
    async freeGb(folder) {
      try {
        const disk = await fs.promises.statfs(folder);
        return Math.floor((Number(disk.bavail) * Number(disk.bsize)) / 1024 ** 3);
      } catch (cause) {
        throw new Error(`the free space of the disk that holds ${folder} could not be read: ${why(cause)}`);
      }
    },
    async sameDisk(a, b) {
      const [first, second] = await Promise.all([fs.promises.stat(a, { bigint: true }), fs.promises.stat(b, { bigint: true })]);
      return first.dev === second.dev;
    },
    async copyTree(from, to, entries) {
      for (const entry of entries) {
        if (platform === 'darwin') {
          // Node cannot clone on macOS (COPYFILE_FICLONE_FORCE is ENOSYS there); `cp -c` does, and copies the bytes where it cannot.
          const copied = await program('cp', ['-c', '-R', `${from}/${entry}`, `${to}/`], undefined, LONG_MS);
          if (copied.exitCode !== 0) throw new Error(`${entry} could not be copied: ${copied.err.trim().split('\n').pop() || `cp exit ${copied.exitCode}`}`);
          continue;
        }
        try {
          // COPYFILE_FICLONE asks for a copy-on-write clone and copies the bytes where the disk or Node cannot clone.
          await fs.promises.cp(path.join(from, entry), path.join(to, entry), { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true, errorOnExist: true, force: false });
        } catch (cause) {
          throw new Error(`${entry} could not be copied: ${why(cause)}`);
        }
      }
    },
    mkdir: async folder => { await fs.promises.mkdir(folder, { recursive: true }); },
    remove: folder => fs.promises.rm(folder, { recursive: true, force: true }),
    async removeMany(paths) { for (const one of paths) await fs.promises.rm(one, { recursive: true, force: true }); },
    // Without `recursive`, rm refuses a folder: a folder among the paths fails the call.
    async removeFiles(paths) { for (const one of paths) await fs.promises.rm(one, { force: true }); },
    async exists(one) {
      try { await fs.promises.lstat(one); return true; } catch (cause) { if (missing(cause)) return false; throw cause; }
    },
    async mark(file) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, 'ready\n');
    },
    async readText(file) {
      try { return await fs.promises.readFile(file, 'utf8'); } catch (cause) { if (missing(cause)) return undefined; throw cause; }
    },
    async listDir(folder) {
      return (await fs.promises.readdir(folder, { withFileTypes: true })).map(one => ({ name: one.name, isDir: one.isDirectory() }));
    },
    async listTree(folder) {
      return (await walk(folder)).map(one => `${folder}/${one}`).join('\n');
    },
  };
}

/** Whether the ledger in a file is a Lore run. A ledger that is missing or unreadable is none: the caller's own path says why. */
export function isLoreLedger(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8'))?.run?.workspace?.kind === 'lore'; } catch { return false; }
}
