import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { boardView, problemDetail, summary } from '../hooks/board'
import { handover } from '../hooks/handover'
import { parseLedger } from '../hooks/ledger'
import { LOOK_AGAIN_MIN, afterDone, dueForLook, isUnderway, lookLines, named, standing, standingText, unsettled } from '../hooks/problems'
import { addTask, askAgain, assignProblem, reportProblem, resolveProblem, updateTask } from '../hooks/signals'
import type { Caller, Raw } from '../hooks/signals'
import type { Ledger, Task } from '../types'
import { LEDGER, NOW } from './fixture'
import { board, file, ledgerPath, picture$, spawn, start, world } from './world'
import type { Files } from './world'

const AT = '2026-10-09T10:30:00.000Z'
const ORCHESTRATOR: Caller = { kind: 'orchestrator' }
const worker = (taskId: string): Caller => ({ kind: 'worker', taskId })
const raw = (): Raw => JSON.parse(JSON.stringify(LEDGER)) as Raw
const task = (ledger: Raw, id: string) => ledger.tasks.find(one => one.id === id)!
const problem = (ledger: Raw, id: string) => ledger.problems?.find(one => one.id === id)!
const NOTE = { id: 'N1', text: 'For the record', severity: 'note', status: 'open' } as const

describe('who takes care of a problem', () => {
  test('a blocker or a warning nobody deals with has no task, and a note needs none', () => {
    expect(standing({ id: 'P1', severity: 'warning', status: 'open' }, LEDGER.tasks)).toEqual({ kind: 'nobody' })
    expect(standing({ id: 'P2', severity: 'blocker', status: 'open', addressedBy: 'gone' }, LEDGER.tasks)).toEqual({ kind: 'nobody' })
    expect(standing(NOTE, LEDGER.tasks)).toEqual({ kind: 'note' })
  })

  test('a task that goes on deals with it, a task that is done is to be checked, a task given up deals with nothing', () => {
    const open = { id: 'P2', severity: 'blocker', status: 'open', addressedBy: 't391-1' } as const
    expect(standing(open, LEDGER.tasks)).toEqual({ kind: 'going', task: 't391-1', status: 'building' })
    expect(standing({ ...open, addressedBy: 't390-1' }, LEDGER.tasks)).toEqual({ kind: 'done', task: 't390-1' })
    const given = LEDGER.tasks.map(one => (one.id === 't391-1' ? { ...one, status: 'failed' as const } : one))
    expect(standing(open, given)).toEqual({ kind: 'failed', task: 't391-1' })
    expect(standing({ ...NOTE, addressedBy: 't391-1' }, given), 'a note needs no task, failed or not').toEqual({ kind: 'note' })
  })

  test('says it in a few words, and not for a note', () => {
    expect(standingText({ kind: 'nobody' })).toBe('no task')
    expect(standingText({ kind: 'failed', task: 't5' })).toBe('t5 failed, no task')
    expect(standingText({ kind: 'going', task: 't5', status: 'queued' })).toBe('fix t5 queued')
    expect(standingText({ kind: 'done', task: 't5' })).toBe('t5 done, check the fix')
    expect(standingText({ kind: 'note' })).toBeUndefined()
  })

  test('only an open blocker or warning keeps a run from being delivered', () => {
    expect(unsettled(LEDGER).map(one => one.id)).toEqual(['P1', 'P2'])
    const settled = { ...LEDGER, problems: [{ ...NOTE }, { id: 'P9', text: 'x', severity: 'blocker' as const, status: 'resolved' as const }] }
    expect(unsettled(settled)).toEqual([])
    expect(named(['P1'])).toBe('P1')
    expect(named(['P1', 'P2', 'P3'])).toBe('P1, P2 and P3')
  })
})

