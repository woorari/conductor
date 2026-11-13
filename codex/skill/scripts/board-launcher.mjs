import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BOARD_PROTOCOL, serverFile } from './board-server.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function running(root, id, host = 'codex') {
  try {
    const info = JSON.parse(fs.readFileSync(serverFile(root, id, host), 'utf8'));
    if (![1, 2, BOARD_PROTOCOL].includes(info.protocol) || (info.host ?? 'codex') !== host || info.root !== root || info.run !== id || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || !/^[a-f0-9]{64}$/.test(info.token)) return;
    const response = await fetch(`http://127.0.0.1:${info.port}/api/health`, { headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(500) });
    const health = await response.json();
    if (response.ok && health.protocol === info.protocol && (health.host ?? 'codex') === host && health.root === root && health.run === id) return info;
  } catch { /* Missing or stale descriptor; never kill a PID from a file. */ }
}
const view = (info, reused) => ({ url: `http://127.0.0.1:${info.port}/#${info.token}`, reused });

export async function openBoard(root, id, host = 'codex') {
  root = fs.realpathSync(root);
  const file = serverFile(root, id, host);
  if (!fs.existsSync(path.join(path.dirname(file), 'ledger.json'))) throw new Error('No saved run to display.');
  const existing = await running(root, id, host);
  if (existing?.protocol === BOARD_PROTOCOL) return view(existing, true);
  const lock = path.join(path.dirname(file), '.board-start.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fs.mkdirSync(lock);
      acquired = true;
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
      break;
    }
    catch (error) {
      if (acquired) { fs.rmSync(lock, { recursive: true, force: true }); throw error; }
      if (error.code !== 'EEXIST') throw error;
      const ready = await running(root, id, host);
      if (ready?.protocol === BOARD_PROTOCOL) return view(ready, true);
      // Recover an abandoned startup lock, never a live launcher or server.
      try {
        let abandoned = false;
        try {
          const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
          if (Number.isInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); } catch (error) { abandoned = error.code === 'ESRCH'; }
          } else abandoned = Date.now() - fs.statSync(lock).mtimeMs > 30_000;
        } catch { abandoned = Date.now() - fs.statSync(lock).mtimeMs > 30_000; }
        if (abandoned) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await wait(100);
    }
  }
  if (!acquired) throw new Error('Board startup is busy. Retry board_open.');
  try {
    const ready = await running(root, id, host);
    if (ready?.protocol === BOARD_PROTOCOL) return view(ready, true);
    if (ready) await stop(ready);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./board-server.mjs', import.meta.url)), root, id, host], { detached: true, stdio: 'ignore', windowsHide: true });
    let failure;
    child.on('error', error => { failure = error; }); child.unref();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure) throw failure;
      const info = await running(root, id, host);
      if (info?.protocol === BOARD_PROTOCOL) return view(info, false);
      if (child.exitCode !== null) throw new Error('The board server could not start.');
      await wait(100);
    }
    throw new Error('Board startup timed out. Retry board_open.');
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export async function closeBoard(root, id, host = 'codex') {
  root = fs.realpathSync(root);
  const info = await running(root, id, host);
  if (!info) return { stopped: false };
  await stop(info);
  return { stopped: true };
}

async function stop(info) {
  const response = await fetch(`http://127.0.0.1:${info.port}/api/stop`, { method: 'POST', headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('Could not stop the board server.');
  await response.json();
}
