import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildSkill } from '../build.mjs';
const built = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-board-build-'));
const skill = buildSkill(path.join(built, 'conductor'));
const { Conductor } = await import(pathToFileURL(path.join(skill, 'scripts/conductor.mjs')).href);
const { startServer, snapshot, serverFile } = await import(pathToFileURL(path.join(skill, 'scripts/board-server.mjs')).href);
const { openBoard, closeBoard } = await import(pathToFileURL(path.join(skill, 'scripts/board-launcher.mjs')).href);
process.on('exit', () => fs.rmSync(built, { recursive: true, force: true }));
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor board project '));
  t.after(async () => { for (const id of fs.readdirSync(path.join(root, '.codex/conductor/runs'))) await closeBoard(root, id); await new Promise(r => setTimeout(r, 100)); fs.rmSync(root, { recursive: true, force: true }); });
  const app = new Conductor(root); app.init();
  await app.conduct({ id: 'run', source: 'Build a live board', title: 'Board <script>alert(1)</script>' });
  await app.apply('run', 'task_add', { id: 'one', title: 'First task', tier: 'sonnet', tierReason: 'Implementation', files: ['src/board.js'] });
  await app.apply('run', 'task_add', { id: 'two', title: 'Second task', tier: 'haiku', tierReason: 'Docs', files: ['docs/board.md'], dependsOn: ['one'] });
  const running = await startServer(root, 'run');
  const base = `http://127.0.0.1:${running.info.port}`;
  const headers = { Authorization: `Bearer ${running.info.token}` };
  return { root, app, base, headers, ...running };
}

test('live board reads current saved state without mutating approval, tasks or Claude data', async t => {
  const { root, app, base, headers } = await fixture(t);
  fs.mkdirSync(path.join(root, '.claude/conductor/runs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/conductor/runs/untouched'), 'Claude board');
  const first = await (await fetch(base + '/api/board', { headers })).json();
  assert.equal(first.run.plan, 'draft'); assert.equal(first.groups.next[0].id, 'one');
  assert.equal(first.groups.waiting[0].id, 'two'); assert.deepEqual(first.groups.next[0].files, ['src/board.js']);
  assert.equal(first.groups.next[0].complexity, 'implementation');
  assert.deepEqual(first.groups.next[0].modelSelection, { kind: 'inherit', label: 'current Codex model' });
  assert.doesNotMatch(first.groups.next[0].detail, /sonnet/);
  await app.apply('run', 'run_plan');
  const second = await (await fetch(base + '/api/board', { headers })).json();
  assert.equal(second.run.plan, 'proposed');
  assert.equal((await app.worktree('run', { task: 'one' })).isError, true);
  await app.apply('run', 'approve', {}, { kind: 'owner' });
  await app.apply('run', 'task_update', { task: 'one', status: 'done' });
  await app.apply('run', 'problem_report', { severity: 'warning', task: 'two', text: 'Missing fixture' });
  await app.apply('run', 'board_post', { kind: 'question', text: 'Which fixture?' }, { kind: 'worker', taskId: 'two' });
  await app.apply('run', 'pause', {}, { kind: 'owner' });
  const third = await (await fetch(base + '/api/board?offset=60', { headers })).json();
  assert.equal(third.completed, 1); assert.equal(third.total, 2); assert.equal(third.groups.next[0].id, 'two');
  assert.equal(third.problems[0].text, 'Missing fixture'); assert.equal(third.questions[0].text, 'Which fixture?');
  assert.ok(third.run.pausedAt);
  assert.equal(fs.readFileSync(path.join(root, '.claude/conductor/runs/untouched'), 'utf8'), 'Claude board');
});

