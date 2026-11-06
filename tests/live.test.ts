import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Ledger, Task } from '../types'
import { LEDGER, NOW, withTask } from './fixture'
import { board, file, ledgerPath, picture$, spawn, start, world } from './world'
import type { Files } from './world'

const PATH = ledgerPath('demo')
const stored = (files: Files): Ledger & Record<string, unknown> => JSON.parse(files[PATH]?.text ?? '{}') as Ledger & Record<string, unknown>
const task = (files: Files, id: string): Task => stored(files).tasks.find(one => one.id === id)!

/** A tool call as the engine raises it for the loop `agentId` (the main conversation when absent). */
const call = ($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ text?: string; isError?: true }>)({
    tool,
    tool_use_id: `call-${tool}`,
    ...input,
    ...(agentId === undefined ? {} : { agentId }),
  })

const turnEnds = ($: Engine, agentId: string, reason: 'answer' | 'aborted' = 'answer') =>
  $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: reason === 'aborted', turnId: `turn-${agentId}`, agentId, reason })

test('a worker started for a task shows on the board without anyone writing it down', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const keeps = { ...LEDGER, extras: [{ id: 'X1', text: 'kept' }] }
  const files: Files = { [PATH]: { text: JSON.stringify(keeps), mtimeMs: 1 } }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')

  engine.agentIds.push('a1')
  const started = await spawn($, 't392-1')
  expect(started.agentId, 'the spawn itself is untouched').toBe('a1')
  expect(task(files, 't392-1')).toMatchObject({
    status: 'building',
    worker: 't392-1',
    agentId: 'a1',
    model: 'claude-haiku-5-5',
    startedAt: new Date(NOW).toISOString(),
  })
  expect(stored(files).extras, 'what this version does not know survives the write').toEqual([{ id: 'X1', text: 'kept' }])

  await clock.advance(2000)
  expect((await picture$($, 'desktop')).source).toContain('>3 building<')
})

test('what a worker is doing reaches the ledger within seconds, and a command\'s text never does', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(LEDGER, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')
  engine.agentIds.push('a1')
  await spawn($, 't392-1')

  await call($, 'Bash', { command: 'curl -H "Authorization: token s3cr3t-value" https://repo', description: 'Read the PR status' }, 'a1')
  expect(task(files, 't392-1').activity?.text, 'not written on every call').toBe('started')
  await clock.advance(5000)
  expect(task(files, 't392-1').activity).toEqual({ at: new Date(NOW + 5000).toISOString(), text: 'Bash: Read the PR status' })
  expect(files[PATH]?.text).not.toContain('s3cr3t-value')

  await call($, 'Read', { file_path: '/repo/docs/DEPLOY.md' }, 'a1')
  await call($, 'Edit', { file_path: '/repo/frontend/src/copy/status.ts', old_string: 'a', new_string: 'b' }, 'a1')
  await clock.advance(5000)
  expect(task(files, 't392-1').activity?.text, 'the latest of several').toBe('Edit status.ts')
  expect(engine.ran.map(one => one.tool), 'the calls themselves ran').toEqual(['Bash', 'Read', 'Edit'])

  const writes = files[PATH]?.mtimeMs
  await clock.advance(5000)
  expect(files[PATH]?.mtimeMs, 'a quiet worker causes no write').toBe(writes)
})

test('a turn that ends hands the task back, and a resumed worker makes it building again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(LEDGER, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')
  engine.agentIds.push('a1')
  await spawn($, 't392-1')

  await call($, 'Read', { file_path: '/repo/docs/DEPLOY.md' }, 'a1')
  await clock.advance(1000)
  await turnEnds($, 'a1')
  expect(task(files, 't392-1')).toMatchObject({
    status: 'returned',
    finishedAt: new Date(NOW + 1000).toISOString(),
    activity: { text: 'handed back' },
  })
  const handedBack = await picture$($, 'desktop')
  await clock.advance(2000)
  expect((await picture$($, 'desktop')).source).toContain('>Handed back<')
  expect(handedBack.alt).toBeDefined()

  await call($, 'Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, 'a1')
  await clock.advance(5000)
  expect(task(files, 't392-1').status).toBe('building')
  expect(task(files, 't392-1').finishedAt).toBeUndefined()
})

test('a worker\'s own subagent counts as the worker, and its ending hands nothing back', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(LEDGER, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')
  engine.agentIds.push('a1', 'child')
  await spawn($, 't392-1')
  await spawn($, undefined, 'a1')

  await call($, 'Grep', { pattern: 'busyRetrying' }, 'child')
  await clock.advance(5000)
  expect(task(files, 't392-1').activity?.text).toBe('Grep')
  await turnEnds($, 'child')
  expect(task(files, 't392-1').status, 'only the worker\'s own turn hands back').toBe('building')
})

test('agents that are no task\'s worker, and a session that only views, write nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(LEDGER, 1) }
  const engine = world(on, files)
  await start($)

  await board($)
  engine.agentIds.push('a1')
  await spawn($, 't392-1')
  await call($, 'Read', { file_path: '/repo/x' }, 'a1')
  await turnEnds($, 'a1')
  await clock.advance(5000)
  expect(files[PATH]?.mtimeMs, 'view only').toBe(1)
  expect((await call($, 'mcp__conductor__task_update', { task: 't392-1', status: 'done' })).text).toMatch(/^Not done\. This session is bound to no run/)

  expect(engine.spawns, 'and its agents start exactly as asked').toEqual([{ name: 't392-1', model: undefined, subagentType: 'general-purpose' }])

  await board($, 'demo')
  engine.agentIds.push('a2')
  const helper = await spawn($, undefined, undefined, { subagentType: 'Explore' })
  expect(helper.agentId, 'a read-only helper starts without a task').toBe('a2')
  await call($, 'Read', { file_path: '/repo/x' }, 'a2')
  await turnEnds($, 'a2')
  await clock.advance(5000)
  const stranger = await call($, 'mcp__conductor__task_update', { task: 't392-1', status: 'failed' }, 'a2')
  expect(stranger.isError, 'an agent of another name may not write the board either').toBe(true)
  expect(files[PATH]?.mtimeMs, 'an agent of another name').toBe(1)
})

