import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { boardView, summary } from '../hooks/board'
import { dashboardSvg } from '../hooks/dashboard'
import { handover } from '../hooks/handover'
import { parseLedger } from '../hooks/ledger'
import { obstacles, onMain, precheck, pullOf } from '../hooks/merge'
import type { Verdict } from '../hooks/merge'
import { PAUSED, UNPAUSED, pauseRun, pausedAt, unpauseRun } from '../hooks/pause'
import { route } from '../hooks/router'
import type { Raw } from '../hooks/signals'
import type { Ledger, Merge, Task } from '../types'
import { LEDGER, NOW } from './fixture'
import { board, ci, file, ledgerPath, mergeCommit, pull, spawn, start, world } from './world'
import type { Files } from './world'

const AT = '2026-10-09T10:30:00.000Z'
const PATH = ledgerPath('demo')
const HEAD = 'b'.repeat(40)
const HALF_MINUTE = 30_000
const raw = (ledger: Ledger = LEDGER): Raw => JSON.parse(JSON.stringify(ledger)) as Raw
const parsed = (ledger: Raw): Ledger => parseLedger(JSON.stringify(ledger)).ledger!
const PAUSED_RUN: Ledger = { ...LEDGER, run: { ...LEDGER.run, pausedAt: AT } }
const FLIGHT: Merge = { task: 't395-1', pr: 548, head: HEAD, state: 'merging', startedAt: AT }
const worker = { subagentType: 'general-purpose' }
const GREEN: Verdict = { verdict: 'green', line: 'build=success', failed: [] }

describe('the owner\'s hold on a run', () => {
  test('pausing writes since when, and says what is still under way', () => {
    const ledger = raw({ ...LEDGER, merge: FLIGHT })
    const said = pauseRun(ledger, AT)
    expect(said.text).toBe(
      'Run demo is paused until /unpause. Still finishing: t391-1, t394-1. The merge of t395-1 is still being settled with GitHub.',
    )
    expect(parsed(ledger).run.pausedAt).toBe(AT)
    expect(pausedAt(ledger)).toBe(AT)
    expect([said.wake, said.asks, said.answered], 'the orchestrator is told, and a notice that the run goes on is taken back').toEqual([PAUSED, 'pause', 'unpause'])

    const again = pauseRun(ledger, '2026-10-09T11:00:00.000Z')
    expect([again.isError, again.text]).toEqual([true, `Run demo is paused already, since ${AT}. /unpause lets it go on.`])
    expect(parsed(ledger).run.pausedAt, 'since the first time').toBe(AT)
  })

  test('with nobody building it says so', () => {
    const quiet: Ledger = { ...LEDGER, tasks: LEDGER.tasks.map(one => (one.status === 'building' ? { ...one, status: 'returned' as const } : one)) }
    expect(pauseRun(raw(quiet), AT).text).toBe('Run demo is paused until /unpause. Nobody is building.')
  })

  test('ending it takes the hold away, and tells the orchestrator', () => {
    const ledger = raw(PAUSED_RUN)
    const said = unpauseRun(ledger)
    expect(said.text).toBe('Run demo goes on.')
    expect(parsed(ledger).run.pausedAt).toBeUndefined()
    expect([said.wake, said.asks, said.answered]).toEqual([UNPAUSED, 'unpause', 'pause'])
    expect([unpauseRun(ledger).isError, unpauseRun(ledger).text]).toEqual([true, 'Run demo is not paused.'])
  })

  test('while it is paused no worker starts; a worker\'s own subagent and a read-only helper still do', () => {
    const decided = route(PAUSED_RUN, { ...worker, name: 't392-1' })
    expect(decided.kind === 'deny' ? decided.text : 'started').toBe(
      `conductor: run demo is paused by the owner since ${AT}. No worker starts until they type /unpause; workers that are building finish and hand back.`,
    )
    expect(route(PAUSED_RUN, { ...worker, parentTaskId: 't391-1' }).kind, 'a building worker goes on with its own helpers').toBe('child')
    expect(route(PAUSED_RUN, { subagentType: 'Explore' }).kind).toBe('pass')
    expect(route(LEDGER, { ...worker, name: 't392-1' }).kind, 'and without the hold it starts').toBe('worker')
  })

  test('while it is paused nothing is merged, and a merge check says so', () => {
    const asked = precheck(PAUSED_RUN, { kind: 'orchestrator' }, { task: 't395-1', told: [] }, [], false)
    expect(asked).toMatchObject({ pausedAt: AT })
    if ('error' in asked) throw new Error(asked.error)
    const facts = { pull: pullOf(pull(HEAD))!, checks: GREEN, base: 'main', baseHead: 'a'.repeat(40), main: GREEN }
    expect(obstacles(facts, asked)).toEqual([`The run is paused by the owner since ${AT}: nothing is merged until they type /unpause.`])
    const free = precheck(LEDGER, { kind: 'orchestrator' }, { task: 't395-1', told: [] }, [], false)
    expect('error' in free ? [] : obstacles(facts, free)).toEqual([])
  })

  test('a merge settled during a pause does not tell the orchestrator to start anything', () => {
    const during = onMain(raw({ ...PAUSED_RUN, merge: FLIGHT }), AT, mergeCommit(548), 'main')
    expect(during.text).toContain('The run is paused: nothing starts or merges until the owner types /unpause.')
    expect(during.text).not.toMatch(/start what can start|merge the next/i)
    expect(onMain(raw({ ...LEDGER, merge: FLIGHT }), AT, mergeCommit(548), 'main').text, 'and outside a pause it does').toContain('start what can start')
  })

  test('the board says it first, the pane asks for /unpause, and the handover carries it', () => {
    const view = boardView(PAUSED_RUN, NOW)
    expect(summary(view).startsWith('paused · 2 problems open')).toBe(true)
    const drawn = dashboardSvg(view, { width: 420, theme: 'dark' })
    expect(drawn.source).toContain('>The run is paused<')
    expect(drawn.source).toContain('>/unpause<')
    expect(drawn.source).toContain('>no worker starts and nothing merges until then<')
    expect(dashboardSvg(boardView(LEDGER, NOW), { width: 420, theme: 'dark' }).source).not.toContain('paused')
    expect(handover(PAUSED_RUN, { at: AT })).toContain(
      `The run is paused by the owner since ${AT}: no worker starts and nothing is merged until they type /unpause. Workers that are building finish and hand back.`,
    )
    expect(handover(LEDGER, { at: AT })).not.toContain('is paused')
  })

  test('a ledger whose pause has no proper time does not read', () => {
    expect(parseLedger(JSON.stringify({ ...LEDGER, run: { ...LEDGER.run, pausedAt: 'this evening' } })).error).toContain('run.pausedAt')
  })
})

