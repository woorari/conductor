import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Ledger, Task } from '../types'
import { LEDGER, NOW } from './fixture'
import { board, file, ledgerPath, picture$, spawn, start, world } from './world'
import type { Files } from './world'

const PATH = ledgerPath('demo')
const stored = (files: Files): Ledger => JSON.parse(files[PATH]?.text ?? '{}') as Ledger
const task = (files: Files, id: string): Task => stored(files).tasks.find(one => one.id === id)!
type Ran = { text?: string; isError?: true; context?: readonly string[] }
const raise = ($: Engine, input: Record<string, unknown>) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
/** One of the mod's own tools, called by the loop `agentId` (the main conversation when absent). */
const call = ($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) =>
  raise($, { tool: `mcp__conductor__${tool}`, tool_use_id: `call-${tool}`, ...input, ...(agentId === undefined ? {} : { agentId }) })
/** Any other tool call of that loop: the moment its board news is handed over. */
const reads = ($: Engine, agentId?: string) =>
  raise($, { tool: 'Read', tool_use_id: 'read', file_path: '/repo/README.md', ...(agentId === undefined ? {} : { agentId }) })
const edits = ($: Engine, agentId: string, path: string) =>
  raise($, { tool: 'Edit', tool_use_id: `edit-${agentId}`, file_path: path, old_string: 'a', new_string: 'b', agentId })

/** The fixture with t392-1 and t396-1 ready to start on files of their own, and t393-1 stopped in review with a known worker. */
const READY: Ledger = {
  ...LEDGER,
  tasks: LEDGER.tasks.map(one =>
    one.id === 't392-1'
      ? { ...one, files: ['frontend/src/copy'] }
      : one.id === 't396-1'
        ? { ...one, status: 'queued' as const, files: ['scaletest', 'api/main.py'] }
        : one.id === 't394-1'
          ? { ...one, status: 'done' as const, finishedAt: '2026-10-09T10:20:00Z' }
          : one.id === 't393-1'
            ? { ...one, agentId: 'a393', files: ['api/routers'] }
            : one,
  ),
}

