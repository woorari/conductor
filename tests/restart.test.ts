import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { parseLedger } from '../hooks/ledger'
import { briefing } from '../hooks/posts'
import { acted, updateTask } from '../hooks/signals'
import type { Raw } from '../hooks/signals'
import type { Ledger } from '../types'
import { LEDGER } from './fixture'
import { BASE, LORE_RUNS, RUN, lored, stored } from './lore-world'
import { spawn } from './world'

const AT = '2026-10-09T10:30:00.000Z'
const ORCHESTRATOR = { kind: 'orchestrator' } as const

/** The fixture with t392-1 building by the worker a1. */
function building(): Raw {
  const raw = JSON.parse(JSON.stringify(LEDGER)) as Raw
  const task = raw.tasks.find(one => one.id === 't392-1')!
  Object.assign(task, { status: 'building', worker: 't392-1', agentId: 'a1', startedAt: '2026-10-09T09:00:00.000Z', activity: { at: '2026-10-09T09:10:00.000Z', text: 'Bash: lore status --scan' } })

  return raw
}
const task = (raw: Raw, id: string) => raw.tasks.find(one => one.id === id)!

describe('the orchestrator takes a building task back', () => {
  test('by setting it to returned: its worker is retired, and the orchestrator is told how to go on', () => {
    const raw = building()
    const out = updateTask(raw, AT, ORCHESTRATOR, { task: 't392-1', status: 'returned' })
    expect(out.isError).toBeFalsy()
    expect(task(raw, 't392-1')).toMatchObject({ status: 'returned', retired: ['a1'], finishedAt: AT, activity: { at: AT, text: 'taken back by the orchestrator' } })
    expect(task(raw, 't392-1').agentId).toBeUndefined()
    expect(out.text).toBe(
      't392-1: status returned. Its worker a1 is retired: the mod refuses its tool calls from now on, so an attempt that still runs cannot change the workspace or the board. Start a worker again with t392-1 as its name: it works in the same workspace and is told to look at what is there first.',
    )
    expect(parseLedger(JSON.stringify(raw)).error, 'the ledger still reads').toBeUndefined()
  })

  test('each worker taken back is kept, the earlier ones too', () => {
    const raw = building()
    updateTask(raw, AT, ORCHESTRATOR, { task: 't392-1', status: 'returned' })
    Object.assign(task(raw, 't392-1'), { status: 'building', agentId: 'a2' })
    updateTask(raw, AT, ORCHESTRATOR, { task: 't392-1', status: 'returned' })
    expect(task(raw, 't392-1').retired).toEqual(['a1', 'a2'])
  })

  test('nothing else retires a worker: its own word, a note, or another status', () => {
    const own = building()
    updateTask(own, AT, { kind: 'worker', taskId: 't392-1' }, { task: 't392-1', status: 'blocked' })
    expect(task(own, 't392-1')).toMatchObject({ agentId: 'a1' })
    expect(task(own, 't392-1').retired).toBeUndefined()
    const noted = building()
    updateTask(noted, AT, ORCHESTRATOR, { task: 't392-1', note: 'looking at it' })
    expect(task(noted, 't392-1').retired).toBeUndefined()
    const reviewed = building()
    updateTask(reviewed, AT, ORCHESTRATOR, { task: 't392-1', status: 'review' })
    expect(task(reviewed, 't392-1')).toMatchObject({ agentId: 'a1' })
    expect(task(reviewed, 't392-1').retired).toBeUndefined()
  })

  test('what its old worker was seen doing before the take-back does not bring the task back to building', () => {
    const raw = building()
    updateTask(raw, AT, ORCHESTRATOR, { task: 't392-1', status: 'returned' })
    expect(acted(raw, 't392-1', { at: AT, text: 'Bash: lore push' })).toBe(false)
    expect(task(raw, 't392-1')).toMatchObject({ status: 'returned', activity: { text: 'taken back by the orchestrator' } })
    // Once a new worker has it, what it does counts.
    Object.assign(task(raw, 't392-1'), { status: 'building', agentId: 'a2' })
    delete task(raw, 't392-1').finishedAt
    expect(acted(raw, 't392-1', { at: AT, text: 'Read: README.md' })).toBe(true)
  })

  test('a task that is not building has no worker to take back', () => {
    const raw = building()
    Object.assign(task(raw, 't392-1'), { status: 'review', finishedAt: '2026-10-09T10:00:00.000Z' })
    const out = updateTask(raw, AT, ORCHESTRATOR, { task: 't392-1', status: 'returned' })
    expect(task(raw, 't392-1')).toMatchObject({ agentId: 'a1', status: 'returned' })
    expect(task(raw, 't392-1').retired).toBeUndefined()
    expect(out.text).toBe('t392-1: status returned.')
  })
})

