import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Ledger } from '../types'
import { boundKey } from '../hooks/store'
import { GIT_WS, HOME_ROOT, composePrompt, folderLedgerPath, folderWorld, startAt } from './folder-world'
import { NOW } from './fixture'
import { HOME, ROOT, board, codexRun, file, ledgerPath, spawn, start, world } from './world'
import type { Files } from './world'

const PATH = ledgerPath('demo')
const WORKTREE = `${ROOT}.conductor/demo/t1`
const call = ($: Engine, input: Record<string, unknown>, agentId?: string) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ text?: string; isError?: true }> )({ tool: 'mcp__conductor__worker_start', tool_use_id: 'codex-start', ...input, ...(agentId === undefined ? {} : { agentId }) })
const stored = (files: Files): Ledger => JSON.parse(files[PATH]!.text) as Ledger
const task = (files: Files, id = 't1') => stored(files).tasks.find(one => one.id === id)!
const set = (files: Files, change: (ledger: Ledger) => void) => { const ledger = stored(files); change(ledger); files[PATH] = file(ledger, files[PATH]!.mtimeMs + 1) }
const git = (argv: readonly string[]) => argv[0] === 'git' && argv[3] === 'worktree' && argv[4] === 'add'

const paragraph = 'A task whose kind is codex is started with `worker_start`, not with the Agent tool. It cannot be messaged; a ruling reaches it only if it needs a second turn. It ends by itself: you are woken with its pull request, or with why it failed.'

test('worker_start claims its task and records its own branch and worktree', async ($, on) => {
  const { engine, files } = await codexRun($, on)
  expect(engine.registered).toContain('worker_start')
  expect(await call($, { task: 't1' })).toMatchObject({ text: `Codex is building \`t1\` in \`${WORKTREE}\`. You are woken when it ends.` })
  expect(task(files)).toMatchObject({ kind: 'codex', status: 'building', slot: 1, branch: 'conductor/demo/t1', workspace: WORKTREE })
  expect(engine.calls.filter(one => git(one.argv)).map(one => one.argv)).toEqual([['git', '-C', ROOT, 'worktree', 'add', '-b', 'conductor/demo/t1', WORKTREE, 'refs/remotes/origin/main']])
  expect(engine.spawns).toHaveLength(0)
})

test('two concurrent starts claim and make one worktree only', async ($, on) => {
  const { engine } = await codexRun($, on)
  const answers = await Promise.all([call($, { task: 't1' }), call($, { task: 't1' })])
  expect(answers.filter(one => one.text?.includes('Codex is building'))).toHaveLength(1)
  expect(engine.calls.filter(one => git(one.argv))).toHaveLength(1)
  expect((await call($, { task: 't1' })).text).toContain('already running')
})

test('concurrent different Codex starts count towards the same maxParallel', async ($, on) => {
  const { engine, files } = await codexRun($, on)
  set(files, ledger => { ledger.run.maxParallel = 1; ledger.tasks[1]!.kind = 'codex' })
  const answers = await Promise.all([call($, { task: 't1' }), call($, { task: 't2' })])
  expect(answers.filter(one => one.text?.includes('Codex is building'))).toHaveLength(1)
  expect(answers.find(one => one.isError)?.text).toContain('1 workers are building')
  expect(engine.calls.filter(one => git(one.argv))).toHaveLength(1)
})

test('each kind has its own start tool', async ($, on) => {
  const { engine, files } = await codexRun($, on)
  expect((await call($, { task: 't2' })).text).toContain('Agent tool')
  expect((await spawn($, 't1')).deny).toContain('worker_start')
  expect(task(files).status).toBe('queued')
  expect(engine.calls.filter(one => git(one.argv))).toHaveLength(0)
})

test('workers and unknown agents cannot start Codex tasks', async ($, on) => {
  const { files } = await codexRun($, on)
  await spawn($, 't2')
  for (const agent of ['unnamed', 'stranger']) expect((await call($, { task: 't1' }, agent)).text).toContain('Only the orchestrator')
  expect(task(files).status).toBe('queued')
})

test('worker_start rechecks approval, pause and dependencies in the ledger', async ($, on) => {
  const { files, engine } = await codexRun($, on)
  set(files, ledger => { ledger.run.plan = 'proposed' })
  expect((await call($, { task: 't1' })).text).toContain('approval')
  set(files, ledger => { ledger.run.plan = 'approved'; ledger.run.pausedAt = new Date(NOW).toISOString() })
  expect((await call($, { task: 't1' })).text).toContain('paused')
  set(files, ledger => { delete ledger.run.pausedAt; ledger.tasks[0]!.dependsOn = ['t2'] })
  expect((await call($, { task: 't1' })).text).toContain('waits for t2')
  expect(engine.calls.filter(one => git(one.argv))).toHaveLength(0)
})