type Ran = { text?: string; isError?: true; deny?: string; agentId?: string; context?: readonly string[] }
const raise = ($: Engine, input: Record<string, unknown>) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const call = ($: Engine, tool: string, input: Record<string, unknown>) => raise($, { tool: `mcp__conductor__${tool}`, tool_use_id: `call-${tool}`, ...input })
const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const of = (files: Files, id: string): Task => (JSON.parse(files[PATH]?.text ?? '{}') as Ledger).tasks.find(one => one.id === id)!
const run = (files: Files): Ledger['run'] => (JSON.parse(files[PATH]?.text ?? '{}') as Ledger).run

async function bound($: Engine, on: Parameters<typeof world>[0], ledger: Ledger = LEDGER) {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(ledger, 1) }
  const engine = world(on, files)
  engine.forge.pulls[548] = pull(HEAD)
  engine.forge.checks[HEAD] = ci('success')
  await start($)
  await board($, 'demo')

  return { clock, files, engine }
}

test('/pause holds the run in the mod itself: no start, no merge, what is under way finishes; /unpause lets it go on', async ($, on) => {
  // One place is free: one of the fixture's two workers has handed back.
  const ledger: Ledger = { ...LEDGER, tasks: LEDGER.tasks.map(one => (one.id === 't394-1' ? { ...one, status: 'returned' as const } : one)), merge: { ...FLIGHT, startedAt: new Date(NOW).toISOString() } }
  const { clock, files, engine } = await bound($, on, ledger)
  engine.forge.pulls[548] = pull(HEAD, { state: 'closed', merged: true, merge_commit_sha: mergeCommit(548) })
  engine.agentIds.push('sub1', 'a2')

  expect((await command($, 'pause')).text).toBe(
    'Run demo is paused until /unpause. Still finishing: t391-1. The merge of t395-1 is still being settled with GitHub.',
  )
  expect(run(files).pausedAt).toBe(new Date(NOW).toISOString())
  await clock.advance(5000)
  expect(engine.woke, 'an idle orchestrator is woken with it').toEqual([PAUSED])
  expect((await command($, 'pause')).text).toContain('is paused already')

  // Nothing new starts, whatever the orchestrator tries.
  expect((await spawn($, 't392-1') as Ran).deny).toContain('run demo is paused by the owner')
  expect(engine.spawns).toEqual([])
  expect(of(files, 't392-1').status).toBe('queued')
  // Nothing is merged.
  await call($, 'task_update', { task: 't393-1', status: 'green' })
  engine.forge.pulls[547] = pull('d'.repeat(40))
  engine.forge.checks['d'.repeat(40)] = ci('success')

  // What is under way goes on: the merge in flight is settled with GitHub, and says nothing about starting.
  await clock.advance(5 * HALF_MINUTE)
  expect(of(files, 't395-1').status).toBe('done')
  await clock.advance(5000)
  expect(engine.woke.at(-1)).toMatch(/^Run board: PR 548 \(t395-1\) is merged as [0-9a-f]{7}, and the task is done\.$/)
  expect((await call($, 'merge', { task: 't393-1', told: [] })).text).toBe(
    `Not done. Nothing was merged. t393-1 cannot merge now:\n- The run is paused by the owner since ${run(files).pausedAt}: nothing is merged until they type /unpause.`,
  )
  expect(engine.forge.merges).toEqual([])

  // The pause is in the ledger: the board shows it.
  await clock.advance(2000)
  expect((await board($)).text).toContain('Nightly import speed: paused · ')

  expect((await command($, 'unpause')).text).toBe('Run demo goes on.')
  expect(run(files).pausedAt).toBeUndefined()
  await clock.advance(5000)
  expect(engine.woke.at(-1)).toBe(UNPAUSED)
  expect((await spawn($, 't392-1') as Ran).agentId, 'and a worker starts again').toBe('sub1')
  expect((await call($, 'merge', { task: 't393-1', told: [] })).text).toMatch(/^Merged: PR 547/)
  expect((await command($, 'unpause')).text).toBe('Run demo is not paused.')
})

