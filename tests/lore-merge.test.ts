import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Ledger } from '../types'
import { BRANCH_INFO_PUSHED, MERGE_ABORT, MERGE_CLEAN, MERGE_CONFLICT, PUSH_PROTECTED, PUSH_RUN, REV_MAIN, REV_RUN, REV_T1, STATUS_CLEAN, STATUS_UNTRACKED } from './lore-output'
import { BASE, LORE_RUNS, RUN, RUN_BRANCH, answers, lored, ok, ranIn, stored, task } from './lore-world'
import { LINEAR_TOKEN } from './world'

type Ran = { text?: string; isError?: true; deny?: string }
const raise = ($: Engine, input: Record<string, unknown>) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const call = ($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) =>
  raise($, { tool: `mcp__conductor__${tool}`, tool_use_id: `call-${tool}`, ...input, ...(agentId === undefined ? {} : { agentId }) })

const RUN_WS = `${BASE}/ABC-12/_run`
const T1_WS = `${BASE}/ABC-12/t1`
const T1_BRANCH = `${RUN_BRANCH}/t1`
const GREEN: Ledger = {
  ...RUN,
  run: { ...RUN.run, lore: { ...RUN.run.lore!, workspace: RUN_WS, baseAt: REV_MAIN } },
  tasks: [task('t1', { status: 'green', branch: T1_BRANCH, revision: REV_T1, workspace: T1_WS, ticket: 'ABC-13' }), task('t2')],
}
const MERGE = { task: 't1', told: [] }

/** A bound Lore run whose t1 is green at REV_T1, its branch still there, and lore merging cleanly. */
async function green($: Engine, on: Parameters<typeof lored>[1], ledger: Ledger = GREEN) {
  const { files, engine } = await lored($, on, ledger)
  engine.lore.unshift(
    answers(['branch', 'info', T1_BRANCH], ok(BRANCH_INFO_PUSHED)),
    answers(['branch', 'info', RUN_BRANCH], ok(`Branch ${RUN_BRANCH}\n  ID: 01a1b056f6bb701783e7a1beb2aa49a0\n  Latest: ${REV_MAIN}\n  Remote Latest: ${REV_MAIN}\n`)),
    answers(['branch', 'merge', 'abort'], ok(MERGE_ABORT)),
    answers(['branch', 'merge'], ok(MERGE_CLEAN)),
    answers(['push'], ok(PUSH_RUN), RUN_WS),
    answers(['status', '--scan'], ok(STATUS_CLEAN), T1_WS),
    answers(['lock', 'release'], ok()),
  )
  engine.env.LINEAR_API_KEY = LINEAR_TOKEN
  const states = { nodes: [{ id: 's-done', name: 'Done', type: 'completed', position: 3 }] }
  engine.linear.issues['ABC-13'] = {
    id: 'issue-ABC-13', identifier: 'ABC-13', title: 'One', description: '', url: 'https://linear.app/acme/issue/ABC-13',
    state: { name: 'In Progress', type: 'started' }, parent: null, children: { nodes: [] }, comments: { nodes: [] }, team: { id: 'team-abc', key: 'ABC', states },
  }

  return { files, engine }
}

test('a green task is merged into the run branch, pinned to its judged revision', async ($, on) => {
  const { files, engine } = await green($, on)

  const said = await call($, 'merge', MERGE)
  expect(said.text).toBe(`Merged: t1 is on ${RUN_BRANCH} as ${REV_RUN.slice(0, 7)}, and the task is done. Its workspace is removed: everything in it is in Lore. Go on at once: start what can start and merge the next green task.`)
  const ran = ranIn(engine, RUN_WS)
  expect(ran).toContain(`branch switch ${RUN_BRANCH} --reset`)
  expect(ran).toContain(`branch merge ${T1_BRANCH} --message=t1: Task t1`)
  expect(ran).toContain('push')
  expect(ran).toContain(`lock release --branch ${T1_BRANCH}`)
  const t1 = stored(files).tasks[0]
  expect(t1).toMatchObject({ status: 'done', mergeCommit: REV_RUN })
  expect(t1?.workspace).toBeUndefined()
  expect(stored(files).merge).toBeUndefined()
  expect(stored(files).run.lore?.head, 'the board knows what it put on the run branch').toBe(REV_RUN)
  expect(engine.calls.map(one => one.argv)).toContainEqual(['rm', '-rf', '--', T1_WS])
  expect(engine.linear.updated).toEqual([{ id: 'issue-ABC-13', input: { stateId: 's-done' } }])
})