describe('problem_assign', () => {
  test('ties a problem to a task of the run that still goes on', () => {
    const ledger = raw()
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't391-1' }).text).toBe('P2 is addressed by t391-1 (building, ticket #391).')
    expect(problem(ledger, 'P2').addressedBy).toBe('t391-1')
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't391-1' }).text, 'twice says so').toBe('P2 is addressed by t391-1 already.')
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't392-1' }).isChanged, 'another task takes it over').toBe(true)
    expect(problem(ledger, 'P2').addressedBy).toBe('t392-1')
  })

  test('finds the task by its ticket, when exactly one task of the run still carries it', () => {
    const ledger = raw()
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P1', ticket: 394 }).text).toBe('P1 is addressed by t394-1 (building, ticket #394).')
    expect(problem(ledger, 'P1').addressedBy).toBe('t394-1')
  })

  test('a ticket the run no longer conducts takes no problem: nobody here would take care of it', () => {
    const ledger = raw()
    const said = assignProblem(ledger, ORCHESTRATOR, { problem: 'P1', ticket: 390 })
    expect(said.isError).toBe(true)
    expect(said.text).toContain('No task of this run that still goes on carries ticket #390, so the run does not conduct it')
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P1', ticket: 777 }).isError, 'nor one it never had').toBe(true)
    expect(problem(ledger, 'P1').addressedBy).toBeUndefined()
  })

  test('a ticket carried by several tasks says which, and takes none of them', () => {
    const ledger = raw()
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P1', ticket: 392 }).text).toBe(
      'Ticket #392 is carried by t392-1, t392-2: name the task that deals with P1.',
    )
    expect(problem(ledger, 'P1').addressedBy).toBeUndefined()
  })

  test('a task that is done or was given up deals with nothing', () => {
    const ledger = raw()
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P1', task: 't390-1' }).text).toBe(
      't390-1 is done: if it fixed P1, resolve it; if not, add a task for it with task_add and addresses.',
    )
    task(ledger, 't396-1').status = 'failed'
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P1', task: 't396-1' }).text).toContain('was given up and deals with nothing')
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P1', ticket: 396 }).isError, 'a failed task does not conduct its ticket').toBe(true)
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P1', task: 't999' }).isError).toBe(true)
  })

  test('is the orchestrator\'s, for an open problem, and names a task or a ticket, not both and not neither', () => {
    const ledger = raw()
    expect(assignProblem(ledger, worker('t391-1'), { problem: 'P1', task: 't391-1' }).isError).toBe(true)
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P3', task: 't391-1' }).text, 'a resolved one').toBe('P3 is resolved already.')
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P9', task: 't391-1' }).isError).toBe(true)
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P1' }).isError).toBe(true)
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P1', task: 't391-1', ticket: 391 }).isError).toBe(true)
    expect(ledger).toEqual(raw())
  })
})

describe('task_add with addresses', () => {
  const add = { id: 'fix-h2', title: 'The api image gets h2', tier: 'haiku', tierReason: 'a one-line image change', files: ['api/Dockerfile'] }

  test('the new task is the task of the problems it names, and says so', () => {
    const ledger = raw()
    expect(addTask(ledger, ORCHESTRATOR, { ...add, addresses: ['P1', 'P2'] }).text).toBe('fix-h2 added: haiku, queued. It addresses P1 and P2.')
    expect(problem(ledger, 'P1').addressedBy).toBe('fix-h2')
    expect(problem(ledger, 'P2').addressedBy).toBe('fix-h2')
  })

  test('a problem that is not open, or that is not there, refuses the whole call and writes nothing', () => {
    const ledger = raw()
    expect(addTask(ledger, ORCHESTRATOR, { ...add, addresses: ['P1', 'P3'] }).text).toBe('addresses names P3, which is no open problem of this run.')
    expect(addTask(ledger, ORCHESTRATOR, { ...add, addresses: ['P7'] }).isError).toBe(true)
    expect(addTask(ledger, ORCHESTRATOR, { ...add, addresses: 'P1' }).isError).toBe(true)
    expect(ledger, 'no task, and no problem tied to one').toEqual(raw())
  })

  test('a ledger whose problem names a task the run does not have does not read', () => {
    const ledger = raw()
    problem(ledger, 'P1').addressedBy = 'nowhere'
    expect(parseLedger(JSON.stringify(ledger)).error).toBe('problem P1: addressedBy names "nowhere", which is no task of this run')
  })
})