test('a working orchestrator reads the pause with its next tool result and is not woken for it as well', async ($, on) => {
  const { clock, engine } = await bound($, on)
  await $.turn.start({ text: 'Carry on.', turnId: 'turn-main' })
  await command($, 'pause')
  await clock.advance(5000)
  expect(engine.woke, 'not while its turn runs').toEqual([])
  const next = await raise($, { tool: 'Read', tool_use_id: 'read', file_path: '/repo/README.md' })
  expect(next.context?.join('\n')).toContain(PAUSED)
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 'turn-main', reason: 'answer' })
  await clock.advance(5000)
  expect(engine.woke, 'told once').toEqual([])
})

test('a pause taken back before the orchestrator read it leaves only the news that the run goes on', async ($, on) => {
  const { clock, engine } = await bound($, on)
  await $.turn.start({ text: 'Carry on.', turnId: 'turn-main' })
  await command($, 'pause')
  await command($, 'unpause')
  const next = await raise($, { tool: 'Read', tool_use_id: 'read', file_path: '/repo/README.md' })
  expect(next.context).toEqual([UNPAUSED])
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 'turn-main', reason: 'answer' })
  await clock.advance(5000)
  expect(engine.woke).toEqual([])
})

test('a pause outlives a restart of the app, and so does the session\'s hold on its run', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(PAUSED_RUN, 1) }
  const engine = world(on, files)
  engine.store['bound:session-1'] = { run: 'demo', at: AT }
  engine.agentIds.push('a1')
  await start($)

  expect((await spawn($, 't392-1') as Ran).deny, 'still paused').toContain('is paused by the owner')
  expect((await command($, 'unpause')).text).toBe('Run demo goes on.')
  await clock.advance(5000)
  expect(engine.woke).toEqual([UNPAUSED])
})

test('in a session bound to no run the commands say which run to bind', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(LEDGER, 1) }
  world(on, files)
  await start($)
  const told = 'This session is bound to no run; it only views demo. /board demo binds it: then give this command again.'
  expect((await command($, 'pause')).text).toBe(told)
  expect((await command($, 'unpause')).text).toBe(told)
  expect(run(files).pausedAt).toBeUndefined()
})

test('setting a task green during a pause says what can start once it is over', async ($, on) => {
  const ledger: Ledger = {
    ...PAUSED_RUN,
    tasks: [...LEDGER.tasks, { id: 't393-2', title: 'Follow-up', tier: 'sonnet', status: 'queued', files: ['api/loop.py'], dependsOn: ['t393-1'] }],
  }
  const { } = await bound($, on, ledger)
  expect((await call($, 'task_update', { task: 't393-1', status: 'green' })).text).toBe(
    "t393-1: status green. The run is paused: once the owner types /unpause, these can start before this one is merged: t393-2 (built on t393-1's branch).",
  )
})

test('a bound session is told in its system prompt what a pause asks of it', async ($, on) => {
  await bound($, on)
  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(composed.sections[1]?.text).toContain(
    '- The owner holds a run with /pause and lets it go on with /unpause. While it is paused the mod starts no worker and merges nothing; workers that are building finish and hand back, you judge their hand-backs and answer their questions, and a merge in flight is still settled with GitHub. When nothing is building any more, tell the owner in a line or two where the run stands, and stop. When the pause ends, read the board and go on: judge what was handed back, start what can start, and merge what is green, in order.',
  )
})
