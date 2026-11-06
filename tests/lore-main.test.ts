import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Ledger } from '../types'
import { MERGE_ABORT, MERGE_CLEAN, MERGE_CONFLICT, MERGE_INTO_DONE, MERGE_INTO_PROTECTED, PUSH_RUN, REV_MAIN, REV_ON_MAIN, REV_RUN, REV_T1, STATUS_CLEAN } from './lore-output'
import { BASE, RUN, RUN_BRANCH, answers, lored, ok, ranIn, stored, task } from './lore-world'
import { LINEAR_TOKEN } from './world'

type Ran = { text?: string; isError?: true }
const raise = ($: Engine, input: Record<string, unknown>) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const call = ($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) =>
  raise($, { tool: `mcp__conductor__${tool}`, tool_use_id: `call-${tool}`, ...input, ...(agentId === undefined ? {} : { agentId }) })
const approveMain = ($: Engine, kind = 'composer') =>
  $.command.run({ command: 'approve-main', args: '', origin: { kind } as never, presentation: { isFullscreen: true, columns: 160 } })

const RUN_WS = `${BASE}/ABC-12/_run`
const info = (name: string, remote: string): string => `Branch ${name}\n  ID: 01a1b056f6bb701783e7a1beb2aa49a0\n  Latest: ${remote}\n  Remote Latest: ${remote}\n`
const status = (branch: string, revision: string): string => `On branch ${branch} revision 4 -> ${revision}\nRemote revision 4 -> ${revision}\nLocal branch in sync with remote\nNo tracked changes\n`
const DONE: Ledger = {
  ...RUN,
  run: { ...RUN.run, tickets: 'linear', lore: { ...RUN.run.lore!, workspace: RUN_WS, baseAt: REV_MAIN } },
  tasks: [task('t1', { status: 'done', branch: `${RUN_BRANCH}/t1`, mergeCommit: REV_RUN }), task('t2', { status: 'done', branch: `${RUN_BRANCH}/t2`, mergeCommit: REV_RUN })],
}

/** A bound Lore run whose tasks are all merged into its branch, at REV_RUN, on a base still at REV_MAIN. */
async function finished($: Engine, on: Parameters<typeof lored>[1], ledger: Ledger = DONE) {
  const { files, engine } = await lored($, on, ledger)
  engine.lore.unshift(
    answers(['branch', 'info', RUN_BRANCH], ok(info(RUN_BRANCH, REV_RUN))),
    answers(['branch', 'info', 'main'], ok(info('main', REV_MAIN))),
    answers(['status'], ok(status(RUN_BRANCH, REV_RUN)), RUN_WS),
    answers(['branch', 'merge', 'into'], ok(MERGE_INTO_DONE)),
    answers(['branch', 'merge', 'abort'], ok(MERGE_ABORT)),
    answers(['branch', 'archive'], ok()),
  )
  engine.env.LINEAR_API_KEY = LINEAR_TOKEN
  const states = { nodes: [{ id: 's-done', name: 'Done', type: 'completed', position: 3 }] }
  engine.linear.issues['ABC-12'] = {
    id: 'issue-ABC-12', identifier: 'ABC-12', title: 'Retry', description: '', url: 'https://linear.app/acme/issue/ABC-12',
    state: { name: 'In Progress', type: 'started' }, parent: null, children: { nodes: [] }, comments: { nodes: [] }, team: { id: 'team-abc', key: 'ABC', states },
  }

  return { files, engine }
}

test('approve-main merges the approved revision into the protected base and protects it again', async ($, on) => {
  const { files, engine } = await finished($, on)

  const said = await approveMain($)
  expect(said.text).toContain(`Merged: run ABC-12 is on main as ${REV_ON_MAIN.slice(0, 7)}`)
  const ran = ranIn(engine, RUN_WS)
  const at = (wanted: string) => ran.indexOf(wanted)
  expect(at('branch unprotect main')).toBeGreaterThan(-1)
  expect(at('branch merge into main Run ABC-12: Retry')).toBeGreaterThan(at('branch unprotect main'))
  expect(at('branch protect main')).toBeGreaterThan(at('branch merge into main Run ABC-12: Retry'))
  expect(ran).toContain(`branch archive ${RUN_BRANCH}/t1`)
  expect(ran).toContain(`branch archive ${RUN_BRANCH}/t2`)
  const { run, merge } = stored(files)
  expect(run.approval).toMatchObject({ revision: REV_RUN, base: REV_MAIN })
  expect(run.merged).toMatchObject({ revision: REV_ON_MAIN })
  expect(merge).toBeUndefined()
  expect(engine.linear.updated).toEqual([{ id: 'issue-ABC-12', input: { stateId: 's-done' } }])
})

test('the base is protected again when merge into fails', async ($, on) => {
  const { files, engine } = await finished($, on)
  engine.lore.unshift(answers(['branch', 'merge', 'into'], { exitCode: 17, stdout: MERGE_INTO_PROTECTED }))

  const said = await approveMain($)
  expect(said.text).toContain('Not authorized to access repository')
  expect(ranIn(engine, RUN_WS).at(-1)).toBe('branch protect main')
  expect(stored(files).run.merged).toBeUndefined()
  expect(stored(files).merge).toBeUndefined()
})