describe('problem_resolve', () => {
  test('refuses a problem whose task still goes on: that would call it fixed before the work is done', () => {
    const ledger = raw()
    assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't391-1' })
    const said = resolveProblem(ledger, ORCHESTRATOR, { problem: 'P2', resolution: 'fixed' })
    expect(said.isError).toBe(true)
    expect(said.text).toBe(
      'P2 is addressed by t391-1, which is building: it is resolved once that task is done and the fix holds. If it turned out to be no problem, say so with dismiss: true.',
    )
    expect(problem(ledger, 'P2').status).toBe('open')
  })

  test('takes it once the task is done, or on the orchestrator\'s explicit word that it was no problem', () => {
    const ledger = raw()
    assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't391-1' })
    expect(resolveProblem(ledger, ORCHESTRATOR, { problem: 'P2', resolution: 'a stale test', dismiss: true }).text).toBe('P2 resolved.')

    const again = raw()
    assignProblem(again, ORCHESTRATOR, { problem: 'P2', task: 't391-1' })
    task(again, 't391-1').status = 'done'
    expect(resolveProblem(again, ORCHESTRATOR, { problem: 'P2', resolution: 'PR 549 fixed the timeout' }).text).toBe('P2 resolved.')
  })

  test('a task that was given up holds nothing back, and a problem with no task is settled by word as before', () => {
    const ledger = raw()
    assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't391-1' })
    task(ledger, 't391-1').status = 'failed'
    expect(resolveProblem(ledger, ORCHESTRATOR, { problem: 'P2', resolution: 'fixed by hand' }).text).toBe('P2 resolved.')
    expect(resolveProblem(ledger, ORCHESTRATOR, { problem: 'P1', resolution: 'image rebuilt' }).text).toBe('P1 resolved.')
  })
})

describe('problem_report', () => {
  test('a worker\'s blocker wakes the orchestrator; its warning is handed over with the next tool result; a note says nothing', () => {
    const blocker = reportProblem(raw(), AT, worker('t394-1'), { text: 'The budget has no index', severity: 'blocker' })
    expect(blocker.text).toBe('P4 recorded (blocker, t394-1).')
    expect(blocker.wake).toBe('Run board: t394-1 reports P4, a blocker: The budget has no index')
    expect(blocker.asks).toBe('problem P4')
    expect(blocker.tell).toBeUndefined()

    const warning = reportProblem(raw(), AT, worker('t394-1'), { text: 'The budget has no index', severity: 'warning' })
    expect(warning.tell).toBe('Run board: t394-1 reports P4, a warning: The budget has no index')
    expect(warning.wake).toBeUndefined()

    const note = reportProblem(raw(), AT, worker('t394-1'), { text: 'The budget has no index', severity: 'note' })
    expect([note.tell, note.wake]).toEqual([undefined, undefined])
  })

  test('the orchestrator\'s own report, and the mod\'s, tell nobody: the caller reads the answer', () => {
    const said = reportProblem(raw(), AT, ORCHESTRATOR, { text: 'CI is out of disk', severity: 'blocker' })
    expect([said.tell, said.wake]).toEqual([undefined, undefined])
  })

  test('the same words under the same task are the problem already open, not another one', () => {
    const ledger = raw()
    reportProblem(ledger, AT, worker('t394-1'), { text: 'The budget has no index', severity: 'blocker' })
    const again = reportProblem(ledger, AT, worker('t394-1'), { text: 'The budget has no index', severity: 'blocker' })
    expect(again).toMatchObject({ isChanged: false, isError: false, text: 'P4 says the same and is open still.' })
    expect(again.wake).toBeUndefined()
    expect(ledger.problems).toHaveLength(4)
    const elsewhere = reportProblem(ledger, AT, worker('t391-1'), { text: 'The budget has no index', severity: 'blocker' })
    expect(elsewhere.text, 'another task found it too: that is its own report').toBe('P5 recorded (blocker, t391-1).')
  })
})

describe('what a task becoming done, or being given up, leaves to say', () => {
  test('the problems that waited for it, and what is still open once nothing else goes on', () => {
    const ledger = raw()
    assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't391-1' })
    expect(afterDone(ledger, 't391-1'), 'tasks still going: only what waited for it').toBe('P2 was waiting for it.')
    expect(afterDone(ledger, 't392-1')).toBe('')

    for (const one of ledger.tasks) one.status = 'done'
    expect(afterDone(ledger, 't391-1')).toBe('P2 was waiting for it. Everything is done; still open: P1.')
    problem(ledger, 'P1').status = 'resolved'
    expect(afterDone(ledger, 't391-1')).toBe('P2 was waiting for it. Everything is done.')
    problem(ledger, 'P2').status = 'resolved'
    expect(afterDone(ledger, 't391-1'), 'nothing hangs on it any more').toBe('')
  })

  test('the orchestrator reads it with its own task_update; a note that waited for it is named but holds nothing', () => {
    const ledger = raw()
    assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't392-2' })
    ledger.problems!.push({ ...NOTE, addressedBy: 't392-2' })
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't392-2', status: 'done' }).text).toBe('t392-2: status done. P2 and N1 were waiting for it.')
  })

  test('a task given up leaves its blockers and warnings without one, which the orchestrator is told whoever gave it up', () => {
    const ledger = raw()
    assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't391-1' })
    assignProblem(ledger, ORCHESTRATOR, { problem: 'P1', task: 't391-1' })
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't391-1', status: 'failed' }).text).toBe('t391-1: status failed. P1 and P2 have no task now.')

    const theirs = raw()
    assignProblem(theirs, ORCHESTRATOR, { problem: 'P2', task: 't391-1' })
    const gave = updateTask(theirs, AT, worker('t391-1'), { task: 't391-1', status: 'failed' })
    expect(gave.text, 'the worker is told no more than it did').toBe('t391-1: status failed.')
    expect(gave.tell).toBe('Run board: t391-1 failed. P2 has no task now.')
  })
})