test('a branch that moved since it was judged is refused, and nothing merges', async ($, on) => {
  const { files, engine } = await green($, on, { ...GREEN, tasks: [{ ...GREEN.tasks[0]!, revision: REV_MAIN }, GREEN.tasks[1]!] })

  const said = await call($, 'merge', MERGE)
  expect(said.text).toContain('Not done.')
  expect(said.text).toContain('moved since it was judged')
  expect(ranIn(engine, RUN_WS).some(one => one.startsWith('branch merge') || one.startsWith('branch switch'))).toBe(false)
  expect(stored(files).merge).toBeUndefined()
})

test('a conflict aborts, blocks the task and names the files; the run branch is untouched', async ($, on) => {
  const { files, engine } = await green($, on)
  engine.lore.unshift(answers(['branch', 'merge', T1_BRANCH], ok(MERGE_CONFLICT)))

  const said = await call($, 'merge', MERGE)
  expect(said.text).toContain('conflicts with the run branch in: a.txt')
  const ran = ranIn(engine, RUN_WS)
  expect(ran).toContain('branch merge abort')
  expect(ran).not.toContain('push')
  expect(stored(files).tasks[0]).toMatchObject({ status: 'blocked' })
  expect(stored(files).tasks[0]?.note).toContain('a.txt')
  expect(stored(files).merge).toBeUndefined()
})

test('a failed push lets the claim go, and the task stands green', async ($, on) => {
  const { files, engine } = await green($, on)
  engine.lore.unshift(answers(['push'], { exitCode: 17, stdout: PUSH_PROTECTED }, RUN_WS))

  const said = await call($, 'merge', MERGE)
  expect(said.text).toContain('was not merged')
  expect(said.text).toContain('Not authorized')
  expect(stored(files).merge).toBeUndefined()
  expect(stored(files).tasks[0]?.status).toBe('green')
})

test('merge_check says what stands in the way and runs no write', async ($, on) => {
  const { files, engine } = await green($, on)
  const before = files[`${LORE_RUNS}/ABC-12/ledger.json`]?.mtimeMs

  expect((await call($, 'merge_check', { task: 't1' })).text).toBe(`t1 may merge now: its branch ${T1_BRANCH} is at ${REV_T1.slice(0, 7)}, as it was judged. It merges into ${RUN_BRANCH}.`)
  expect(ranIn(engine, RUN_WS).every(one => one.startsWith('branch info'))).toBe(true)
  expect(files[`${LORE_RUNS}/ABC-12/ledger.json`]?.mtimeMs).toBe(before)
})

test('a task that is not green, or waits for an unmerged one, is not merged', async ($, on) => {
  await green($, on, { ...GREEN, tasks: [{ ...GREEN.tasks[0]!, status: 'review', dependsOn: ['t2'] }, GREEN.tasks[1]!] })

  const said = await call($, 'merge_check', { task: 't1' })
  expect(said.text).toContain('t1 is review: only a task you judged green')
  expect(said.text).toContain('t1 waits for t2 (queued)')
})

test('one merge at a time, across runs', async ($, on) => {
  const { files } = await green($, on)
  const other: Ledger = { ...RUN, run: { ...RUN.run, id: 'other' }, merge: { task: 't1', revision: REV_T1, target: 'run', state: 'merging', startedAt: new Date(Date.parse('2026-10-09T10:29:00Z')).toISOString() } }
  files[`${LORE_RUNS}/other/ledger.json`] = { text: JSON.stringify(other), mtimeMs: 1 }

  const said = await call($, 'merge', MERGE)
  expect(said.text).toContain('Run other is merging t1')
})

test('a check configured but not passed on this revision holds the merge', async ($, on) => {
  const config = { check: { argv: ['./check.sh'], timeoutMin: 20 } }
  await green($, on, { ...GREEN, run: { ...GREEN.run, config } })

  expect((await call($, 'merge_check', { task: 't1' })).text).toContain('the check (./check.sh) has not passed on')
})

test('a dirty workspace is kept after the merge, and the orchestrator is told why', async ($, on) => {
  const { files, engine } = await green($, on)
  engine.lore.unshift(answers(['status', '--scan'], ok(STATUS_UNTRACKED), T1_WS))

  const said = await call($, 'merge', MERGE)
  expect(said.text).toContain('Its workspace is kept')
  expect(engine.calls.map(one => one.argv)).not.toContainEqual(['rm', '-rf', '--', T1_WS])
  expect(stored(files).tasks[0]?.workspace).toBe(T1_WS)
})