/** A bound session with two workers building: t392-1 (agent a1) and t396-1 (agent a2). */
async function running($: Engine, on: Parameters<typeof world>[0], ledger: Ledger = READY) {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(ledger, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')
  engine.agentIds.push('a1', 'a2')
  await spawn($, 't392-1')
  await spawn($, 'w396')

  return { clock, files, engine }
}

test('a finding is handed to the worker on the files it names with that worker\'s next tool result, and to no one else', async ($, on) => {
  const { clock, files, engine } = await running($, on)
  engine.agentIds.push('child')
  await spawn($, undefined, 'a1')

  const said = await call($, 'board_post', { kind: 'finding', text: 'The busy line needs both decks.', files: ['frontend/src/copy/status.ts'] }, 'a2')
  expect(said.text).toBe('F1 posted; for t392-1, who reads it at the next step.')
  expect(said.context, 'not to its own poster').toBeUndefined()
  expect(stored(files).posts[0]).toMatchObject({ id: 'F1', from: 't396-1', for: ['t392-1'] })
  expect(stored(files).posts[0]?.deliveredTo, 'nothing is claimed before it happened').toBeUndefined()

  expect((await reads($, 'child')).context, 'a worker\'s subagent is not its reader').toBeUndefined()
  expect((await reads($)).context, 'nor is the orchestrator').toBeUndefined()
  expect((await reads($, 'a1')).context).toEqual([
    'Run board, finding F1 from t396-1: The busy line needs both decks. (files: frontend/src/copy/status.ts)',
  ])
  expect((await reads($, 'a1')).context, 'once').toBeUndefined()
  await clock.advance(5000)
  expect(stored(files).posts[0]?.deliveredTo).toEqual(['t392-1'])
  expect(engine.woke, 'a finding does not wake the orchestrator').toEqual([])

  expect((await call($, 'board_post', { kind: 'finding', text: 'Unrelated.', files: ['docs/DEPLOY.md'] }, 'a2')).text).toContain('no worker is on those files now')
  expect((await reads($, 'a1')).context, 'nobody is on docs').toBeUndefined()
})

test('a question wakes the orchestrator, and its ruling is handed to the worker that asked', async ($, on) => {
  const { clock, files, engine } = await running($, on)

  const asked = await call($, 'board_post', { kind: 'question', text: 'May the line say "Busy right now"?' }, 'a1')
  expect(asked.text).toContain('Q1 asked; the orchestrator is told.')
  await call($, 'board_post', { kind: 'question', text: 'And in German?' }, 'a2')
  expect(engine.woke, 'not from inside the tool call: the engine refuses that').toEqual([])
  await clock.advance(5000)
  expect(engine.woke, 'both questions in one prompt, a few seconds later').toEqual([
    [
      'Run board: t392-1 asks Q1: May the line say "Busy right now"?',
      'Run board: t396-1 asks Q2: And in German?',
    ].join('\n\n'),
  ])
  await clock.advance(2000)
  const open = await picture$($, 'desktop')
  expect(open.source).toContain('>t392-1 asks the orchestrator<')
  expect(open.alt).toContain('2 questions open')

  expect((await call($, 'board_rule', { text: 'Yes.', answers: 'Q1' }, 'a1')).text).toMatch(/^Not done\. Only the orchestrator rules/)
  const ruled = await call($, 'board_rule', { text: 'Yes, those words.', answers: 'Q1' })
  expect(ruled.text).toBe('R1 recorded (answers Q1); for t392-1, who reads it at the next step.')
  expect(stored(files).posts[0]?.answeredBy).toBe('R1')
  expect((await reads($, 'a2')).context, 'the other worker did not ask').toBeUndefined()
  expect((await call($, 'task_update', { task: 't392-1', note: 'waiting' }, 'a1')).context, 'with any of its tool results, the mod\'s own too').toEqual([
    'Run board, ruling R1 (answers Q1): Yes, those words.',
  ])
  await clock.advance(5000)
  expect(stored(files).rulings[0]).toMatchObject({ for: ['t392-1'], deliveredTo: ['t392-1'] })
  const closed = await picture$($, 'desktop')
  expect(closed.alt).toContain('1 question open')
  expect(closed.source).toContain(' · 1 ruling on the board<')
})

test('a working orchestrator reads a question with its next tool result and is not woken; a settled question wakes nobody', async ($, on) => {
  const { clock, engine } = await running($, on)
  const ask = 'Run board: t392-1 asks Q1: Which words?'

  await $.turn.start({ text: 'Carry on.', turnId: 'main-1' })
  await call($, 'board_post', { kind: 'question', text: 'Which words?' }, 'a1')
  await clock.advance(5000)
  expect(engine.woke, 'its turn is running: no prompt is queued behind it').toEqual([])
  expect((await reads($)).context).toEqual([ask])
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 'main-1', reason: 'answer' })
  await clock.advance(5000)
  expect(engine.woke, 'it has read the question: no wake-up afterwards either').toEqual([])

  await call($, 'board_post', { kind: 'question', text: 'And the colour?' }, 'a2')
  const settled = await call($, 'board_rule', { text: 'Amber.', answers: 'Q2' })
  expect(settled.context, 'the ruling does not come back with the question it just settled').toBeUndefined()
  await clock.advance(5000)
  expect(engine.woke, 'answered before the timer came round').toEqual([])
  expect((await reads($)).context, 'and not handed over later').toBeUndefined()

  await call($, 'board_post', { kind: 'question', text: 'One more?' }, 'a2')
  await clock.advance(5000)
  expect(engine.woke, 'idle and unread: woken').toHaveLength(1)
  expect((await reads($)).context, 'and not told a second time').toBeUndefined()
})

test('a ruling for a stopped worker waits; the mod starts nobody, and the worker reads it when it runs again', async ($, on) => {
  const { clock, engine } = await running($, on)
  await clock.advance(2000)

  expect((await call($, 'board_post', { kind: 'finding', text: 'Routers need the step helper.', files: ['api/routers/coach.py'] }, 'a1')).text).toContain(
    'no worker is on those files now',
  )
  const ruled = await call($, 'board_rule', { text: 'Rebase on main before the merge.', tasks: ['t393-1'] })
  expect(ruled.text).toBe('R1 recorded; t393-1 has stopped and reads it on running again: send it a message to start it.')
  expect(engine.woke).toEqual([])
  expect(engine.spawns, 'nothing was started').toHaveLength(2)

  expect((await reads($, 'a393')).context, 'the orchestrator resumed it: its first step brings the ruling').toEqual([
    'Run board, ruling R1: Rebase on main before the merge.',
  ])
})

test('two workers changing one file are told, each in its own worktree, and so is the orchestrator', async ($, on) => {
  const { clock, files, engine } = await running($, on)

  await edits($, 'a1', '/repo/.claude/worktrees/agent-a1/frontend/src/copy/status.ts')
  await edits($, 'a2', '/repo/.claude/worktrees/agent-a2/scaletest/k6/load.js')
  await clock.advance(5000)
  expect(task(files, 't392-1').touched).toEqual(['frontend/src/copy/status.ts'])
  expect(task(files, 't396-1').touched).toEqual(['scaletest/k6/load.js'])
  expect((await reads($, 'a1')).context, 'disjoint files: nobody is told anything').toBeUndefined()

  await edits($, 'a1', '/repo/.claude/worktrees/agent-a1/api/main.py')
  await clock.advance(5000)
  expect(stored(files).problems.at(-1)).toMatchObject({ id: 'P4', severity: 'warning', text: 't392-1 and t396-1 both change api/main.py.' })
  expect((await reads($, 'a1')).context?.[0]).toMatch(/^Run board: t396-1 also changes api\/main\.py \(P4\)\. Do not overwrite its work\./)
  expect((await reads($, 'a2')).context?.[0]).toMatch(/^Run board: t392-1 also changes api\/main\.py \(P4\)\./)
  expect((await reads($)).context, 'the orchestrator, with its own next tool result').toEqual([
    'Run board: two tasks change the same file. P4: t392-1 and t396-1 both change api/main.py. Decide their order, or rule who yields.',
  ])
  expect(engine.woke, 'a note, not a wake-up').toEqual([])

  await edits($, 'a2', '/repo/.claude/worktrees/agent-a2/api/main.py')
  await clock.advance(5000)
  expect(stored(files).problems, 'the same pair on the same file once').toHaveLength(4)
  expect((await reads($)).context).toBeUndefined()
})