describe('the board', () => {
  test('says who deals with each open problem, and how many have nobody', () => {
    const ledger = raw()
    assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't391-1' })
    const view = boardView(parseLedger(JSON.stringify(ledger)).ledger!, NOW)
    expect(view.problems.map(one => [one.id, problemDetail(one)])).toEqual([
      ['P2', 'blocker · t391-1 · fix t391-1 building'],
      ['P1', 'warning · no task'],
    ])
    expect(summary(view).startsWith('2 problems open (1 without a task) · ')).toBe(true)

    assignProblem(ledger, ORCHESTRATOR, { problem: 'P1', task: 't394-1' })
    expect(summary(boardView(parseLedger(JSON.stringify(ledger)).ledger!, NOW)).startsWith('2 problems open · ')).toBe(true)
  })

  test('a problem whose task is done says it is to be checked', () => {
    const ledger = raw()
    assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't391-1' })
    task(ledger, 't391-1').status = 'done'
    const view = boardView(parseLedger(JSON.stringify(ledger)).ledger!, NOW)
    expect(problemDetail(view.problems.find(one => one.id === 'P2')!)).toBe('blocker · t391-1 · t391-1 done, check the fix')
  })

  test('the handover tells the orchestrator after a compaction who deals with what', () => {
    const ledger = raw()
    assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't391-1' })
    const text = handover(parseLedger(JSON.stringify(ledger)).ledger!, { at: AT })
    expect(text).toContain('- P2 blocker (t391-1), fix t391-1 building: Pool timeout test fails on the CI runner')
    expect(text).toContain('- P1 warning, no task: The shared api image lacks h2')
    expect(text).toContain('The run is not delivered while one is open.')
  })
})

describe('looking at a problem again before its task lands', () => {
  test('a problem found under a task that nobody deals with waits for a decision: it holds and gets a task, or it does not and is resolved', () => {
    expect(lookLines(raw(), 't391-1')).toEqual([
      'P2 (blocker: "Pool timeout test fails on the CI runner") was found under t391-1 and no task deals with it: check that it still holds. If it does, give it a task (mcp__conductor__task_add with addresses, or mcp__conductor__problem_assign); if it does not, resolve it.',
    ])
    expect(lookLines(raw(), 't394-1'), 'a problem found under another task is that task\'s').toEqual([])
    expect(lookLines(raw(), 't390-1'), 'a task with no problem is not asked').toEqual([])
  })

  test('is not asked of a problem a task goes on with, of a note, or of one that is resolved', () => {
    const ledger = raw()
    assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't391-1' })
    expect(lookLines(ledger, 't391-1'), 'it has an owner, and a task that waits for its own fix would never merge').toEqual([])

    const other = raw()
    other.problems!.push({ id: 'P7', text: 'For the record', severity: 'note', status: 'open', taskId: 't391-1' })
    problem(other, 'P2').status = 'resolved'
    expect(lookLines(other, 't391-1')).toEqual([])

    // A note is for the record also when a task was tied to it and is done: it holds nothing back.
    const noted = raw()
    problem(noted, 'P2').status = 'resolved'
    noted.problems!.push({ id: 'P7', text: 'For the record', severity: 'note', status: 'open', taskId: 't391-1', addressedBy: 't390-1' })
    expect(standing(noted.problems!.find(one => one.id === 'P7')!, noted.tasks).kind).toBe('done')
    expect(lookLines(noted, 't391-1')).toEqual([])
  })

  test('a fix that is done is to be checked, and a task that was given up leaves the problem to be looked at again', () => {
    const done = raw()
    assignProblem(done, ORCHESTRATOR, { problem: 'P2', task: 't394-1' })
    task(done, 't394-1').status = 'done'
    expect(lookLines(done, 't391-1')).toEqual([
      'P2 (blocker: "Pool timeout test fails on the CI runner") was found under t391-1, and t394-1, the task that was to deal with it, is done: check that the fix holds and resolve it; if it does not, give it a new task.',
    ])
    const given = raw()
    assignProblem(given, ORCHESTRATOR, { problem: 'P2', task: 't394-1' })
    task(given, 't394-1').status = 'failed'
    expect(lookLines(given, 't391-1')[0]).toContain('t394-1, the task that was to deal with it, was given up: check that it still holds.')
  })

  test('shows what the problem says, shortened', () => {
    const ledger = raw()
    problem(ledger, 'P2').text = `${'a'.repeat(120)}`
    const line = lookLines(ledger, 't391-1')[0] ?? ''
    expect(line.startsWith(`P2 (blocker: "${'a'.repeat(89)}…") was found under t391-1`)).toBe(true)
  })
})

