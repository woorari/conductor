#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { complexityOf, selectModel } from './core/models.mjs';
import { parseLedger, RUN_ID } from './core/ledger.mjs';
import { boardView, detail, problemDetail, timeline, runMinutes, elapsedShort } from './core/board.mjs';
import { preflight } from './core/router.mjs';
import { pendingLinear } from './linear.mjs';

export const BOARD_PROTOCOL = 5;

export const serverFile = (root, id, host = 'codex') => {
  if (!['claude', 'codex'].includes(host)) throw new Error('Invalid board host.');
  if (typeof id !== 'string' || !RUN_ID.test(id)) throw new Error('Invalid run id.');
  return path.join(root, `.${host}/conductor/runs`, id, 'board-server.json');
};

export function snapshot(file, offset = 0, host = 'codex') {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const parsed = parseLedger(JSON.stringify(raw));
  if (parsed.error) throw new Error(parsed.error);
  const ledger = parsed.ledger;
  const now = Date.now();
  const view = boardView(ledger, now);
  const task = row => ({ id: row.id, title: row.title, status: row.status, tier: row.tier, complexity: host === 'claude' ? row.tier : complexityOf(row.tier),
    modelSelection: row.status === 'done' ? undefined : selectModel(host, row.tier, host === 'codex' ? raw.codex?.models : undefined), recordedModel: row.model,
    files: row.files ?? [], dependsOn: row.dependsOn ?? [], note: row.note, ticket: row.ticket,
    activity: row.activity && Number.isFinite(Date.parse(row.activity.at)) ? { ...row.activity, ageMinutes: Math.max(0, Math.floor((now - Date.parse(row.activity.at)) / 60_000)) } : undefined,
    detail: host === 'claude' ? detail(row) : detail(row, complexityOf) });
  const groups = Object.fromEntries(['attention', 'building', 'returned', 'review', 'next', 'waiting', 'done'].map(key => [key, view[key].map(task)]));
  const minutes = runMinutes(ledger, now);
  return {
    host, commands: { approve: host === 'claude' ? '/approve' : '$conductor approve', unpause: host === 'claude' ? '/unpause' : '$conductor unpause' },
    run: { id: ledger.run.id, title: view.title, plan: ledger.run.plan ?? 'approved', pausedAt: view.pausedAt },
    updatedAt: fs.statSync(file).mtime.toISOString(),
    elapsed: minutes === undefined ? undefined : elapsedShort(minutes),
    total: view.total, completed: view.done.length, groups,
    problems: view.problems.map(one => ({ id: one.id, severity: one.severity, text: one.text, detail: problemDetail(one) })),
    questions: view.questions.map(one => ({ id: one.id, from: one.from, text: one.text })),
    findings: view.findings, rulings: ledger.rulings.map(one => ({ id: one.id, text: one.text })),
    pending: pendingLinear(raw), planChecks: preflight(ledger), timeline: timeline(ledger, now, offset),
  };
}