test('news is not lost on a tool call the engine refused: it comes with the next one that ran', async ($, on) => {
  const { engine } = await running($, on)
  await call($, 'board_rule', { text: 'One merge at a time.' })
  engine.refuses.add('Read')
  const refused = await raise($, { tool: 'Read', tool_use_id: 'r1', file_path: '/repo/x', agentId: 'a1' })
  expect(refused).toEqual({ deny: 'Read is not allowed here' })
  engine.refuses.clear()
  expect((await reads($, 'a1')).context).toEqual(['Run board, ruling R1: One merge at a time.'])
})

test('what waited for a worker before the mod loaded is handed over all the same', async ($, on) => {
  mock.clock(on, { now: NOW })
  const left: Ledger = {
    ...READY,
    tasks: READY.tasks.map(one => (one.id === 't392-1' ? { ...one, status: 'building' as const, agentId: 'a1', worker: 't392-1' } : one)),
    posts: [{ id: 'F1', kind: 'finding', text: 'Both decks.', from: 'orchestrator', at: '2026-10-09T10:00:00Z', files: ['frontend/src/copy'], for: ['t392-1'] }],
    rulings: [
      { id: 'R1', text: 'Already read.', at: '2026-10-09T10:01:00Z', for: ['t392-1'], deliveredTo: ['t392-1'] },
      { id: 'R2', text: 'One merge at a time.', at: '2026-10-09T10:02:00Z', for: ['t392-1'] },
    ],
  }
  world(on, { [PATH]: file(left, 1) })
  await start($)
  await board($, 'demo')

  expect((await reads($, 'a1')).context).toEqual([
    'Run board, finding F1 from orchestrator: Both decks. (files: frontend/src/copy)',
    'Run board, ruling R2: One merge at a time.',
  ])
})

test('a worker starts with a briefing after the orchestrator\'s own words', async ($, on) => {
  const { engine } = await running($, on)
  await call($, 'board_rule', { text: 'One merge at a time.' })
  await call($, 'task_update', { task: 't392-1', status: 'done' })
  await call($, 'task_add', { id: 't397-1', title: 'Wire the busy line', tier: 'sonnet', tierReason: 'two clients', files: ['frontend/src/copy'] })
  engine.agentIds.push('a3', 'c1')

  await spawn($, 't397-1')
  const brief = engine.briefs.at(-1) ?? ''
  expect(brief.startsWith('Do the task.\n')).toBe(true)
  expect(brief).toContain('You are the worker for task `t397-1` ("Wire the busy line") of run `demo`, on the sonnet tier.')
  expect(brief).toContain('Your task is expected to change: frontend/src/copy.')
  expect(brief).toContain('  - Ruling R1: One merge at a time.')

  await spawn($, undefined, 'a3')
  expect(engine.briefs.at(-1), 'its subagent gets the worker\'s words and nothing more').toBe('Do the task.')
})

test('a worker and the orchestrator each read their own part of the board', async ($, on) => {
  const { engine } = await running($, on)
  await call($, 'board_post', { kind: 'finding', text: 'The busy line needs both decks.', files: ['frontend/src/copy'] }, 'a2')
  await call($, 'board_post', { kind: 'question', text: 'Which words?' }, 'a1')

  expect((await call($, 'board_read', {}, 'a1')).text?.split('\n')).toEqual([
    'The board, for t392-1:',
    '- Finding F1 from t396-1 (frontend/src/copy): The busy line needs both decks.',
    '- Your question Q1 is not answered yet: Which words?',
  ])
  expect((await call($, 'board_read', {}, 'a2')).text).toBe('Nothing on the board concerns t396-1 yet.')
  const whole = (await call($, 'board_read', {})).text ?? ''
  expect(whole, 'the orchestrator reads the whole run').toContain('## Tasks')
  expect(whole).toContain('- Q1 from t392-1: Which words?')
  expect(engine.ran, 'the board\'s tools are the mod\'s own').toEqual([])
})
