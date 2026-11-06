import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Ledger } from '../types'
import { NOW } from './fixture'
import { BRANCH_INFO_PUSHED, STATUS_UNTRACKED } from './lore-output'
import { BASE, DF, LORE_ROOT, LORE_RUNS, PATH, RUN, RUN_BRANCH, answers, lored, ok, program, ranIn, stored, task } from './lore-world'
import { spawn, start, world } from './world'

type Ran = { text?: string; isError?: true; deny?: string }
const raise = ($: Engine, input: Record<string, unknown>) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const bash = ($: Engine, command: string, agentId?: string) =>
  raise($, { tool: 'Bash', tool_use_id: 'bash', command, description: 'A command', ...(agentId === undefined ? {} : { agentId }) })
const worktree = ($: Engine, name: string) => ($.classic as unknown as { WorktreeCreate: (e: { name: string }) => Promise<{ worktreePath?: string }> }).WorktreeCreate({ name })


test('a worker start makes its workspace on its own branch, and the engine is told its path', async ($, on) => {
  const { files, engine } = await lored($, on)
  engine.agentIds.push('a1')

  await spawn($, 't1')
  const path = `${BASE}/ABC-12/t1`
  expect(ranIn(engine, path)).toEqual([
    'repository update-path',
    'status --scan',
    `branch switch ${RUN_BRANCH} --reset`,
    `branch info ${RUN_BRANCH}/t1`,
    `branch create ${RUN_BRANCH}/t1`,
    'push',
  ])
  expect(await worktree($, 'agent-a1')).toEqual({ worktreePath: path })
  expect(stored(files).tasks[0]).toMatchObject({ workspace: path, branch: `${RUN_BRANCH}/t1`, status: 'building' })
})

test('workspace paths with spaces travel as single arguments, and Saved is never copied', async ($, on) => {
  const { engine } = await lored($, on)
  engine.agentIds.push('a1')

  await spawn($, 't1')
  const copies = engine.calls.filter(one => one.argv[0] === 'cp')
  expect(copies.map(one => one.argv)).toEqual(
    ['.lore', '.claude', 'Content', 'Source', 'Game.uproject'].map(entry => ['cp', '-c', '-R', `${LORE_ROOT}/${entry}`, `${BASE}/ABC-12/t1/`]),
  )
  expect(copies.every(one => one.timeoutMs === 600_000), 'a copy may take minutes').toBe(true)
  const removed = engine.calls.filter(one => one.argv[0] === 'rm').map(one => one.argv)
  expect(removed, 'the log the listing found comes out of the copy').toContainEqual(['rm', '-rf', '--', `${BASE}/ABC-12/t1/Source/build.log`])
  const shell = engine.calls.find(one => one.argv[0] === '/bin/sh')?.argv ?? []
  expect(shell.slice(3), 'paths reach the shell as parameters, never inside its script').toEqual(['sh', `${BASE}/ABC-12/t1`, `${LORE_RUNS}/ABC-12/listing-t1.txt`])
  expect(shell[2]).not.toContain('Big Game')
})

test('what lore finds untracked in the copy is removed', async ($, on) => {
  const { engine } = await lored($, on)
  engine.lore.unshift(answers(['status', '--scan'], ok(STATUS_UNTRACKED)))
  engine.agentIds.push('a1')

  await spawn($, 't1')
  expect(engine.calls.map(one => one.argv)).toContainEqual(['rm', '-f', '--', `${BASE}/ABC-12/t1/untracked.txt`])
})

test('two starts in one message get one workspace each', async ($, on) => {
  const { files, engine } = await lored($, on)
  engine.agentIds.push('a1', 'a2')

  await Promise.all([spawn($, 't1'), spawn($, 't2')])
  expect(await worktree($, 'agent-a2')).toEqual({ worktreePath: `${BASE}/ABC-12/t2` })
  expect(await worktree($, 'agent-a1')).toEqual({ worktreePath: `${BASE}/ABC-12/t1` })
  expect(stored(files).tasks.map(one => one.workspace)).toEqual([`${BASE}/ABC-12/t1`, `${BASE}/ABC-12/t2`])
})