describe('a worker started after one was taken back', () => {
  const lore = (): { ledger: Ledger; task: Ledger['tasks'][number] } => {
    const ledger = JSON.parse(JSON.stringify(RUN)) as Ledger
    const one = ledger.tasks[0]!
    Object.assign(one, { status: 'returned', startedAt: '2026-10-09T09:00:00Z', finishedAt: AT, retired: ['a1'], branch: `${ledger.run.lore!.branch}/${one.id}`, note: 'writing the parser' })

    return { ledger, task: one }
  }

  test('is told to look at what the earlier one left in the workspace before it goes on', () => {
    const { ledger, task: one } = lore()
    expect(briefing(ledger, one)).toContain(
      '- The worker before you was stopped before it handed back, so what it did may not be committed or pushed: start with lore status --scan and lore diff in your workspace, keep what serves the task, and commit and push it.',
    )
  })

  test('in git, with git status and git diff', () => {
    const raw = building()
    const ledger = parseLedger(JSON.stringify({ ...raw, tasks: raw.tasks.map(one => (one.id === 't392-1' ? { ...one, status: 'returned', retired: ['a1'] } : one)) })).ledger!
    expect(briefing(ledger, ledger.tasks.find(one => one.id === 't392-1')!)).toContain(
      '- The worker before you was stopped before it handed back, so what it did may not be committed or pushed: start with git status and git diff, keep what serves the task, and commit and push it.',
    )
  })

  test('a worker that handed back by itself leaves nothing of the kind to say', () => {
    const { ledger, task: one } = lore()
    delete one.retired
    expect(briefing(ledger, one)).not.toContain('was stopped before it handed back')
  })
})

// ---- through the engine: the old attempt is fenced, the new worker goes on in the same workspace ----

type Ran = { text?: string; isError?: true; deny?: string }
const raise = ($: Engine, input: Record<string, unknown>) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const bash = ($: Engine, command: string, agentId: string) => raise($, { tool: 'Bash', tool_use_id: `bash-${agentId}`, command, description: 'A command', agentId })
const worktree = ($: Engine, name: string) => ($.classic as unknown as { WorktreeCreate: (e: { name: string }) => Promise<{ worktreePath?: string }> }).WorktreeCreate({ name })
const FENCED = 'conductor: t1 was taken back from you by the orchestrator, and another worker may have it now. Stop: change nothing more, and end your turn.'

test('a worker taken back is refused from then on, and the one started after it goes on in the same workspace', async ($, on) => {
  const { files, engine } = await lored($, on)
  engine.agentIds.push('a1', 'a2')
  const path = `${BASE}/ABC-12/t1`
  await spawn($, 't1')
  expect(await worktree($, 'agent-a1')).toEqual({ worktreePath: path })
  // The copy is there now, finished.
  engine.dirs.push(path, `${path}/.lore`)
  expect(files[`${LORE_RUNS}/ABC-12/ready-t1`]).toBeDefined()

  const back = await raise($, { tool: 'mcp__conductor__task_update', tool_use_id: 'take-back', task: 't1', status: 'returned' })
  expect(back.text).toContain('Its worker a1 is retired')

  expect((await bash($, 'lore status --scan', 'a1')).deny).toBe(FENCED)
  const late = await raise($, { tool: 'mcp__conductor__task_update', tool_use_id: 'late', task: 't1', status: 'review', revision: 'e'.repeat(64), agentId: 'a1' })
  expect(late.deny, "the board is not the old worker's either").toBe(FENCED)
  expect(stored(files).tasks[0]?.status).toBe('returned')

  const copies = engine.calls.filter(one => one.argv[0] === 'cp').length
  await spawn($, 't1')
  expect(engine.calls.filter(one => one.argv[0] === 'cp').length, 'the workspace is reused, not copied again').toBe(copies)
  expect(await worktree($, 'agent-a2')).toEqual({ worktreePath: path })
  expect(stored(files).tasks[0]).toMatchObject({ status: 'building', agentId: 'a2', retired: ['a1'], workspace: path })
  expect((await bash($, 'lore status --scan', 'a2')).deny, 'the new worker works').toBeUndefined()

  // The old attempt's turn ending hands nothing back: the task is the new worker's.
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 'turn-a1', agentId: 'a1', reason: 'answer' } as never)
  expect(stored(files).tasks[0]?.status).toBe('building')
  expect((await bash($, 'ls', 'a1')).deny).toBe(FENCED)
})

test('a retired worker is still refused after the mod is loaded again', async ($, on) => {
  const ledger = JSON.parse(JSON.stringify(RUN)) as Ledger
  Object.assign(ledger.tasks[0]!, { status: 'returned', startedAt: '2026-10-09T09:00:00Z', finishedAt: AT, retired: ['a1'] })
  await lored($, on, ledger)
  expect((await bash($, 'ls', 'a1')).deny).toBe(FENCED)
})

test("a worker taken back takes its own subagents with it, and starts no new ones", async ($, on) => {
  const { files, engine } = await lored($, on)
  engine.agentIds.push('a1', 'c1', 'g1', 'a2', 'c2')
  const path = `${BASE}/ABC-12/t1`
  await spawn($, 't1')
  await worktree($, 'agent-a1')
  engine.dirs.push(path, `${path}/.lore`)
  await spawn($, undefined, 'a1')
  await spawn($, undefined, 'c1')
  expect((await bash($, 'ls', 'c1')).deny, "the worker's subagent works while the task is the worker's").toBeUndefined()

  await raise($, { tool: 'mcp__conductor__task_update', tool_use_id: 'take-back', task: 't1', status: 'returned' })
  expect((await bash($, 'ls', 'c1')).deny).toBe(FENCED)
  expect((await bash($, 'ls', 'g1')).deny, "its subagent's subagent too").toBe(FENCED)
  const late = (await spawn($, undefined, 'a1')) as { deny?: string }
  expect(late.deny).toBe(FENCED)
  expect(((await spawn($, undefined, 'c1')) as { deny?: string }).deny).toBe(FENCED)

  // The new worker's own subagent works.
  await spawn($, 't1')
  await worktree($, 'agent-a2')
  await spawn($, undefined, 'a2')
  expect(stored(files).tasks[0]).toMatchObject({ status: 'building', agentId: 'a2' })
  expect((await bash($, 'ls', 'c2')).deny).toBeUndefined()
})
