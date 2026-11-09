import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { parseLedger } from '../hooks/ledger'
import { STALL_MIN, sayStalls, stallsDue } from '../hooks/signals'
import type { Raw } from '../hooks/signals'
import type { Ledger } from '../types'
import { LEDGER, NOW } from './fixture'
import { board, file, ledgerPath, spawn, start, world } from './world'
import type { Files } from './world'

const AT = '2026-10-09T10:30:00.000Z'
const minutesBefore = (n: number): string => new Date(Date.parse(AT) - n * 60_000).toISOString()
const later = (n: number): string => new Date(Date.parse(AT) + n * 60_000).toISOString()

/** The fixture with one worker building, t392-1, last seen `silent` minutes before AT; the fixture's other builders have handed back. */
function quiet(silent: number): Raw {
  const raw = JSON.parse(JSON.stringify(LEDGER)) as Raw
  for (const one of raw.tasks) {
    if (one.status === 'building') {
      one.status = 'review'
      one.finishedAt = minutesBefore(60)
    }
  }
  const task = raw.tasks.find(one => one.id === 't392-1')!
  Object.assign(task, { status: 'building', worker: 't392-1', agentId: 'a1', startedAt: minutesBefore(90), activity: { at: minutesBefore(silent), text: 'Bash: lore status --scan' } })

  return raw
}
const task = (raw: Raw, id: string) => raw.tasks.find(one => one.id === id)!
const problem = (raw: Raw, id: string) => raw.problems?.find(one => one.id === id)

describe('a building worker that shows no sign of life', () => {
  test('is said once it has been silent for the interval, counted from its last tool call', () => {
    expect(STALL_MIN).toBe(30)
    expect(stallsDue(quiet(29) as unknown as Ledger, Date.parse(AT))).toBe(false)
    expect(sayStalls(quiet(29), AT).isChanged).toBe(false)
    expect(stallsDue(quiet(30) as unknown as Ledger, Date.parse(AT))).toBe(true)
    expect(sayStalls(quiet(30), AT).isChanged).toBe(true)
  })

  test('is counted from its start when it made no tool call yet', () => {
    const raw = quiet(0)
    delete task(raw, 't392-1').activity
    task(raw, 't392-1').startedAt = minutesBefore(45)
    expect(sayStalls(raw, AT).text).toMatch(/t392-1's worker has shown no sign of life for 45 minutes/)
  })

  test('is a warning on the board under its task, and wakes the orchestrator with what it can do', () => {
    const raw = quiet(42)
    const said = sayStalls(raw, AT, new Map([['a1', 'waiting']]))
    expect(problem(raw, 'P4')).toEqual({
      id: 'P4',
      text: "t392-1's worker has shown no sign of life for 42 minutes: its last tool call was Bash: lore status --scan, at 2026-10-09T09:48:00.000Z. The engine lists its loop as waiting. It may be on a long command, or its wait ran out and nothing woke it.",
      severity: 'warning',
      status: 'open',
      taskId: 't392-1',
      foundAt: AT,
    })
    expect(task(raw, 't392-1').stall).toEqual({ at: AT, problem: 'P4' })
    expect(said.wake).toBe(
      "Run board: P4, a warning: t392-1's worker has shown no sign of life for 42 minutes: its last tool call was Bash: lore status --scan, at 2026-10-09T09:48:00.000Z. The engine lists its loop as waiting. It may be on a long command, or its wait ran out and nothing woke it. Look at it (ListAgents shows who runs). Leave a busy worker alone. One that is gone: set the task to returned with mcp__conductor__task_update, then start a worker again with the task's id as its name.",
    )
    expect(said.asks).toBe('stall t392-1')
    expect(parseLedger(JSON.stringify(raw)).error, 'the ledger still reads').toBeUndefined()
  })

  test('says when the engine lists the worker no more', () => {
    const raw = quiet(42)
    sayStalls(raw, AT, new Map())
    expect(problem(raw, 'P4')?.text).toContain('The engine no longer lists it.')
    const unknown = quiet(42)
    sayStalls(unknown, AT)
    expect(problem(unknown, 'P4')?.text, 'the engine could not be asked: nothing is said of it').not.toContain('engine')
  })

  test('is said once for one silence, however long it lasts', () => {
    const raw = quiet(42)
    sayStalls(raw, AT)
    expect(stallsDue(raw as unknown as Ledger, Date.parse(later(120)))).toBe(false)
    expect(sayStalls(raw, later(120)).isChanged).toBe(false)
    expect(raw.problems?.filter(one => one.taskId === 't392-1')).toHaveLength(1)
  })

  test('is resolved by the mod once the worker shows life again, and the orchestrator is told', () => {
    const raw = quiet(42)
    sayStalls(raw, AT)
    task(raw, 't392-1').activity = { at: later(3), text: 'Bash: lore push' }
    expect(stallsDue(raw as unknown as Ledger, Date.parse(later(4)))).toBe(true)
    const over = sayStalls(raw, later(4))
    expect(over.isChanged).toBe(true)
    expect(problem(raw, 'P4')).toMatchObject({ status: 'resolved', resolution: `t392-1's worker showed life again at ${later(3)} (Bash: lore push).` })
    expect(task(raw, 't392-1').stall).toBeUndefined()
    expect(over.tell).toBe(`Run board: P4 resolved: t392-1's worker showed life again at ${later(3)} (Bash: lore push).`)
    expect(over.answered).toBe('stall t392-1')
    // A new silence is a new warning.
    expect(sayStalls(raw, later(40)).isChanged).toBe(true)
    expect(problem(raw, 'P5')?.taskId).toBe('t392-1')
  })

  test('is resolved by the mod once its task leaves building', () => {
    const raw = quiet(42)
    sayStalls(raw, AT)
    task(raw, 't392-1').status = 'returned'
    const over = sayStalls(raw, later(1))
    expect(problem(raw, 'P4')).toMatchObject({ status: 'resolved', resolution: 't392-1 is returned now.' })
    expect(task(raw, 't392-1').stall).toBeUndefined()
    expect(over.tell).toBe('Run board: P4 resolved: t392-1 is returned now.')
  })

  test('a warning the orchestrator resolved itself keeps its resolution', () => {
    const raw = quiet(42)
    sayStalls(raw, AT)
    Object.assign(problem(raw, 'P4')!, { status: 'resolved', resolution: 'a long build, left alone' })
    task(raw, 't392-1').activity = { at: later(3), text: 'Bash: lore push' }
    const over = sayStalls(raw, later(4))
    expect(problem(raw, 'P4')?.resolution).toBe('a long build, left alone')
    expect(task(raw, 't392-1').stall).toBeUndefined()
    expect(over.tell).toBeUndefined()
  })

  test('a task that is not building is not watched', () => {
    const raw = quiet(42)
    task(raw, 't392-1').status = 'returned'
    expect(stallsDue(raw as unknown as Ledger, Date.parse(AT))).toBe(false)
    expect(sayStalls(raw, AT).isChanged).toBe(false)
  })

  test('a building task with no agent id is not watched: nothing its worker does could be heard', () => {
    const raw = quiet(42)
    delete task(raw, 't392-1').agentId
    expect(stallsDue(raw as unknown as Ledger, Date.parse(AT))).toBe(false)
    expect(sayStalls(raw, AT).isChanged).toBe(false)
  })
})

// ---- through the engine: the timer watches, the orchestrator is woken ----

const PATH = ledgerPath('demo')
const stored = (files: Files): Ledger => JSON.parse(files[PATH]?.text ?? '{}') as Ledger
type Ran = { text?: string; isError?: true; context?: readonly string[] }
const workerReads = ($: Engine, agentId: string) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)({ tool: 'Read', tool_use_id: `read-${agentId}`, file_path: '/repo/README.md', agentId })
const call = ($: Engine, tool: string, input: Record<string, unknown>) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)({ tool: `mcp__conductor__${tool}`, tool_use_id: `call-${tool}`, ...input })