describe('the periodic look at problems nobody deals with', () => {
  const minutes = (n: number) => new Date(Date.parse(AT) - n * 60_000).toISOString()
  const found = (n: number, more: Record<string, unknown> = {}): Raw => {
    const ledger = raw()
    ledger.problems = [{ id: 'P4', text: 'A precaution', severity: 'warning', status: 'open', foundAt: minutes(n), ...more }]

    return ledger
  }
  const due = (ledger: Raw) => dueForLook(ledger, Date.parse(AT)).map(one => one.id)

  test('is due once it has stood for the interval, counted from when it was found', () => {
    expect(LOOK_AGAIN_MIN).toBe(30)
    expect(due(found(29))).toEqual([])
    expect(due(found(30))).toEqual(['P4'])
    expect(due(found(200))).toEqual(['P4'])
  })

  test('is counted from the last time the orchestrator was asked, once it was', () => {
    expect(due(found(200, { askedAt: minutes(5) }))).toEqual([])
    expect(due(found(200, { askedAt: minutes(31) }))).toEqual(['P4'])
  })

  test('is for a blocker or a warning nobody deals with, and for nothing else', () => {
    expect(due(found(90, { severity: 'note' })), 'a note is for the record').toEqual([])
    expect(due(found(90, { addressedBy: 't391-1' })), 'a task goes on with it').toEqual([])
    expect(due(found(90, { addressedBy: 't390-1' })), 'its task is done: said then, and at the merge').toEqual([])
    expect(due(found(90, { status: 'resolved' }))).toEqual([])
    expect(due(raw()), 'no time recorded: no time can be said to have stood').toEqual([])
  })

  test('only while the run goes on', () => {
    expect(isUnderway(LEDGER.run, LEDGER.tasks)).toBe(true)
    expect(isUnderway({ ...LEDGER.run, plan: 'proposed' }, LEDGER.tasks)).toBe(false)
    expect(isUnderway({ ...LEDGER.run, pausedAt: AT }, LEDGER.tasks)).toBe(false)
    expect(isUnderway(LEDGER.run, LEDGER.tasks.map(one => ({ ...one, status: 'done' as const })))).toBe(false)
  })

  test('asks once for the lot, in one line, and writes down when', () => {
    const ledger = found(45)
    ledger.problems!.push({ id: 'P5', text: 'A fact', severity: 'blocker', status: 'open', foundAt: minutes(80) })
    const said = askAgain(ledger, AT)
    expect(said.text).toBe('Run board: still open and not looked at for 30 minutes or more: P4 (warning, no task); P5 (blocker, no task).')
    expect(said.wake).toBe(said.text)
    expect(said.asks).toBe('look again')
    expect(problem(ledger, 'P4').askedAt).toBe(AT)
    expect(problem(ledger, 'P5').askedAt).toBe(AT)
    expect(askAgain(ledger, AT).isChanged, 'not again until the interval is over').toBe(false)
    expect(askAgain(ledger, new Date(Date.parse(AT) + 30 * 60_000).toISOString()).isChanged).toBe(true)
  })

  test('asks nothing of a run that is held, not approved, or over', () => {
    const held = found(45)
    ;(held.run as Record<string, unknown>).pausedAt = AT
    expect(askAgain(held, AT).isChanged).toBe(false)
    const drafted = found(45)
    ;(drafted.run as Record<string, unknown>).plan = 'draft'
    expect(askAgain(drafted, AT).isChanged).toBe(false)
    const over = found(45)
    for (const one of over.tasks) one.status = 'done'
    expect(askAgain(over, AT).isChanged).toBe(false)
  })
})