test('a Lore task is handed back with its revision; with one it is done only by merging', async ($, on) => {
  const { engine } = await green($, on, { ...GREEN, tasks: [task('t1', { status: 'building', branch: T1_BRANCH, workspace: T1_WS, agentId: 'a1', worker: 't1' }), task('t2')] })
  void engine

  const bare = await call($, 'task_update', { task: 't1', status: 'review' }, 'a1')
  expect(bare.text).toContain('revision')
  expect((await call($, 'task_update', { task: 't1', status: 'review', revision: REV_T1 }, 'a1')).text).toContain('t1: status review, revision')
  expect((await call($, 'task_update', { task: 't1', status: 'done' })).text).toContain('call mcp__conductor__merge')
  expect((await call($, 'task_update', { task: 't2', status: 'done' })).text, 'a task with no code is done on the orchestrator\'s word').toContain('t2: status done')
})

test('a merge that took in another revision than the judged one is not pushed', async ($, on) => {
  const { files, engine } = await green($, on)
  engine.lore.unshift(answers(['branch', 'merge', T1_BRANCH], ok(MERGE_CLEAN.replace(REV_T1, REV_MAIN))), answers(['branch', 'reset'], ok()))

  const said = await call($, 'merge', MERGE)
  expect(said.text).toContain('not the judged')
  const ran = ranIn(engine, RUN_WS)
  expect(ran).not.toContain('push')
  expect(ran).toContain(`branch reset ${REV_MAIN} --branch ${RUN_BRANCH}`)
  expect(stored(files).tasks[0]?.status).toBe('green')
  expect(stored(files).merge).toBeUndefined()
})

test('the branch merged is the one the mod names, never one written on the task', async ($, on) => {
  const { engine } = await green($, on, { ...GREEN, tasks: [{ ...GREEN.tasks[0]!, branch: '--force' }, GREEN.tasks[1]!] })

  await call($, 'merge', MERGE)
  const merges = ranIn(engine, RUN_WS).filter(one => one.startsWith('branch merge '))
  expect(merges[0]).toBe(`branch merge ${T1_BRANCH} --message=t1: Task t1`)
  expect(ranIn(engine, RUN_WS).some(one => one.includes('--force'))).toBe(false)
})

test('once the last task is merged, the run branch\'s own check starts in the run workspace', async ($, on) => {
  const config = { check: { argv: ['./check.sh'], timeoutMin: 20 } }
  const passed = { revision: REV_T1, verdict: 'passed' as const, at: '2026-10-09T10:20:00.000Z' }
  const { engine } = await green($, on, { ...GREEN, run: { ...GREEN.run, config }, tasks: [{ ...GREEN.tasks[0]!, check: passed }] })

  await call($, 'merge', MERGE)
  const checks = engine.calls.filter(one => one.argv[0] === '/bin/sh' && one.argv.includes('--'))
  expect(checks.map(one => one.argv[4])).toEqual([RUN_WS])
  expect(checks[0]?.env).toEqual({ OUT: `${LORE_RUNS}/ABC-12/checks/_run-${REV_RUN.slice(0, 7)}.log` })
})

test('a task is never merged onto a run branch head the board did not leave', async ($, on) => {
  const { files, engine } = await green($, on, { ...GREEN, run: { ...GREEN.run, lore: { ...GREEN.run.lore!, head: REV_RUN } } })

  const said = await call($, 'merge', MERGE)
  expect(said.text).toContain('nobody judged')
  expect(ranIn(engine, RUN_WS).some(one => one.startsWith(`branch merge ${T1_BRANCH}`))).toBe(false)
  expect(stored(files).merge).toBeUndefined()
})

test('a workspace path written on the task is never what gets removed: the mod derives it', async ($, on) => {
  const { engine } = await green($, on, { ...GREEN, tasks: [{ ...GREEN.tasks[0]!, workspace: '/work/Big Game 5.8' }, GREEN.tasks[1]!] })
  engine.lore.unshift(answers(['status', '--scan'], ok(STATUS_CLEAN)))

  await call($, 'merge', MERGE)
  const removed = engine.calls.filter(one => one.argv[0] === 'rm').map(one => one.argv.at(-1))
  expect(removed).not.toContain('/work/Big Game 5.8')
  expect(removed.every(one => (one ?? '').startsWith(`${BASE}/`))).toBe(true)
})

test('a run whose workspaces folder reads as / removes nothing', async ($, on) => {
  const { engine } = await green($, on, { ...GREEN, run: { ...GREEN.run, config: { lore: { workspaces: '/' } } } })

  await call($, 'merge', MERGE)
  expect(engine.calls.filter(one => one.argv[0] === 'rm' && one.argv[1] === '-rf')).toEqual([])
})
