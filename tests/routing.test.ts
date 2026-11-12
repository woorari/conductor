import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Ledger, Task } from '../types'
import { LEDGER, NOW, withTask } from './fixture'
import { PANE, board, file, ledgerPath, spawn, start, world } from './world'
import type { Files } from './world'

const PATH = ledgerPath('demo')
const stored = (files: Files): Ledger => JSON.parse(files[PATH]?.text ?? '{}') as Ledger
const task = (files: Files, id: string): Task => stored(files).tasks.find(one => one.id === id)!
const call = ($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ text?: string; isError?: true }>)({
    tool,
    tool_use_id: `call-${tool}`,
    ...input,
    ...(agentId === undefined ? {} : { agentId }),
  })
const command = ($: Engine, name: string, args: string) =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

async function bound($: Engine, on: Parameters<typeof world>[0], ledger: Ledger = LEDGER) {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(ledger, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')

  return { files, engine, clock }
}

test('a worker starts on its task\'s tier, whatever model the call named', async ($, on) => {
  const { files, engine } = await bound($, on)
  engine.agentIds.push('a1')

  const started = await spawn($, 't392-1', undefined, { model: 'opus' })
  expect(started.model).toBe('claude-haiku-5-5')
  expect(engine.spawns).toEqual([{ name: 't392-1', model: 'haiku', subagentType: 'general-purpose' }])
  expect(task(files, 't392-1')).toMatchObject({ status: 'building', model: 'claude-haiku-5-5' })
  expect(stored(files).problems).toHaveLength(3)
})

test('when the engine starts another model than the tier\'s, the board says so', async ($, on) => {
  const { files, engine } = await bound($, on)
  engine.agentIds.push('a1')
  engine.resolve = () => 'claude-opus-5-5'

  await spawn($, 't392-1')
  expect(stored(files).problems.at(-1)).toMatchObject({
    id: 'P4',
    severity: 'warning',
    taskId: 't392-1',
    text: 't392-1 is tagged haiku but its worker runs on claude-opus-5-5.',
  })
})

test('an agent that is no task\'s worker does not start, and nothing reaches the engine', async ($, on) => {
  const { files, engine } = await bound($, on)

  for (const [name, says] of [
    [undefined, 'every worker is a task'],
    ['explorer', 'every worker is a task'],
    ['t390-1', 't390-1 is done'],
    ['t391-1', 'already being built by w391'],
    ['t392-2', 't392-2 waits for t391-1 (building), t392-1 (queued)'],
  ] as const) {
    const refused = await spawn($, name)
    expect(refused.deny, String(name)).toContain(says)
    expect(refused.agentId, String(name)).toBeUndefined()
  }
  expect(engine.spawns).toEqual([])
  expect(files[PATH]?.mtimeMs, 'and nothing was written').toBe(1)
})

test('no more than three workers build at once', async ($, on) => {
  const { engine } = await bound($, on)
  engine.agentIds.push('a1')
  expect((await spawn($, 't392-1')).agentId, 'the third').toBe('a1')
  const fourth = await spawn($, 'w396')
  expect(fourth.deny).toContain('3 workers are building')
  expect(engine.spawns).toHaveLength(1)
})

test('a worker\'s own subagent is brought down to the worker\'s tier, never above it', async ($, on) => {
  const { engine } = await bound($, on, withTask('t392-1', { tier: 'sonnet' }))
  engine.agentIds.push('a1', 'c1', 'c2', 'c3')
  await spawn($, 't392-1')

  await spawn($, undefined, 'a1', { model: 'opus' })
  await spawn($, undefined, 'a1', { model: 'haiku', subagentType: 'Explore' })
  await spawn($, undefined, 'a1')
  expect(engine.spawns.slice(1).map(one => one.model)).toEqual(['sonnet', 'haiku', 'sonnet'])
  expect((await spawn($, undefined, 'c1', { model: 'opus' })).model, 'and its subagent\'s subagent').toBe('claude-sonnet-5-5')
})

test('forks, and a session bound to no run, are left exactly as asked', async ($, on) => {
  const { engine } = await bound($, on)
  engine.agentIds.push('f1', 'x1')
  await spawn($, undefined, undefined, { fork: true, model: 'opus' })
  expect(engine.spawns.at(-1)).toEqual({ name: undefined, model: 'opus', subagentType: 'general-purpose' })

  await board($, 'none')
  await spawn($, 'anything', undefined, { model: 'opus' })
  expect(engine.spawns.at(-1)).toEqual({ name: 'anything', model: 'opus', subagentType: 'general-purpose' })
})

test('a run with no ledger starts nobody, and says why', async ($, on) => {
  const { engine } = await bound($, on)
  await board($, 'absent')
  const refused = await spawn($, 't392-1')
  expect(refused.deny).toContain('has no ledger at')
  expect(engine.spawns).toEqual([])
})

test('the orchestrator adds a task with a tier and a reason, and its worker runs on that tier', async ($, on) => {
  const { files, engine } = await bound($, on)
  engine.agentIds.push('a1', 'a2')

  const added = await call($, 'mcp__conductor__task_add', {
    id: 't397-1',
    title: 'Review the write semantics of PR 565',
    tier: 'opus',
    tierReason: 'a second read of a risky change',
  })
  expect(added.text).toBe('t397-1 added: opus, queued.')
  await spawn($, 't392-1')
  const byWorker = await call($, 'mcp__conductor__task_add', { id: 't398-1', title: 'More', tier: 'haiku', tierReason: 'small' }, 'a1')
  expect(byWorker.text).toMatch(/^Not done\. Only the orchestrator adds a task/)

  await call($, 'mcp__conductor__task_update', { task: 't392-1', status: 'done' })
  await spawn($, 't397-1', undefined, { model: 'haiku' })
  expect(engine.spawns.at(-1)).toEqual({ name: 't397-1', model: 'opus', subagentType: 'general-purpose' })
  expect(task(files, 't397-1')).toMatchObject({ status: 'building', tier: 'opus', tierReason: 'a second read of a risky change' })
})

test('/tier is the owner\'s word on a task that has not started, and it stands', async ($, on) => {
  const { files, engine } = await bound($, on)
  engine.agentIds.push('a1')

  expect((await command($, 'tier', 't392-1 opus')).text).toBe('t392-1: haiku to opus.')
  expect(task(files, 't392-1')).toMatchObject({ tier: 'opus', tierBy: 'owner' })
  const back = await call($, 'mcp__conductor__task_update', { task: 't392-1', tier: 'haiku', tierReason: 'a copy change' })
  expect(back.text).toBe('Not done. The owner set t392-1 to opus; only they change it.')

  expect((await command($, 'tier', 't391-1 haiku')).text).toBe('t391-1 is building; a tier is set before a task starts.')
  expect((await command($, 'tier', 't392-1 gpt')).text).toContain('gpt is no tier')
  expect((await command($, 'tier', 't392-1')).text).toContain('/tier <task id> <opus|sonnet|haiku>')

  await spawn($, 't392-1')
  expect(engine.spawns.at(-1)?.model, 'the worker runs on what the owner chose').toBe('opus')
})

test('the pane has a tier picker for each task that has not started, in a bound session only', async ($, on) => {
  const { files, engine } = await bound($, on)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const pickers = await ui.findAll({ type: 'Select' })
    expect(pickers.map(one => [one.key, one.props.value]), surface).toEqual([
      ['tier-t392-1', surface === 'desktop' ? 'haiku' : 'sonnet'],
      ['tier-t392-2', 'sonnet'],
    ])
    await ui.select({ key: 'tier-t392-1', value: surface === 'desktop' ? 'sonnet' : 'opus' })
    await ui.unmount()
  }
  expect(task(files, 't392-1')).toMatchObject({ tier: 'opus', tierBy: 'owner' })
  expect(engine.toasts).toEqual(['t392-1: haiku to sonnet.', 't392-1: sonnet to opus.'])

  const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await phone.findAll({ type: 'Select' }), 'the phone draws no picker').toEqual([])
  await phone.unmount()

  await board($, 'none')
  const viewing = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await viewing.findAll({ type: 'Select' }), 'a session that only views sets nothing').toEqual([])
  await viewing.unmount()
})