// ---- through the engine: the tools as the orchestrator and a worker call them ----

const PATH = ledgerPath('demo')
const stored = (files: Files): Ledger => JSON.parse(files[PATH]?.text ?? '{}') as Ledger
const taskOf = (files: Files, id: string): Task => stored(files).tasks.find(one => one.id === id)!
type Ran = { text?: string; isError?: true; context?: readonly string[] }
/** One of the mod's own tools, called by the loop `agentId` (the main conversation when absent). */
const call = ($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)({
    tool: `mcp__conductor__${tool}`,
    tool_use_id: `call-${tool}`,
    ...input,
    ...(agentId === undefined ? {} : { agentId }),
  })
/** Any other tool call of the main conversation: the moment its board news is handed over. */
const reads = ($: Engine) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)({ tool: 'Read', tool_use_id: 'read', file_path: '/repo/README.md' })
const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

/** A bound session with t392-1 built by the worker a1. */
async function running($: Engine, on: Parameters<typeof world>[0]) {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(LEDGER, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')
  engine.agentIds.push('a1')
  await spawn($, 't392-1')

  return { clock, files, engine }
}

test('a blocker a worker finds wakes the idle orchestrator once, and a warning waits for its next tool result', async ($, on) => {
  const { clock, files, engine } = await running($, on)

  const blocker = await call($, 'problem_report', { text: 'The deck test reads a stale twin', severity: 'blocker' }, 'a1')
  expect(blocker.text).toBe('P4 recorded (blocker, t392-1).')
  await clock.advance(5000)
  expect(engine.woke).toEqual(['Run board: t392-1 reports P4, a blocker: The deck test reads a stale twin'])

  expect((await call($, 'problem_report', { text: 'The deck test reads a stale twin', severity: 'blocker' }, 'a1')).text).toBe('P4 says the same and is open still.')
  await clock.advance(5000)
  expect(engine.woke, 'not woken twice for the same words').toHaveLength(1)

  await call($, 'problem_report', { text: 'The copy deck has no German', severity: 'warning' }, 'a1')
  expect((await reads($)).context).toEqual(['Run board: t392-1 reports P5, a warning: The copy deck has no German'])
  expect((await reads($)).context, 'once').toBeUndefined()
  expect(stored(files).problems.map(one => one.id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5'])
})

test('a problem is given a task of its own, or a task the run still conducts, and is resolved once that task is done', async ($, on) => {
  const { clock, files } = await running($, on)

  const added = await call($, 'task_add', {
    id: 'fix-h2',
    title: 'The api image gets h2',
    tier: 'haiku',
    tierReason: 'a one-line image change',
    files: ['api/Dockerfile'],
    addresses: ['P1'],
  })
  expect(added.text).toBe('fix-h2 added: haiku, queued. It addresses P1.')
  expect(stored(files).problems.find(one => one.id === 'P1')?.addressedBy).toBe('fix-h2')

  expect((await call($, 'problem_assign', { problem: 'P2', ticket: 394 })).text).toBe('P2 is addressed by t394-1 (building, ticket #394).')
  const parked = await call($, 'problem_assign', { problem: 'P2', ticket: 390 })
  expect(parked.text).toMatch(/^Not done\. No task of this run that still goes on carries ticket #390/)
  expect((await call($, 'problem_assign', { problem: 'P2', task: 't391-1' }, 'a1')).text, 'a worker does not give out tasks').toMatch(/^Not done\. Only the orchestrator/)
  expect(stored(files).problems.find(one => one.id === 'P2')?.addressedBy).toBe('t394-1')

  const early = await call($, 'problem_resolve', { problem: 'P1', resolution: 'image rebuilt' })
  expect(early.text).toMatch(/^Not done\. P1 is addressed by fix-h2, which is queued: it is resolved once that task is done/)

  expect((await call($, 'task_update', { task: 'fix-h2', status: 'done' })).text, 'no pull request: done is the orchestrator\'s to say').toBe(
    'fix-h2: status done. P1 was waiting for it.',
  )
  expect((await call($, 'problem_resolve', { problem: 'P1', resolution: 'image rebuilt, h2 answers' })).text).toBe('P1 resolved.')
  await clock.advance(2000)
  expect(taskOf(files, 'fix-h2').status).toBe('done')
  expect(stored(files).problems.find(one => one.id === 'P1')).toMatchObject({ status: 'resolved', addressedBy: 'fix-h2' })
})

test('the pane and /board say which problem has no task, and a task given up puts its problem back', async ($, on) => {
  const { clock } = await running($, on)
  await call($, 'problem_assign', { problem: 'P2', task: 't394-1' })
  await clock.advance(2000)

  const shown = (await picture$($, 'desktop')).source
  expect(shown).toContain('blocker · t391-1 · fix t394-1 building')
  expect(shown).toContain('warning · no task')
  expect((await board($)).text).toContain('2 problems open (1 without a task)')

  expect((await call($, 'task_update', { task: 't394-1', status: 'failed' })).text).toBe('t394-1: status failed. P2 has no task now.')
  expect((await board($)).text).toContain('2 problems open (2 without a task)')
  await clock.advance(2000)
  expect((await picture$($, 'desktop')).source).toContain('blocker · t391-1 · t394-1 failed, no task')
})

test('the owner closing a task by /merged has the orchestrator told what waited for it', async ($, on) => {
  await running($, on)
  await call($, 'problem_assign', { problem: 'P1', task: 't393-1' })

  expect((await command($, 'merged', 't393-1')).text).toBe('t393-1 is done, by your word that its pull request is merged.')
  expect((await reads($)).context).toEqual(["Run board: t393-1 is done by the owner's word. P1 was waiting for it."])
})

test('a bound session is told, in its standing instructions, that a blocker or a warning is its own until a task has dealt with it', async ($, on) => {
  mock.clock(on, { now: NOW })
  world(on, { [PATH]: file(LEDGER, 1) })
  await start($)
  await board($, 'demo')
  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const text = composed.sections.find(one => one.id === 'conductor:run')?.text ?? ''
  expect(text).toContain('A blocker or a warning is yours until a task of this run has dealt with it')
  expect(text).toContain('mcp__conductor__problem_assign')
  expect(text).toContain('a problem is never left with a ticket nobody here conducts')
  expect(text).toContain('Look first whether it still holds')
  expect(text).toContain('the board asks you again every 30 minutes about one that nobody deals with')
  expect(text).toContain('a task is not merged while a problem found under it waits for that decision')
  expect(text).toContain('A run with a blocker or a warning open is not delivered: say so in your summary')
})

test('a problem nobody deals with is asked about again from time to time, once for each interval, and not while the owner holds the run', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const found = new Date(NOW - 31 * 60_000).toISOString()
  const ledger: Ledger = {
    ...LEDGER,
    problems: [...LEDGER.problems, { id: 'P4', text: 'A precaution that may not come true', severity: 'warning', status: 'open', foundAt: found }],
  }
  const files: Files = { [PATH]: file(ledger, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')
  const asked = () => engine.woke.filter(one => one.includes('not looked at'))

  await clock.advance(40_000)
  expect(asked()).toEqual(['Run board: still open and not looked at for 30 minutes or more: P4 (warning, no task).'])
  expect(stored(files).problems.find(one => one.id === 'P4')?.askedAt).toBeDefined()

  await clock.advance(10 * 60_000)
  expect(asked(), 'not again within the interval').toHaveLength(1)
  await clock.advance(25 * 60_000)
  expect(asked(), 'and again once it is over').toHaveLength(2)

  await command($, 'pause')
  await clock.advance(40 * 60_000)
  expect(asked(), 'the owner holds the run: the orchestrator is left alone').toHaveLength(2)
})

test('a problem that was given a task is left alone by it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const found = new Date(NOW - 90 * 60_000).toISOString()
  const ledger: Ledger = {
    ...LEDGER,
    problems: [...LEDGER.problems, { id: 'P4', text: 'A precaution', severity: 'warning', status: 'open', foundAt: found, addressedBy: 't394-1' }],
  }
  const files: Files = { [PATH]: file(ledger, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')

  await clock.advance(5 * 60_000)
  expect(engine.woke.filter(one => one.includes('not looked at'))).toEqual([])
})