test('a base that cannot be protected again is a blocker on the board', async ($, on) => {
  const { files, engine } = await finished($, on)
  engine.lore.unshift(answers(['branch', 'protect'], { exitCode: 1, stdout: '[Error] Request handler timeout exceeded' }))

  const said = await approveMain($)
  expect(said.text).toContain('could not be protected again')
  expect(stored(files).problems.some(one => one.severity === 'blocker' && one.text.includes('main is not protected'))).toBe(true)
})

test('a run branch that moved after its approval is refused, and nothing is unprotected', async ($, on) => {
  const { files, engine } = await finished($, on)
  engine.lore.unshift(answers(['status'], ok(status(RUN_BRANCH, REV_MAIN)), RUN_WS))

  const said = await approveMain($)
  expect(said.text).toContain('moved')
  expect(ranIn(engine, RUN_WS)).not.toContain('branch unprotect main')
  expect(stored(files).run.merged).toBeUndefined()
})

test('a base that moved is refused, with run_sync_base named', async ($, on) => {
  const { engine } = await finished($, on)
  engine.lore.unshift(answers(['branch', 'info', 'main'], ok(info('main', REV_ON_MAIN))))

  const said = await approveMain($)
  expect(said.text).toContain('main moved since the run branch last took it in')
  expect(said.text).toContain('run_sync_base')
  expect(ranIn(engine, RUN_WS)).not.toContain('branch unprotect main')
})

test('run_sync_base brings the base in, and a new approval is needed', async ($, on) => {
  const approved: Ledger = { ...DONE, run: { ...DONE.run, approval: { revision: REV_RUN, base: REV_MAIN, at: '2026-10-09T10:00:00.000Z' } } }
  const { files, engine } = await finished($, on, approved)
  engine.lore.unshift(answers(['branch', 'info', 'main'], ok(info('main', REV_ON_MAIN))), answers(['branch', 'merge', 'main'], ok(MERGE_CLEAN.replace(REV_T1, REV_ON_MAIN))), answers(['push'], ok(PUSH_RUN), RUN_WS))

  const said = await call($, 'run_sync_base', {})
  expect(said.text).toContain(`Brought main into ${RUN_BRANCH}`)
  expect(said.text).toContain('/approve-main')
  expect(ranIn(engine, RUN_WS)).toContain(`branch merge main --message=Bring main into ${RUN_BRANCH}`)
  expect(stored(files).run.lore?.baseAt).toBe(REV_ON_MAIN)
  expect(stored(files).run.approval).toBeUndefined()
})

test('run_sync_base with a conflict aborts and records a blocker naming the files', async ($, on) => {
  const { files, engine } = await finished($, on)
  engine.lore.unshift(answers(['branch', 'merge', 'main'], ok(MERGE_CONFLICT)))

  const said = await call($, 'run_sync_base', {})
  expect(said.text).toContain('a.txt')
  expect(ranIn(engine, RUN_WS)).toContain('branch merge abort')
  expect(ranIn(engine, RUN_WS)).not.toContain('push')
  expect(stored(files).problems.some(one => one.severity === 'blocker' && one.text.includes('a.txt'))).toBe(true)
})

test('approve-main while a task or a warning is open names what stands in the way', async ($, on) => {
  const open: Ledger = { ...DONE, tasks: [DONE.tasks[0]!, task('t2', { status: 'green' })], problems: [{ id: 'P1', text: 'Flaky test', severity: 'warning', status: 'open' }] }
  const { engine } = await finished($, on, open)

  const said = await approveMain($)
  expect(said.text).toContain('t2 is green')
  expect(said.text).toContain('P1')
  expect(ranIn(engine, RUN_WS)).not.toContain('branch unprotect main')
})

test('no tool and no other session can merge into the base', async ($, on) => {
  await finished($, on)

  expect((await call($, 'merge', { task: 'ABC-12', told: [] })).text).toContain('There is no task ABC-12')
  for (const kind of ['peer', 'task-notification', 'scheduled-trigger']) {
    expect((await approveMain($, kind)).text, kind).toContain('only the owner')
  }
})

test('a Lore session registers /approve-main and run_sync_base', async ($, on) => {
  const { engine } = await finished($, on)
  expect(engine.registered).toContain('/approve-main')
  expect(engine.registered).toContain('run_sync_base')
})

test('across a whole run, no Lore write ran in the owner\'s workspace', async ($, on) => {
  const { engine } = await finished($, on)
  engine.lore.unshift(answers(['status', '--scan'], ok(STATUS_CLEAN)))
  await approveMain($)

  const reads = /^(--version|repository info|branch info|status)( |$)/
  const owner = engine.loreCalls.filter(one => one.cwd === '/work/Big Game 5.8').map(one => one.argv.slice(1).filter(arg => arg !== '--non-interactive').join(' '))
  expect(owner.filter(one => !reads.test(one) || one.includes('--scan'))).toEqual([])
})