/** A run whose plan is approved, with these tasks queued and nothing else in it. */
const fresh = (tasks: readonly { id: string; files: string[] }[]): Ledger => ({
  ...LEDGER,
  problems: [],
  tasks: tasks.map(one => ({ ...one, title: `Task ${one.id}`, tier: 'sonnet' as const, status: 'queued' as const })),
})
const BRIEF = '/repo/.claude/conductor/brief.md'

test('workers started in the same moment are decided one after the other: each its own number, and no more than the run allows', async ($, on) => {
  const { files, engine } = await bound($, on, fresh([
    { id: 'a', files: ['api/a.py'] },
    { id: 'b', files: ['api/b.py'] },
    { id: 'c', files: ['api/c.py'] },
    { id: 'd', files: ['api/d.py'] },
  ]))
  files[BRIEF] = { text: 'Your Redis database is 1{slot}.', mtimeMs: 1 }
  engine.agentIds.push('a1', 'a2', 'a3', 'a4')

  // One message of the orchestrator's that starts four agents: the four hooks run interleaved.
  const started = await Promise.all(['a', 'b', 'c', 'd'].map(id => spawn($, id)))

  expect(engine.spawns.map(one => one.name), 'three start').toEqual(['a', 'b', 'c'])
  expect((started[3] as { deny?: string }).deny).toBe('conductor: 3 workers are building, the most this run allows at once. Start d after a hand-back.')
  expect(['a', 'b', 'c'].map(id => task(files, id).slot), 'each with a number of its own').toEqual([1, 2, 3])
  expect(engine.briefs.map(one => /Your Redis database is (\d+)\./.exec(one)?.[1]), 'which is the one its briefing names').toEqual(['11', '12', '13'])
  expect(task(files, 'd')).toMatchObject({ status: 'queued' })
  expect(task(files, 'd').slot).toBeUndefined()
  expect(['a', 'b', 'c'].map(id => task(files, id).agentId)).toEqual(['a1', 'a2', 'a3'])
})

