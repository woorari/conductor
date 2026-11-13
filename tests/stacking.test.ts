import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { boardView, detail } from '../hooks/board'
import { handover } from '../hooks/handover'
import { parseLedger } from '../hooks/ledger'
import { briefing } from '../hooks/posts'
import { released, reserved } from '../hooks/signals'
import type { Raw } from '../hooks/signals'
import type { Ledger, Task } from '../types'
import { LEDGER, NOW } from './fixture'
import { board, ci, file, ledgerPath, pull, spawn, start, world } from './world'
import type { Files } from './world'

const AT = '2026-10-09T10:30:00.000Z'
const PATH = ledgerPath('demo')
const HALF_MINUTE = 30_000

/** The fixture's green task with its branch recorded, and two tasks behind it: one waits for it alone, one for a task in review as well. */
const STACK: Ledger = {
  ...LEDGER,
  tasks: [
    ...LEDGER.tasks.map(one => (one.id === 't395-1' ? { ...one, branch: 'cap/395-thresholds' } : one)),
    { id: 't395-2', title: 'Cap warning copy', tier: 'haiku', status: 'queued', files: ['frontend/src/copy/cap.ts'], dependsOn: ['t395-1'] },
    { id: 't395-3', title: 'Cap dashboard', tier: 'sonnet', status: 'queued', files: ['frontend/src/views/Cap.tsx'], dependsOn: ['t395-1', 't393-1'] },
  ],
}
const of = (ledger: Ledger, id: string): Task => ledger.tasks.find(one => one.id === id)!
const BASE = { taskId: 't395-1', branch: 'cap/395-thresholds', pr: 548 }

describe('what a worker is told when its task is built on a branch that is not merged yet', () => {
  test('to start from that branch, in place of main, and what that means for its pull request', () => {
    const text = briefing(STACK, of(STACK, 't395-2'), undefined, BASE)
    expect(text).toContain(
      "- Build on the branch `cap/395-thresholds`, not on main. It holds t395-1's change, which is reviewed and has green checks but is not merged yet, and your task needs it. After a fetch, start your own branch from `origin/cap/395-thresholds`: this takes the place of any rule below that says to branch from main. Your pull request still targets main, and until t395-1 is merged it shows that task's commits too. Do not rebase. Merge origin/main into your branch only if you need something from main that the branch `cap/395-thresholds` lacks, and say so in your task's note.",
    )
  })

  test('the rule stands before the project\'s own rules, which it overrides', () => {
    const text = briefing(STACK, of(STACK, 't395-2'), { brief: 'Branch from `origin/main`.', slot: 1 }, BASE)
    expect(text.indexOf('- Build on the branch')).toBeGreaterThan(0)
    expect(text.indexOf('- Build on the branch')).toBeLessThan(text.indexOf('Branch from `origin/main`.'))
  })

  test('a branch nobody recorded is named by its pull request', () => {
    const text = briefing(STACK, of(STACK, 't395-2'), undefined, { taskId: 't395-1', pr: 548 })
    expect(text).toContain('- Build on the head branch of pull request 548, not on main.')
    expect(text).toContain('start your own branch from that branch:')
  })

  test('nothing of it for a task that starts from main', () => {
    expect(briefing(STACK, of(STACK, 't395-2'))).not.toContain('Build on')
    expect(briefing(STACK, of(STACK, 't392-1'))).not.toContain('built on')
  })

  test('a worker started again, or compacted, still knows what its branch stands on, until that is merged', () => {
    const again: Ledger = {
      ...STACK,
      tasks: STACK.tasks.map(one => (one.id === 't395-2' ? { ...one, status: 'returned' as const, startedAt: AT, builtOn: 't395-1' } : one)),
    }
    expect(briefing(again, of(again, 't395-2'))).toContain(
      "- This task is built on the branch `cap/395-thresholds` (t395-1's change, not merged yet): its branch was started from there. Keep it so: do not rebase, and do not start over from main.",
    )
    const merged: Ledger = { ...again, tasks: again.tasks.map(one => (one.id === 't395-1' ? { ...one, status: 'done' as const } : one)) }
    expect(briefing(merged, of(merged, 't395-2'))).not.toContain('built on')
  })
})

