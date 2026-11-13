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

export const BOARD_PROTOCOL = 2;

export const serverFile = (root, id) => {
  if (typeof id !== 'string' || !RUN_ID.test(id)) throw new Error('Invalid run id.');
  return path.join(root, '.codex/conductor/runs', id, 'board-server.json');
};

export function snapshot(file, offset = 0) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const parsed = parseLedger(JSON.stringify(raw));
  if (parsed.error) throw new Error(parsed.error);
  const ledger = parsed.ledger;
  const now = Date.now();
  const view = boardView(ledger, now);
  const task = row => ({ id: row.id, title: row.title, status: row.status, tier: row.tier, complexity: complexityOf(row.tier),
    modelSelection: row.status === 'done' ? undefined : selectModel('codex', row.tier, raw.codex?.models), recordedModel: row.model,
    files: row.files ?? [], dependsOn: row.dependsOn ?? [], note: row.note, ticket: row.ticket,
    detail: detail(row, complexityOf) });
  const groups = Object.fromEntries(['attention', 'building', 'returned', 'review', 'next', 'waiting', 'done'].map(key => [key, view[key].map(task)]));
  const minutes = runMinutes(ledger, now);
  return {
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

export async function startServer(root, id, { idleMs = 30 * 60_000 } = {}) {
  root = fs.realpathSync(root);
  const descriptor = serverFile(root, id);
  const ledger = path.join(path.dirname(descriptor), 'ledger.json');
  snapshot(ledger); // Refuse missing/invalid runs before opening a socket.
  const assets = fileURLToPath(new URL('../assets/board/', import.meta.url));
  // A skill update must not mix a running server's old data shape with new browser assets.
  const content = Object.fromEntries(['index.html', 'board.js', 'board.css'].map(name => [name, fs.readFileSync(path.join(assets, name))]));
  const token = randomBytes(32).toString('hex');
  let lastRequest = Date.now();
  let port;
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
      lastRequest = Date.now();
      if (req.method === 'GET' && url.pathname === '/api/health') { send(200, 'application/json', JSON.stringify({ protocol: BOARD_PROTOCOL, root, run: id })); return; }
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        res.setHeader('Connection', 'close'); send(200, 'application/json', '{"stopped":true}');
        setImmediate(() => { server.close(); server.closeIdleConnections(); }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/board') {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isInteger(offset) || Math.abs(offset) > 840) { send(400, 'application/json', '{"error":"Invalid time zone offset."}'); return; }
        try { send(200, 'application/json', JSON.stringify(snapshot(ledger, offset))); }
        catch { send(503, 'application/json', '{"error":"Cannot read the saved run. Showing the last successful snapshot; retrying automatically."}'); }
        return;
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
  const info = { protocol: BOARD_PROTOCOL, pid: process.pid, root, run: id, port, token };
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
  startServer(process.argv[2], process.argv[3]).then(({ server }) => {
    const stop = () => { server.close(); server.closeIdleConnections(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