test('two workers asked for at once on one file: the second is refused', async ($, on) => {
  const { files, engine } = await bound($, on, fresh([
    { id: 'a', files: ['api/main.py'] },
    { id: 'b', files: ['api'] },
  ]))
  engine.agentIds.push('a1', 'a2')

  const started = await Promise.all([spawn($, 'a'), spawn($, 'b')])

  expect(engine.spawns.map(one => one.name)).toEqual(['a'])
  expect((started[1] as { deny?: string }).deny).toBe('conductor: b and a, which is building, both change api. Start b after a is done, or split the files.')
  expect(task(files, 'b').status).toBe('queued')
})

test('a start the engine refuses leaves the task as it stood, and its number free', async ($, on) => {
  const { files, engine } = await bound($, on, fresh([
    { id: 'a', files: ['api/a.py'] },
    { id: 'b', files: ['api/b.py'] },
  ]))
  const before = task(files, 'a')
  engine.noStart = 'the session is out of agents'

  expect((await spawn($, 'a') as { deny?: string }).deny).toBe('the session is out of agents')
  expect(task(files, 'a'), 'not left building with nobody on it').toEqual(before)

  engine.noStart = undefined
  engine.agentIds.push('a2')
  await spawn($, 'b')
  expect(task(files, 'b')).toMatchObject({ status: 'building', slot: 1, agentId: 'a2' })
})

test('a worker started again after a hand-back keeps its start time and gets a number that is free', async ($, on) => {
  const { files, engine, clock } = await bound($, on, fresh([
    { id: 'a', files: ['api/a.py'] },
    { id: 'b', files: ['api/b.py'] },
  ]))
  engine.agentIds.push('a1', 'a2', 'a3')
  await spawn($, 'a')
  await spawn($, 'b')
  const first = task(files, 'a').startedAt
  expect(first).toBe(new Date(NOW).toISOString())
  await clock.advance(20 * 60_000)
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 'turn-a1', agentId: 'a1', reason: 'answer' })
  expect(task(files, 'a').status).toBe('returned')

  await spawn($, 'a')
  expect(task(files, 'a')).toMatchObject({ status: 'building', slot: 1, agentId: 'a3', startedAt: first })
  expect(task(files, 'a').finishedAt).toBeUndefined()
})

test('a worker whose start cannot be written down is not started', async ($, on) => {
  const { files, engine } = await bound($, on, fresh([{ id: 'a', files: ['api/a.py'] }]))
  engine.agentIds.push('a1')
  engine.isReadOnly = true

  const refused = await spawn($, 'a') as { deny?: string }
  expect(refused.deny).toMatch(/^conductor: the board could not be written \(.*EROFS.*\), so no agent was started\.$/)
  expect(engine.spawns, 'nothing reached the engine').toEqual([])
  expect(task(files, 'a').status).toBe('queued')
})

const codexReady: Ledger = {
  ...LEDGER,
  run: { ...LEDGER.run, codex: { ready: true }, config: { workers: { codex: true,
    notes: [{ kind: 'codex', for: 'small standalone changes', proven: false }] } } },
}
const propertiesOf = (engine: Awaited<ReturnType<typeof bound>>['engine'], name: string) =>
  (engine.schemas[name] as { properties: Record<string, unknown> }).properties