describe('what the board holds of it', () => {
  test('a reserved start records what the task is built on, and a failed start takes it back', () => {
    const raw = JSON.parse(JSON.stringify(STACK)) as Raw
    const before = reserved(raw, AT, { taskId: 't395-2', name: 't395-2', slot: 1, builtOn: 't395-1' })!
    expect(parseLedger(JSON.stringify(raw)).ledger?.tasks.find(one => one.id === 't395-2')).toMatchObject({ status: 'building', builtOn: 't395-1' })
    released(raw, before)
    expect(raw.tasks.find(one => one.id === 't395-2')?.builtOn).toBeUndefined()

    reserved(raw, AT, { taskId: 't395-2', name: 't395-2', slot: 1 })
    expect(raw.tasks.find(one => one.id === 't395-2')?.builtOn, 'none when it starts from main').toBeUndefined()
  })

  test('a task behind a green one is next; one that still waits says for what', () => {
    const view = boardView(STACK, NOW)
    expect(view.next.map(row => row.id)).toEqual(['t392-1', 't395-2'])
    expect(view.waiting.map(row => [row.id, row.waitsFor])).toEqual([
      ['t392-2', ['t391-1', 't392-1']],
      ['t395-3', ['t393-1']],
    ])
  })

  test('a task built on another says so, on its line and in the handover', () => {
    const building: Ledger = {
      ...STACK,
      tasks: STACK.tasks.map(one => (one.id === 't395-2' ? { ...one, status: 'building' as const, worker: 't395-2', startedAt: AT, builtOn: 't395-1' } : one)),
    }
    expect(detail(boardView(building, NOW).building.find(row => row.id === 't395-2')!)).toBe('haiku · t395-2 · under 1 min · built on t395-1')
    const text = handover(building, { at: AT })
    expect(text).toContain('- t395-2 [building, haiku] Cap warning copy · worker t395-2 · built on t395-1 · after t395-1')
    expect(text).toContain('- A task starts once everything it waits for is green or done; it need not wait for the merge. It is merged only after what it waits for is done.')
  })

  test('a ledger whose task is built on a task the run does not have does not read', () => {
    const broken = { ...STACK, tasks: STACK.tasks.map(one => (one.id === 't395-2' ? { ...one, builtOn: 't999' } : one)) }
    expect(parseLedger(JSON.stringify(broken)).error).toBe('task t395-2: builtOn names "t999", which is no task of this run')
  })
})

type Ran = { text?: string; isError?: true; deny?: string; agentId?: string }
const raise = ($: Engine, input: Record<string, unknown>) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const call = ($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) =>
  raise($, { tool: `mcp__conductor__${tool}`, tool_use_id: `call-${tool}`, ...input, ...(agentId === undefined ? {} : { agentId }) })

