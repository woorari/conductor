import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Ledger } from '../types'
import { REV_MAIN, REV_RUN, REV_T1 } from './lore-output'
import { BASE, LORE_RUNS, RUN, RUN_BRANCH, lored, stored, task } from './lore-world'

type Ran = { text?: string; isError?: true }
const raise = ($: Engine, input: Record<string, unknown>) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const call = ($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) =>
  raise($, { tool: `mcp__conductor__${tool}`, tool_use_id: `call-${tool}`, ...input, ...(agentId === undefined ? {} : { agentId }) })

const T1_WS = `${BASE}/ABC-12/t1`
const CHECK = { argv: ['./Script/check.sh', '--fast'], timeoutMin: 20 }
const LOG = `${LORE_RUNS}/ABC-12/checks/t1-${REV_T1.slice(0, 7)}.log`
const REVIEW: Ledger = {
  ...RUN,
  run: { ...RUN.run, config: { check: CHECK }, lore: { ...RUN.run.lore!, workspace: `${BASE}/ABC-12/_run`, baseAt: REV_MAIN } },
  tasks: [task('t1', { status: 'review', branch: `${RUN_BRANCH}/t1`, revision: REV_T1, workspace: T1_WS, agentId: 'a1', worker: 't1' })],
}
const shells = (engine: Awaited<ReturnType<typeof lored>>['engine']) => engine.calls.filter(one => one.argv[0] === '/bin/sh' && one.argv.includes('--'))
const HALF_MINUTE = 30_000

test('green starts the check in the worker\'s workspace, its program and arguments as parameters', async ($, on) => {
  const { files, engine } = await lored($, on, REVIEW)

  await call($, 'task_update', { task: 't1', status: 'green' })
  const started = shells(engine)
  expect(started).toHaveLength(1)
  expect(started[0]?.argv.slice(3)).toEqual(['sh', T1_WS, '--', './Script/check.sh', '--fast'])
  expect(started[0]?.argv[2]).not.toContain('check.sh')
  expect(started[0]?.env).toEqual({ OUT: LOG })
  expect(stored(files).tasks[0]?.check).toMatchObject({ revision: REV_T1, verdict: 'running' })
})

test('an exit file of 0 passes the check', async ($, on) => {
  const { files, clock } = await lored($, on, REVIEW)
  await call($, 'task_update', { task: 't1', status: 'green' })

  files[LOG] = { text: 'building...\nall good\n', mtimeMs: 1 }
  files[`${LOG}.exit`] = { text: '0\n', mtimeMs: 1 }
  await clock.advance(HALF_MINUTE)
  expect(stored(files).tasks[0]?.check).toMatchObject({ revision: REV_T1, verdict: 'passed' })
})

test('a non-zero exit fails it with the log\'s last line', async ($, on) => {
  const { files, clock } = await lored($, on, REVIEW)
  await call($, 'task_update', { task: 't1', status: 'green' })

  files[LOG] = { text: 'building...\nerror: Source/t1.cpp:12: expected ;\n\n', mtimeMs: 1 }
  files[`${LOG}.exit`] = { text: '2\n', mtimeMs: 1 }
  await clock.advance(HALF_MINUTE)
  expect(stored(files).tasks[0]?.check).toMatchObject({ verdict: 'failed', line: 'error: Source/t1.cpp:12: expected ;' })
})

test('a check past its time is failed and stopped', async ($, on) => {
  const { files, engine, clock } = await lored($, on, REVIEW)
  await call($, 'task_update', { task: 't1', status: 'green' })
  files[`${LOG}.pid`] = { text: '4242\n', mtimeMs: 1 }

  await clock.advance(21 * 60_000)
  expect(stored(files).tasks[0]?.check).toMatchObject({ verdict: 'failed', line: 'timed out after 20 min' })
  expect(engine.calls.map(one => one.argv)).toContainEqual(['kill', '4242'])
})

test('a new revision restarts the check', async ($, on) => {
  const { engine, files, clock } = await lored($, on, REVIEW)
  await call($, 'task_update', { task: 't1', status: 'green' })
  files[`${LOG}.exit`] = { text: '0\n', mtimeMs: 1 }
  await clock.advance(HALF_MINUTE)

  await call($, 'task_update', { task: 't1', revision: REV_RUN }, 'a1')
  expect(stored(files).tasks[0]?.status, 'a new revision is judged again').toBe('review')
  await call($, 'task_update', { task: 't1', status: 'green' })
  expect(shells(engine)).toHaveLength(2)
  expect(shells(engine)[1]?.env).toEqual({ OUT: `${LORE_RUNS}/ABC-12/checks/t1-${REV_RUN.slice(0, 7)}.log` })
})

test('green on a task with no check configured starts nothing', async ($, on) => {
  const { engine } = await lored($, on, { ...REVIEW, run: { ...REVIEW.run, config: {} } })

  await call($, 'task_update', { task: 't1', status: 'green' })
  expect(shells(engine)).toEqual([])
})