test('/worker sets a queued task by the owner and the orchestrator cannot undo it', async ($, on) => {
  const { files, engine } = await bound($, on, codexReady)
  expect(engine.registered).toContain('/worker')
  expect((await command($, 'worker', 't392-1 codex')).text).toBe('t392-1: claude to codex.')
  expect(task(files, 't392-1')).toMatchObject({ kind: 'codex', kindWhy: 'owner' })
  const back = await call($, 'mcp__conductor__task_update', { task: 't392-1', kind: 'claude', kindReason: 'copy' })
  expect(back.text).toContain('The owner chose codex')
  expect((await command($, 'worker', 't392-1 claude')).text).toBe('t392-1: codex to claude.')
  expect(task(files, 't392-1')).toMatchObject({ kind: 'claude', kindWhy: 'owner' })
  expect((await command($, 'worker', 't391-1 codex')).text).toContain('has started')
  expect((await command($, 'worker', 'missing codex')).text).toContain('There is no task missing')
})

test('/worker reports usage for malformed input and refuses unavailable Codex', async ($, on) => {
  const { files } = await bound($, on)
  for (const args of ['', 't392-1', 't392-1 gemini', 't392-1 codex extra']) {
    expect((await command($, 'worker', args)).text).toContain('/worker <task> claude|codex')
  }
  expect((await command($, 'worker', 't392-1 codex')).text).toContain('off for this run')
  expect(task(files, 't392-1').kind).toBeUndefined()
})

test('worker-kind tool fields follow the bound run and disappear on unbinding', async ($, on) => {
  const { files, engine } = await bound($, on, codexReady)
  for (const name of ['task_add', 'task_update']) {
    expect(propertiesOf(engine, name)).toMatchObject({
      kind: { type: 'string', enum: ['claude', 'codex'] },
      kindReason: { type: 'string' },
      kindNote: { type: 'integer', minimum: 1 },
    })
  }
  const added = await call($, 'mcp__conductor__task_add', { id: 'trial', title: 'Trial', tier: 'sonnet',
    tierReason: 'implementation', kind: 'codex', kindReason: 'standalone', kindNote: 1 })
  expect(added.isError).not.toBe(true)
  expect(task(files, 'trial')).toMatchObject({ kind: 'codex', kindWhy: 'trial' })
  const updated = await call($, 'mcp__conductor__task_update', { task: 't392-2',
    kind: 'codex', kindReason: 'standalone implementation', kindNote: 1 })
  expect(updated.isError).not.toBe(true)
  expect(task(files, 't392-2')).toMatchObject({ kind: 'codex', kindWhy: 'trial', kindReason: 'standalone implementation' })
  files[ledgerPath('plain')] = file({ ...LEDGER, run: { ...LEDGER.run, id: 'plain' } }, 2)
  await board($, 'plain')
  expect((await command($, 'worker', 't392-1 codex')).text).toContain('off for this run')
  for (const name of ['task_add', 'task_update']) {
    for (const key of ['kind', 'kindReason', 'kindNote']) expect(Object.keys(propertiesOf(engine, name))).not.toContain(key)
  }
  await board($, 'demo')
  expect(Object.keys(propertiesOf(engine, 'task_add'))).toContain('kind')
  await board($, 'none')
  expect(Object.keys(propertiesOf(engine, 'task_add'))).not.toContain('kind')
})

test('a viewed ready run does not expose worker-kind fields until it is bound', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = world(on, { [PATH]: file(codexReady, 1) })
  await start($)
  for (const name of ['task_add', 'task_update']) {
    expect(Object.keys(propertiesOf(engine, name))).not.toContain('kind')
  }
})

test('restoring a ready run binding exposes worker-kind schemas at session start', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = world(on, { [PATH]: file(codexReady, 1) })
  engine.store['bound:session-1'] = { run: 'demo', root: '/repo', at: new Date(NOW).toISOString() }
  await start($)
  for (const name of ['task_add', 'task_update']) expect(Object.keys(propertiesOf(engine, name))).toContain('kind')
})

test('off-run schemas are restored exactly after a ready run', async ($, on) => {
  const { files, engine } = await bound($, on)
  const before = ['task_add', 'task_update'].map(name => engine.schemas[name])
  files[PATH] = file(codexReady, 2)
  await board($, 'demo')
  expect(Object.keys(propertiesOf(engine, 'task_update'))).toContain('kind')
  files[PATH] = file({ ...LEDGER, run: { ...LEDGER.run, codex: { ready: false, why: 'not installed' } } }, 3)
  await board($, 'demo')
  expect(['task_add', 'task_update'].map(name => engine.schemas[name])).toEqual(before)
})