test('loopback board protects saved data with a token, host and origin checks, and has no run writes', async t => {
  const { app, base, headers, server } = await fixture(t);
  assert.equal(server.address().address, '127.0.0.1');
  const before = fs.readFileSync(app.ledgerFile('run'), 'utf8');
  assert.equal((await fetch(base + '/api/board')).status, 401);
  assert.equal((await fetch(base + '/api/board', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(base + '/api/board', { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
  const spoofed = await new Promise((resolve, reject) => { http.get(base + '/api/board', { headers: { ...headers, Host: 'example.com' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject); });
  assert.equal(spoofed, 403);
  assert.equal((await fetch(base + '/api/approve', { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(base + '/api/board', { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(base + '/api/stop', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/ledger.json')).status, 404);
  assert.equal((await fetch(base + '/api/board?offset=9000', { headers })).status, 400);
  assert.equal(fs.readFileSync(app.ledgerFile('run'), 'utf8'), before);
  const page = await fetch(base);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.ok(!(await page.text()).includes('alert(1)'));
  assert.equal((await fetch(base + '/board.js')).status, 200);
  assert.equal((await fetch(base + '/board.css')).status, 200);
});

test('invalid or temporarily missing ledger returns an honest error and recovers from the next save', async t => {
  const { app, base, headers } = await fixture(t);
  const before = fs.readFileSync(app.ledgerFile('run'), 'utf8');
  fs.writeFileSync(app.ledgerFile('run'), '{');
  assert.equal((await fetch(base + '/api/board', { headers })).status, 503);
  fs.writeFileSync(app.ledgerFile('run'), before);
  assert.equal((await fetch(base + '/api/board', { headers })).status, 200);
});

test('launcher reuses a run server across CLI exits and concurrent opens, then stops and recovers', async t => {
  const { root, app, base } = await fixture(t);
  assert.equal((await openBoard(root, 'run')).url.split('/#')[0], base);
  await closeBoard(root, 'run'); await new Promise(r => setTimeout(r, 100));
  const [one, two] = await Promise.all([openBoard(root, 'run'), openBoard(root, 'run')]);
  assert.equal(one.url, two.url);
  assert.equal([one, two].filter(v => !v.reused).length, 1);
  const info = JSON.parse(fs.readFileSync(serverFile(root, 'run'), 'utf8'));
  assert.equal((await fetch(one.url, { headers: { Authorization: `Bearer ${info.token}` } })).status, 200);
  const before = fs.readFileSync(app.ledgerFile('run'), 'utf8');
  assert.deepEqual(await closeBoard(root, 'run'), { stopped: true });
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(await closeBoard(root, 'run'), { stopped: false });
  fs.writeFileSync(serverFile(root, 'run'), JSON.stringify({ ...info, port: 1 }));
  const lock = path.join(path.dirname(serverFile(root, 'run')), '.board-start.lock');
  fs.mkdirSync(lock);
  const stale = new Date(Date.now() - 60_000); fs.utimesSync(lock, stale, stale);
  const reopened = await openBoard(root, 'run'); assert.equal(reopened.reused, false);
  assert.notEqual(reopened.url, one.url); assert.equal(fs.readFileSync(app.ledgerFile('run'), 'utf8'), before);
});

test('CLI conduct starts a live board automatically; board_open resumes it without approval', async t => {
  const { root } = await fixture(t);
  const cli = path.join(skill, 'scripts/conductor.mjs');
  const input = path.join(root, 'input.json'); fs.writeFileSync(input, JSON.stringify({ id: 'new-run', source: 'CLI run' }));
  const result = JSON.parse(execFileSync(process.execPath, [cli, 'conduct', '--root', root, '--input', input], { encoding: 'utf8' }));
  assert.match(result.boardView.url, /^http:\/\/127\.0\.0\.1:\d+\/#/);
  const resumed = JSON.parse(execFileSync(process.execPath, [cli, 'board_open', '--root', root, '--run', 'new-run'], { encoding: 'utf8' }));
  assert.equal(resumed.boardView.url, result.boardView.url); assert.equal(resumed.boardView.reused, true);
  assert.throws(() => execFileSync(process.execPath, [cli, 'board_open', '--root', root, '--run', 'new-run', '--caller', 'worker:one'], { stdio: 'pipe' }), /Command failed/);
  assert.equal(new Conductor(root).load('new-run').run.plan, 'draft');
  execFileSync(process.execPath, [cli, 'board_close', '--root', root, '--run', 'new-run'], { encoding: 'utf8' });
});

test('idle server exits and removes only its own runtime descriptor', async t => {
  const { root } = await fixture(t);
  await closeBoard(root, 'run'); await new Promise(r => setTimeout(r, 100));
  const { server } = await startServer(root, 'run', { idleMs: 40 });
  await new Promise(resolve => server.once('close', resolve));
  assert.equal(fs.existsSync(serverFile(root, 'run')), false);
});

test('invalid run paths and missing runs cannot start servers', async () => {
  assert.throws(() => serverFile(built, '../other'), /Invalid run/);
  assert.throws(() => serverFile(built, undefined), /Invalid run/);
  await assert.rejects(() => openBoard(built, 'missing'), /No saved run/);
  assert.throws(() => snapshot(path.join(built, 'missing.json')), /ENOENT/);
});

test('a skill update replaces an authenticated older board server instead of keeping stale model labels', async t => {
  const { root } = await fixture(t);
  await closeBoard(root, 'run'); await new Promise(r => setTimeout(r, 100));
  const token = 'a'.repeat(64); let stopped = false;
  const old = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') res.end(JSON.stringify({ protocol: 1, root: fs.realpathSync(root), run: 'run' }));
    else { stopped = true; res.setHeader('Connection', 'close'); res.end('{"stopped":true}'); setImmediate(() => { old.close(); old.closeIdleConnections(); }); }
  });
  await new Promise(resolve => old.listen(0, '127.0.0.1', resolve));
  t.after(() => { old.close(); old.closeIdleConnections(); });
  fs.writeFileSync(serverFile(root, 'run'), JSON.stringify({ protocol: 1, root: fs.realpathSync(root), run: 'run', port: old.address().port, token }));
  const upgraded = await openBoard(root, 'run');
  assert.equal(stopped, true); assert.equal(upgraded.reused, false);
  const info = JSON.parse(fs.readFileSync(serverFile(root, 'run'), 'utf8'));
  const snapshot = await (await fetch(upgraded.url.split('/#')[0] + '/api/board', { headers: { Authorization: `Bearer ${info.token}` } })).json();
  assert.equal(snapshot.groups.next[0].complexity, 'implementation');
  assert.equal(snapshot.groups.next[0].modelSelection.kind, 'inherit');
});