/** A bound session in which only t392-1 builds, started now by the worker a1. */
async function building($: Engine, on: Parameters<typeof world>[0]) {
  const clock = mock.clock(on, { now: NOW })
  const ledger: Ledger = {
    ...LEDGER,
    tasks: LEDGER.tasks.map(one => (one.status === 'building' ? { ...one, status: 'review' as const, finishedAt: '2026-10-09T10:20:00Z' } : one)),
  }
  const files: Files = { [PATH]: file(ledger, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')
  engine.agentIds.push('a1')
  await spawn($, 't392-1')

  return { clock, files, engine }
}

test('a worker silent for the interval is put on the board and wakes the idle orchestrator once', async ($, on) => {
  const { clock, files, engine } = await building($, on)
  await clock.advance((STALL_MIN - 1) * 60_000)
  expect(engine.woke.filter(one => one.includes('no sign of life'))).toEqual([])

  await clock.advance(2 * 60_000)
  const woken = engine.woke.filter(one => one.includes('no sign of life'))
  expect(woken).toHaveLength(1)
  expect(woken[0]).toMatch(/^Run board: P4, a warning: t392-1's worker has shown no sign of life for 3\d minutes/)
  const filed = stored(files).problems.find(one => one.id === 'P4')
  expect(filed).toMatchObject({ severity: 'warning', status: 'open', taskId: 't392-1' })
  expect(stored(files).tasks.find(one => one.id === 't392-1')?.stall?.problem).toBe('P4')

  await clock.advance(10 * 60_000)
  expect(engine.woke.filter(one => one.includes('no sign of life')), 'once for one silence').toHaveLength(1)
})

test('the warning is resolved once the worker acts again', async ($, on) => {
  const { clock, files } = await building($, on)
  await clock.advance((STALL_MIN + 1) * 60_000)
  expect(stored(files).problems.find(one => one.id === 'P4')?.status).toBe('open')

  await workerReads($, 'a1')
  await clock.advance(60_000)
  expect(stored(files).problems.find(one => one.id === 'P4')).toMatchObject({ status: 'resolved' })
  expect(stored(files).tasks.find(one => one.id === 't392-1')?.stall).toBeUndefined()
})

test('the warning is resolved once the orchestrator sets the task returned', async ($, on) => {
  const { clock, files } = await building($, on)
  await clock.advance((STALL_MIN + 1) * 60_000)
  expect((await call($, 'task_update', { task: 't392-1', status: 'returned' })).isError).toBeUndefined()
  await clock.advance(60_000)
  expect(stored(files).problems.find(one => one.id === 'P4')).toMatchObject({ status: 'resolved', resolution: 't392-1 is returned now.' })
})