export async function startServer(root, id, { idleMs = 30 * 60_000, host = 'codex' } = {}) {
  root = fs.realpathSync(root);
  const descriptor = serverFile(root, id, host);
  const ledger = path.join(path.dirname(descriptor), 'ledger.json');
  snapshot(ledger, 0, host); // Refuse missing/invalid runs before opening a socket.
  const assets = fileURLToPath(new URL('../assets/board/', import.meta.url));
  // A skill update must not mix a running server's old data shape with new browser assets.
  const content = Object.fromEntries(['index.html', 'board.js', 'board.css'].map(name => [name, fs.readFileSync(path.join(assets, name))]));
  const token = randomBytes(32).toString('hex');
  let lastRequest = Date.now();
  let port;
  let bridgeSeen = 0;
  const actions = new Map();
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
  const server = http.createServer((req, res) => {
    const send = (status, type, body) => { res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(body); };
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`)) {
      send(403, 'text/plain', 'Forbidden'); return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      const given = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) { send(401, 'application/json', '{"error":"Board access expired. Reopen it with $conductor board."}'); return; }
      if (!url.pathname.startsWith('/api/actions')) lastRequest = Date.now();
      if (req.method === 'GET' && url.pathname === '/api/health') { send(200, 'application/json', JSON.stringify({ protocol: BOARD_PROTOCOL, root, run: id, host })); return; }
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        res.setHeader('Connection', 'close'); send(200, 'application/json', '{"stopped":true}');
        setImmediate(() => { server.close(); server.closeIdleConnections(); }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/board') {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isInteger(offset) || Math.abs(offset) > 840) { send(400, 'application/json', '{"error":"Invalid time zone offset."}'); return; }
        try { send(200, 'application/json', JSON.stringify({ ...snapshot(ledger, offset, host), tierEditable: host === 'claude' && Date.now() - bridgeSeen < 8000, actions: [...actions.values()].map(({ id, task, tier, status, message }) => ({ id, task, tier, status, message })) })); }
        catch { send(503, 'application/json', '{"error":"Cannot read the saved run. Showing the last successful snapshot; retrying automatically."}'); }
        return;
      }
      if (host === 'claude' && req.method === 'GET' && url.pathname === '/api/actions') {
        bridgeSeen = Date.now();
        const pending = [...actions.values()].filter(one => one.status === 'pending' && (!one.claimedAt || Date.now() - one.claimedAt > 15000));
        for (const one of pending) one.claimedAt = Date.now();
        send(200, 'application/json', JSON.stringify(pending.map(({ id, task, tier }) => ({ id, task, tier })))); return;
      }
      if (host === 'claude' && req.method === 'POST' && (url.pathname === '/api/tier' || /^\/api\/actions\/[a-f0-9]{24}$/.test(url.pathname))) {
        let body = ''; let oversized = false;
        req.on('data', chunk => { if (Buffer.byteLength(body) + chunk.length > 4096) oversized = true; else body += chunk; });
        req.on('end', () => {
          if (oversized) { send(413, 'application/json', '{"error":"Request too large."}'); return; }
          try {
            const input = JSON.parse(body);
            if (url.pathname === '/api/tier') {
              if (Date.now() - bridgeSeen >= 8000) throw new Error('Open this run in Claude before changing its model tier.');
              if (!['opus', 'sonnet', 'haiku'].includes(input.tier) || typeof input.task !== 'string') throw new Error('Choose a task and a valid Claude tier.');
              const raw = JSON.parse(fs.readFileSync(ledger, 'utf8'));
              if (raw.tasks.find(task => task.id === input.task)?.status !== 'queued') throw new Error('Only queued tasks can change model tier.');
              if ([...actions.values()].some(one => one.task === input.task && one.status === 'pending')) throw new Error('A model change for this task is already pending.');
              if (actions.size >= 64) { const done = [...actions.values()].find(one => one.status !== 'pending'); if (done) actions.delete(done.id); else throw new Error('Model changes are busy; retry shortly.'); }
              const id = randomBytes(12).toString('hex'); actions.set(id, { id, task: input.task, tier: input.tier, status: 'pending' });
              send(202, 'application/json', JSON.stringify({ id })); return;
            }
            const action = actions.get(url.pathname.split('/').pop());
            if (!action || !['applied', 'error'].includes(input.status) || typeof input.message !== 'string') throw new Error('Invalid action acknowledgement.');
            if (input.status === 'applied') {
              const raw = JSON.parse(fs.readFileSync(ledger, 'utf8'));
              const task = raw.tasks.find(task => task.id === action.task);
              if (task?.tier !== action.tier || task?.tierBy !== 'owner') throw new Error('The saved tier does not confirm this choice.');
            }
            action.status = input.status; action.message = input.message.slice(0, 300);
            send(200, 'application/json', '{"ok":true}');
          } catch (error) { send(409, 'application/json', JSON.stringify({ error: error.message })); }
        }); return;
      }
      send(405, 'application/json', '{"error":"This board is read-only. Use chat for run actions."}'); return;
    }
    if (req.method !== 'GET') { send(405, 'text/plain', 'Method not allowed'); return; }
    const asset = { '/': ['index.html', 'text/html; charset=utf-8'], '/board.js': ['board.js', 'text/javascript; charset=utf-8'], '/board.css': ['board.css', 'text/css; charset=utf-8'] }[url.pathname];
    if (!asset) { send(404, 'text/plain', 'Not found'); return; }
    send(200, asset[1], content[asset[0]]);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  const info = { protocol: BOARD_PROTOCOL, pid: process.pid, root, run: id, host, port, token };
  const temporary = `${descriptor}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(info), { mode: 0o600 }); fs.renameSync(temporary, descriptor); }
  catch (error) { server.close(); fs.rmSync(temporary, { force: true }); throw error; }
  const timer = setInterval(() => { if (Date.now() - lastRequest > idleMs) { server.close(); server.closeIdleConnections(); } }, Math.min(idleMs, 60_000));
  timer.unref();
  server.once('close', () => {
    clearInterval(timer);
    try { if (JSON.parse(fs.readFileSync(descriptor, 'utf8')).token === token) fs.unlinkSync(descriptor); } catch { /* Already stopped or replaced. */ }
  });
  return { server, info };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer(process.argv[2], process.argv[3], { host: process.argv[4] ?? 'codex' }).then(({ server }) => {
    const stop = () => { server.close(); server.closeIdleConnections(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