test('a failed copy releases the task and leaves no half workspace', async ($, on) => {
  const { files, engine } = await lored($, on)
  engine.programs.unshift(program('cp', { exitCode: 1, stdout: '', stderr: 'cp: No space left on device' }))
  engine.agentIds.push('a1')

  const said = await spawn($, 't1')
  expect((said as { deny?: string }).deny).toContain('No space left on device')
  expect(stored(files).tasks[0]?.status).toBe('queued')
  expect(engine.calls.map(one => one.argv)).toContainEqual(['rm', '-rf', '--', `${BASE}/ABC-12/t1`])
  expect(engine.spawns, 'no agent was started').toEqual([])
})

test('a folder that is there already and is no Lore workspace is never touched', async ($, on) => {
  const { files, engine } = await lored($, on)
  engine.dirs.push(`${BASE}/ABC-12/t1`)
  engine.agentIds.push('a1')

  const said = await spawn($, 't1')
  expect((said as { deny?: string }).deny).toContain('is there already')
  expect(engine.calls.some(one => one.argv[0] === 'rm' || one.argv[0] === 'cp'), 'nothing copied into it, nothing removed').toBe(false)
  expect(stored(files).tasks[0]?.status).toBe('queued')
})

test('too little disk denies the start before anything is copied', async ($, on) => {
  const { files, engine } = await lored($, on)
  engine.programs.unshift(program('df', ok(DF.replace('92000000', '10485760'))))
  engine.agentIds.push('a1')

  const said = await spawn($, 't1')
  expect((said as { deny?: string }).deny).toContain('10 GB')
  expect((said as { deny?: string }).deny).toContain('20 GB')
  expect(engine.calls.some(one => one.argv[0] === 'cp')).toBe(false)
  expect(stored(files).tasks[0]?.status).toBe('queued')
})

test('a task that builds on a green one starts from that task\'s branch', async ($, on) => {
  const ledger: Ledger = { ...RUN, tasks: [task('t1', { status: 'green', branch: `${RUN_BRANCH}/t1` }), task('t2', { dependsOn: ['t1'] })] }
  const { engine } = await lored($, on, ledger)
  engine.agentIds.push('a2')

  await spawn($, 't2')
  expect(ranIn(engine, `${BASE}/ABC-12/t2`)).toContain(`branch switch ${RUN_BRANCH}/t1 --reset`)
})

test('a restarted task reuses its pushed branch', async ($, on) => {
  const { engine } = await lored($, on)
  engine.lore.unshift(answers(['branch', 'info'], ok(BRANCH_INFO_PUSHED)))
  engine.agentIds.push('a1')

  await spawn($, 't1')
  const ran = ranIn(engine, `${BASE}/ABC-12/t1`)
  expect(ran).toContain(`branch switch ${RUN_BRANCH}/t1 --reset`)
  expect(ran.some(one => one.startsWith('branch create'))).toBe(false)
})

test('a worker whose workspace was never handed to it cannot write', async ($, on) => {
  const { engine } = await lored($, on)
  engine.agentIds.push('a1')
  await spawn($, 't1')

  const said = await bash($, 'touch x', 'a1')
  expect(said.deny).toContain('isolation: "worktree"')
  await worktree($, 'agent-a1')
  expect((await bash($, 'touch x', 'a1')).deny).toBeUndefined()
})

test('in git, WorktreeCreate answers nothing and the engine makes its own worktree', async ($, on) => {
  mock.clock(on, { now: NOW })
  world(on, {})
  await start($)

  expect(await worktree($, 'agent-a1')).toEqual({})
})

test('workspaces of two starts in one message are made side by side, not one after the other', async ($, on) => {
  const { engine } = await lored($, on)
  engine.agentIds.push('a1', 'a2')

  await Promise.all([spawn($, 't1'), spawn($, 't2')])
  const order = engine.calls.map(one => `${one.argv[0]} ${one.cwd ?? one.argv.at(-1) ?? ''}`)
  const firstOfT2 = order.findIndex(one => one.includes('/ABC-12/t2'))
  const lastOfT1 = order.map((one, at) => (one.includes('/ABC-12/t1') ? at : -1)).reduce((a, b) => Math.max(a, b), -1)
  expect(firstOfT2, 'the second copy starts before the first workspace is finished').toBeLessThan(lastOfT1)
})