test('the orchestrator and a worker change the board through the tools, each within its rights', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(LEDGER, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')
  engine.agentIds.push('a1')
  await spawn($, 't392-1')

  const mine = await call($, 'mcp__conductor__task_update', { task: 't392-1', status: 'review', pr: 552, note: 'CI running' }, 'a1')
  expect(mine).toMatchObject({ text: 't392-1: status review, note set, PR 552.' })
  expect(mine.isError).toBeUndefined()
  expect(task(files, 't392-1')).toMatchObject({ status: 'review', pr: 552, note: 'CI running' })

  const theirs = await call($, 'mcp__conductor__task_update', { task: 't394-1', status: 'failed' }, 'a1')
  expect(theirs.isError).toBe(true)
  expect(theirs.text, 'a refusal says so in its first words: the model reads the text, not the flag').toBe(
    'Not done. You are the worker of t392-1 and may only update that task, not t394-1.',
  )
  expect(task(files, 't394-1').status).toBe('building')

  expect((await call($, 'mcp__conductor__task_update', { task: 't392-1', status: 'done' }, 'a1')).isError).toBe(true)
  expect(
    (await call($, 'mcp__conductor__task_update', { task: 't392-1', status: 'done' })).text,
    'a task with a pull request is done through the merge alone, the orchestrator\'s word included',
  ).toMatch(/^Not done\. t392-1 has a pull request, so it is done once that is merged: call mcp__conductor__merge/)
  expect((await call($, 'mcp__conductor__task_update', { task: 't392-1', status: 'green' })).text).toBe('t392-1: status green.')
  expect(task(files, 't392-1').status).toBe('green')
  expect((await call($, 'mcp__conductor__task_update', { task: 't392-2', status: 'done' })).text, 'no pull request: done is the orchestrator\'s to say').toBe('t392-2: status done.')
  expect(engine.ran, 'the mod answers its own tools; none reaches the engine').toEqual([])
})

test('a problem a worker reports shows under its task, and the orchestrator resolves it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(LEDGER, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')
  engine.agentIds.push('a1')
  await spawn($, 't392-1')

  const reported = await call($, 'mcp__conductor__problem_report', { text: 'The deck test reads a stale twin', severity: 'blocker' }, 'a1')
  expect(reported.text).toBe('P4 recorded (blocker, t392-1).')
  await clock.advance(2000)
  expect((await picture$($, 'desktop')).source).toContain('The deck test reads a stale twin')

  expect((await call($, 'mcp__conductor__problem_resolve', { problem: 'P4', resolution: 'regenerated' }, 'a1')).isError).toBe(true)
  expect((await call($, 'mcp__conductor__problem_resolve', { problem: 'P4', resolution: 'regenerated' })).text).toBe('P4 resolved.')
  expect(stored(files).problems.find(one => one.id === 'P4')).toMatchObject({ status: 'resolved', resolution: 'regenerated' })
})

test('a worker the ledger already names is known again without a new start', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(withTask('t391-1', { agentId: 'a9' }), 1) }
  world(on, files)
  await start($)
  await board($, 'demo')

  expect((await call($, 'mcp__conductor__task_update', { task: 't391-1', note: 'back after a restart' }, 'a9')).text).toBe('t391-1: note set.')
  await turnEnds($, 'a9')
  expect(task(files, 't391-1').status).toBe('returned')
})

test('changes asked for at the same moment all land', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(LEDGER, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')
  engine.agentIds.push('a1')

  await Promise.all([
    spawn($, 't392-1'),
    call($, 'mcp__conductor__task_update', { task: 't395-1', status: 'blocked' }),
    call($, 'mcp__conductor__problem_report', { text: 'One', severity: 'note' }),
    call($, 'mcp__conductor__problem_report', { text: 'Two', severity: 'note' }),
    call($, 'mcp__conductor__task_update', { task: 't396-1', note: 'box ordered' }),
  ])
  expect(task(files, 't392-1').status).toBe('building')
  expect(task(files, 't395-1').status).toBe('blocked')
  expect(task(files, 't396-1').note).toBe('box ordered')
  expect(stored(files).problems.map(one => one.id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5'])
})

test('a bound session is told the run\'s conventions in its system prompt, the same words every turn', async ($, on) => {
  mock.clock(on, { now: NOW })
  world(on, { [PATH]: file(LEDGER, 1) })
  await start($)
  const compose = () =>
    $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })

  expect((await compose()).sections.map(one => one.id)).toEqual(['intro'])
  await board($, 'demo')
  const first = await compose()
  expect(first.sections.map(one => one.id)).toEqual(['intro', 'conductor:run'])
  expect(first.sections[1]).toMatchObject({ scope: 'session' })
  expect(first.sections[1]?.text).toContain('bound to run `demo`')
  expect(first.sections[1]?.text).toContain('mcp__conductor__task_update')
  await call($, 'mcp__conductor__task_update', { task: 't395-1', status: 'blocked' })
  expect((await compose()).sections[1]?.text, 'nothing live in it').toBe(first.sections[1]?.text)
})