test('a green dependency supplies the worktree base branch', async ($, on) => {
  const { files, engine } = await codexRun($, on)
  set(files, ledger => { ledger.tasks[0]!.dependsOn = ['t2']; Object.assign(ledger.tasks[1]!, { status: 'green', branch: 'feat/two' }) })
  expect((await call($, { task: 't1' })).isError).toBeUndefined()
  expect(engine.calls.filter(one => git(one.argv))[0]!.argv.at(-1)).toBe('refs/remotes/origin/feat/two')
})

test('a worktree failure releases the claim so it can be retried', async ($, on) => {
  const { files, engine } = await codexRun($, on)
  const before = task(files)
  engine.programs.unshift({ match: git, answer: { exitCode: 1, stdout: '', stderr: 'cannot make worktree' } })
  expect((await call($, { task: 't1' })).text).toContain('cannot make worktree')
  expect(task(files)).toEqual(before)
  engine.programs.shift()
  expect((await call($, { task: 't1' })).text).toContain('Codex is building')
})

test('a thrown worktree failure also releases the claim', async ($, on) => {
  const { files, engine } = await codexRun($, on)
  const before = task(files)
  engine.programs.unshift({ match: git, answer: () => { throw new Error('worktree exploded') } })
  expect((await call($, { task: 't1' })).text).toContain('worktree could not be made')
  expect(task(files)).toEqual(before)
})

test('a failed ledger write starts no process and makes no worktree', async ($, on) => {
  const { files, engine } = await codexRun($, on)
  engine.isReadOnly = true
  expect((await call($, { task: 't1' })).isError).toBe(true)
  expect(task(files).status).toBe('queued')
  expect(engine.calls.filter(one => git(one.argv))).toHaveLength(0)
})

test('off runs register no worker_start and preserve the standing instructions', async ($, on) => {
  const files: Files = {}
  const engine = world(on, files)
  await start($)
  expect(engine.registered).not.toContain('worker_start')
  expect((await composePrompt($)).sections.map(one => one.text).join('\n')).not.toContain(paragraph)
})

test('the ready-only paragraph is added on binding and removed on unbinding', async ($, on) => {
  await codexRun($, on)
  expect((await composePrompt($)).sections.map(one => one.text).join('\n')).toContain(paragraph)
  await board($, 'none')
  expect((await call($, { task: 't1' })).isError).toBe(true)
  expect((await composePrompt($)).sections.map(one => one.text).join('\n')).not.toContain(paragraph)
})

test('a retained tool refuses when the newly bound run has Codex off', async ($, on) => {
  const { files, ledger } = await codexRun($, on)
  files[ledgerPath('off')] = file({ ...ledger, run: { ...ledger.run, id: 'off', codex: { ready: false, why: 'not installed' } } }, 1)
  await board($, 'off')
  expect((await call($, { task: 't1' })).text).toContain('not installed')
})

test('restoring a ready binding at session start registers worker_start', async ($, on) => {
  const { engine } = await codexRun($, on, { store: { [boundKey('session-1')]: { run: 'demo', root: ROOT, at: new Date(NOW).toISOString() } } })
  expect(engine.registered.filter(name => name === 'worker_start')).toHaveLength(1)
})

test('unknown or malformed task input refuses without a worktree', async ($, on) => {
  const { engine } = await codexRun($, on)
  for (const input of [{}, { task: 1 }, { task: 'missing' }]) expect((await call($, input)).isError).toBe(true)
  expect(engine.calls.filter(one => git(one.argv))).toHaveLength(0)
})

/** Exercise fake host handlers directly: the testing actor exposes engine events, not host effects. */
function scriptedWorld() {
  type Callback = (...args: unknown[]) => unknown
  const hooks = new Map<string, Callback>()
  const record = ((name: string, callback: Callback) => { hooks.set(name, callback) }) as unknown as On
  const engine = world(record, {})
  const invoke = (name: string, event: unknown, next: unknown = {}) => hooks.get(name)!(undefined, event, next)
  const run = (argv: string[], cwd?: string) => invoke('process.run', { argv, init: { cwd } }) as Promise<{ value: { exitCode: number; stdout: string } }>
  const stream = (controller: AbortController) => invoke('process.spawn', { argv: ['codex', 'exec'], cwd: WORKTREE, input: 'Build it.' }, { signal: controller.signal }) as AsyncGenerator<{ stream: string; text: string }, { value: { code: number | null; signal: string | null } }>
  return { engine, invoke, run, stream }
}