test('a task behind a green one starts on its branch, is built and reviewed while that one is merged, and is merged after it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // The two workers of the fixture have handed back: two places are free.
  const ledger: Ledger = { ...STACK, tasks: STACK.tasks.map(one => (one.status === 'building' ? { ...one, status: 'returned' as const } : one)) }
  const files: Files = { [PATH]: file(ledger, 1) }
  const engine = world(on, files)
  const { forge } = engine
  const stored = (): Ledger => JSON.parse(files[PATH]?.text ?? '{}') as Ledger
  const HEAD = 'b'.repeat(40)
  const HEAD2 = 'd'.repeat(40)
  forge.pulls[548] = pull(HEAD)
  forge.checks[HEAD] = ci('success')
  await start($)
  await board($, 'demo')

  // The task behind the green one starts now, not after the merge.
  engine.agentIds.push('a2', 'a3')
  expect((await spawn($, 't395-3') as Ran).deny, 'one of the two it waits for is still in review').toBe(
    'conductor: t395-3 waits for t393-1 (review). A task starts once what it waits for is green (reviewed, its checks green) or done.',
  )
  expect((await spawn($, 't395-2') as Ran).agentId).toBe('a2')
  expect(of(stored(), 't395-2')).toMatchObject({ status: 'building', builtOn: 't395-1', slot: 1 })
  expect(engine.briefs.at(-1)).toContain('- Build on the branch `cap/395-thresholds`, not on main.')

  // Its worker hands back with a pull request of its own; the orchestrator finds it green.
  await call($, 'task_update', { task: 't395-2', status: 'review', pr: 560, branch: 'cap/395-copy' }, 'a2')
  forge.pulls[560] = pull(HEAD2)
  forge.checks[HEAD2] = ci('success')
  expect((await call($, 'task_update', { task: 't395-2', status: 'green' })).text, 'nothing waits for this one').toBe('t395-2: status green.')

  // It is not merged before the task it was built on.
  expect((await call($, 'merge_check', { task: 't395-2' })).text).toBe(
    't395-2 cannot merge yet:\n- t395-2 waits for t395-1 (green): what a task waits for is merged first, in that order.',
  )
  expect((await call($, 'merge', { task: 't395-2', told: [] })).text).toMatch(/^Not done\. Nothing was merged\. t395-2 cannot merge now:\n- t395-2 waits for t395-1 \(green\)/)
  expect(forge.merges).toEqual([])

  await $.command.run({ command: 'approve-merge', args: `t395-1 ${HEAD}`, origin: { kind: 'composer' } })
  await $.command.run({ command: 'approve-merge', args: `t395-2 ${HEAD2}`, origin: { kind: 'composer' } })

  // The one below merges first, and is done once GitHub has merged it.
  expect((await call($, 'merge', { task: 't395-1', told: [] })).text).toMatch(/^Merged: PR 548/)
  expect(of(stored(), 't395-1').status).toBe('done')
  await clock.advance(HALF_MINUTE)

  // Then the one built on it, with no fresh look at its own checks needed.
  expect((await call($, 'merge', { task: 't395-2', told: [] })).text).toMatch(/^Merged: PR 560/)
  expect(forge.merges.map(one => one.pr)).toEqual([548, 560])
})

test('setting a task green says what can start now, and on whose branch', async ($, on) => {
  mock.clock(on, { now: NOW })
  const ledger: Ledger = {
    ...STACK,
    tasks: [
      ...STACK.tasks,
      { id: 't393-2', title: 'Event loop follow-up', tier: 'sonnet', status: 'queued', files: ['api/loop.py'], dependsOn: ['t393-1'] },
      { id: 'note-1', title: 'A note, no pull request', tier: 'haiku', status: 'queued', files: ['docs/a.md'] },
      { id: 'note-2', title: 'A second note', tier: 'haiku', status: 'queued', files: ['docs/b.md'], dependsOn: ['note-1'] },
    ],
  }
  const files: Files = { [PATH]: file(ledger, 1) }
  world(on, files)
  await start($)
  await board($, 'demo')

  expect((await call($, 'task_update', { task: 't393-1', status: 'green' })).text).toBe(
    "t393-1: status green. Can start now, before this one is merged: t393-2 (built on t393-1's branch). Merge t393-1 all the same as soon as nothing else is merging.",
  )
  expect((await call($, 'task_update', { task: 't393-1', status: 'review' })).text, 'any other status says nothing of it').toBe('t393-1: status review.')
  expect((await call($, 'task_update', { task: 't396-1', status: 'green' })).text, 'nor a green task nothing waits for').toBe('t396-1: status green.')
  expect((await call($, 'task_update', { task: 'note-1', status: 'done' })).text, 'a done task is on main: there is nothing to say about a merge').toBe('note-1: status done.')
})

test('a bound session is told the new rule in its system prompt', async ($, on) => {
  mock.clock(on, { now: NOW })
  world(on, { [PATH]: file(STACK, 1) })
  await start($)
  await board($, 'demo')
  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(composed.sections[1]?.text).toContain(
    '- A task starts once everything it waits for is green (reviewed, its checks green) or done: it does not wait for the merge.',
  )
  expect(composed.sections[1]?.text).toContain('mcp__conductor__merge takes a task only after everything it waits for is done, so merge in that order.')
})