test('the Codex world answers CLI readiness and reads its supplied config', async () => {
  const { engine, run, invoke } = scriptedWorld()
  Object.assign(engine.codex, { version: 'codex-cli 0.167.0', login: true, toml: '[mcp_servers.test]' })
  expect((await run(['codex', '--version'])).value.stdout).toBe('codex-cli 0.167.0')
  expect((await run(['codex', 'login', 'status'])).value.exitCode).toBe(0)
  expect(invoke('fs.read', { path: `${HOME}/.codex/config.toml` })).toEqual({ value: '[mcp_servers.test]' })
  engine.codex.version = false; engine.codex.login = false
  expect((await run(['codex', '--version'])).value.exitCode).toBe(127)
  expect((await run(['codex', 'login', 'status'])).value.exitCode).toBe(1)
})

test('the Codex world plays event lines, records stdin and status changes, and returns its code', async () => {
  const { engine, run, stream } = scriptedWorld()
  const event = { type: 'thread.started', thread_id: 'th-1' }
  engine.codex.turns.push({ events: [event], code: 7, writes: ['src/a.ts'] })
  const turn = stream(new AbortController())
  expect(await turn.next()).toMatchObject({ done: false, value: { stream: 'stdout', text: `${JSON.stringify(event)}\n` } })
  expect(await turn.next()).toMatchObject({ done: true, value: { value: { code: 7 } } })
  expect((await run(['git', 'status', '--porcelain'], WORKTREE)).value.stdout).toBe(' M src/a.ts')
  expect(engine.codex.inputs).toEqual(['Build it.'])
})

test('a held Codex turn cancels through the engine stream signal and releases pending next', async () => {
  const { engine, stream } = scriptedWorld()
  engine.codex.turns.push({ events: [{ type: 'turn.completed' }], code: 0, holds: true })
  const controller = new AbortController()
  const turn = stream(controller)
  await turn.next()
  const pending = turn.next()
  // HookStream.return aborts next.signal before closing its underlying generator.
  controller.abort()
  await turn.return({ value: { code: null, signal: 'SIGTERM' } })
  expect((await pending).done).toBe(true)
  expect(engine.stopped).toEqual([['codex', 'exec']])
})

test('a folder-home Codex worker uses its run repository and base instead of the session home', async ($, on) => {
  mock.clock(on, { now: NOW })
  const path = folderLedgerPath('demo')
  const ledger: Ledger = {
    version: 1,
    run: { id: 'demo', title: 'Codex', source: '#1', startedAt: new Date(NOW).toISOString(), plan: 'approved', codex: { ready: true }, workspace: { kind: 'git', root: GIT_WS, place: 'studio', base: 'develop' } },
    tasks: [{ id: 't1', title: 'One', tier: 'sonnet', status: 'queued', kind: 'codex', files: ['src/a.ts'] }],
    problems: [], posts: [], rulings: [],
  }
  const files: Files = { [path]: file(ledger, 1) }
  const engine = folderWorld(on, files)
  engine.programs.unshift({ match: argv => argv[0] === 'git', answer: { exitCode: 0, stdout: '' } })
  await startAt($)
  await board($, 'demo')
  expect((await call($, { task: 't1' })).isError).toBeUndefined()
  expect(engine.cwd).toBe(HOME_ROOT)
  expect(engine.calls.find(one => git(one.argv))!.argv).toEqual(['git', '-C', GIT_WS, 'worktree', 'add', '-b', 'conductor/demo/t1', `${GIT_WS}.conductor/demo/t1`, 'refs/remotes/origin/develop'])
})

test('a task taken back during worktree preparation starts no Codex carrier', async ($, on) => {
  const { files, engine } = await codexRun($, on)
  engine.programs.unshift({ match: git, answer: () => { set(files, ledger => { ledger.tasks[0]!.status = 'returned' }); return { exitCode: 0, stdout: '' } } })
  expect((await call($, { task: 't1' })).text).toContain('was taken back')
  expect(task(files).status).toBe('returned')
  expect(task(files).workspace).toBeUndefined()
  engine.programs.shift()
  expect((await call($, { task: 't1' })).text).toContain('Codex is building')
})
