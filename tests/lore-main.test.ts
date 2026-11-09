import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Ledger } from '../types'
import { MERGE_ABORT, MERGE_CLEAN, MERGE_CONFLICT, MERGE_INTO_DONE, MERGE_INTO_PROTECTED, PUSH_RUN, REV_MAIN, REV_ON_MAIN, REV_RUN, REV_T1, STATUS_CLEAN, STATUS_COPIED } from './lore-output'
import { BASE, LORE_ROOT, RUN, RUN_BRANCH, answers, lored, ok, ranIn, stored, task } from './lore-world'
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
  run: { ...RUN.run, tickets: 'linear', lore: { ...RUN.run.lore!, workspace: RUN_WS, baseAt: REV_MAIN, head: REV_RUN } },
  tasks: [task('t1', { status: 'done', branch: `${RUN_BRANCH}/t1`, mergeCommit: REV_RUN }), task('t2', { status: 'done', branch: `${RUN_BRANCH}/t2`, mergeCommit: REV_RUN })],
}

/** A bound Lore run whose tasks are all merged into its branch, at REV_RUN, on a base still at REV_MAIN. */
async function finished($: Engine, on: Parameters<typeof lored>[1], ledger: Ledger = DONE) {
  const { files, engine, clock } = await lored($, on, ledger)
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

  return { files, engine, clock }
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

test("at the end of the run, what the copies took along from the owner's workspace keeps none of them", async ($, on) => {
  const t1 = `${BASE}/ABC-12/t1`
  const { files, engine } = await finished($, on, { ...DONE, tasks: [task('t1', { status: 'done', branch: `${RUN_BRANCH}/t1`, mergeCommit: REV_RUN, workspace: t1 })] })
  const settings = '{ "hooks": { "WorktreeCreate": [] } }\n'
  for (const at of [LORE_ROOT, t1, RUN_WS]) files[`${at}/.claude/settings.local.json`] = { text: settings, mtimeMs: 1 }
  engine.dirs.push(`${LORE_ROOT}/.claude`, `${t1}/.claude`, `${RUN_WS}/.claude`)
  engine.lore.unshift(answers(['status', '--scan'], ok(STATUS_COPIED), t1), answers(['status', '--scan'], ok(STATUS_COPIED), RUN_WS))

  expect((await approveMain($)).text).toContain('Its workspaces are removed.')
  const removed = engine.calls.map(one => one.argv).filter(argv => argv[0] === 'rm')
  expect(removed).toEqual([['rm', '-rf', '--', t1], ['rm', '-rf', '--', RUN_WS]])
})

test('across a whole run, no Lore write ran in the owner\'s workspace', async ($, on) => {
  const { engine } = await finished($, on)
  engine.lore.unshift(answers(['status', '--scan'], ok(STATUS_CLEAN)))
  await approveMain($)

  const reads = /^(--version|repository info|branch info|status)( |$)/
  const owner = engine.loreCalls.filter(one => one.cwd === '/work/Big Game 5.8').map(one => one.argv.slice(1).filter(arg => arg !== '--non-interactive').join(' '))
  expect(owner.filter(one => !reads.test(one) || one.includes('--scan'))).toEqual([])
})

test('a run branch head the board did not merge is never approved', async ($, on) => {
  const { files, engine } = await finished($, on)
  const stranger = 'abcdef0'.padEnd(64, '0')
  engine.lore.unshift(answers(['branch', 'info', RUN_BRANCH], ok(info(RUN_BRANCH, stranger))))

  const said = await approveMain($)
  expect(said.text).toContain('nobody judged')
  expect(ranIn(engine, RUN_WS)).not.toContain('branch unprotect main')
  expect(stored(files).run.approval).toBeUndefined()
})

test('a failed unprotect still protects the base again', async ($, on) => {
  const { files, engine } = await finished($, on)
  engine.lore.unshift(answers(['branch', 'unprotect'], { exitCode: 1, stdout: '[Error] Request handler timeout exceeded' }))

  const said = await approveMain($)
  expect(said.text).toContain('could not be unprotected')
  const ran = ranIn(engine, RUN_WS)
  expect(ran.indexOf('branch protect main')).toBeGreaterThan(ran.indexOf('branch unprotect main'))
  expect(stored(files).merge).toBeUndefined()
})

test('another run merging holds /approve-main', async ($, on) => {
  const { files, engine } = await finished($, on)
  const other: Ledger = { ...RUN, run: { ...RUN.run, id: 'other' }, merge: { task: 'other', revision: REV_RUN, target: 'base', state: 'merging', startedAt: '2026-10-09T10:29:00.000Z' } }
  files['/work/Big Game 5.8/.claude/conductor/runs/other/ledger.json'] = { text: JSON.stringify(other), mtimeMs: 1 }

  const said = await approveMain($)
  expect(said.text).toContain('Run other is merging')
  expect(ranIn(engine, RUN_WS)).not.toContain('branch unprotect main')
})

test('a base that moves during the approval is not merged into, and is protected again', async ($, on) => {
  const { files, engine } = await finished($, on)
  let looks = 0
  engine.lore.unshift({
    match: argv => argv.slice(1).filter(one => one !== '--non-interactive').join(' ') === 'branch info main',
    answer: () => {
      looks += 1

      return { exitCode: 0, stdout: info('main', looks === 1 ? REV_MAIN : REV_ON_MAIN) }
    },
  })

  const said = await approveMain($)
  expect(said.text).toContain('moved')
  const ran = ranIn(engine, RUN_WS)
  expect(ran.some(one => one.startsWith('branch merge into'))).toBe(false)
  expect(ran.at(-1)).toBe('branch protect main')
  expect(stored(files).run.merged).toBeUndefined()
})

test('run_sync_base never builds on a run branch head the board did not leave', async ($, on) => {
  const { engine } = await finished($, on)
  engine.lore.unshift(answers(['branch', 'info', RUN_BRANCH], ok(info(RUN_BRANCH, REV_MAIN))))

  const said = await call($, 'run_sync_base', {})
  expect(said.text).toContain('nobody judged')
  expect(ranIn(engine, RUN_WS).some(one => one.startsWith('branch merge main'))).toBe(false)
})

test('a base merge nobody heard back from is let go after a while, with the base protected again and a blocker on the board', async ($, on) => {
  const stuck: Ledger = { ...DONE, merge: { task: 'ABC-12', revision: REV_RUN, target: 'base', state: 'merging', startedAt: '2026-10-09T06:30:00.000Z' } }
  const { files, engine, clock } = await finished($, on, stuck)

  await clock.advance(30_000)
  expect(ranIn(engine, RUN_WS)).toContain('branch protect main')
  expect(stored(files).merge).toBeUndefined()
  expect(stored(files).problems.some(one => one.severity === 'blocker' && one.text.includes('lore history --branch main'))).toBe(true)
})

test('a fresh Lore claim is left alone', async ($, on) => {
  const fresh: Ledger = { ...DONE, merge: { task: 'ABC-12', revision: REV_RUN, target: 'base', state: 'merging', startedAt: '2026-10-09T10:29:00.000Z' } }
  const { files, clock } = await finished($, on, fresh)

  await clock.advance(30_000)
  expect(stored(files).merge).toBeDefined()
})

test('a Lore claim two hours old is left alone: a merge of a large branch may still be running in another session', async ($, on) => {
  const long: Ledger = { ...DONE, merge: { task: 'ABC-12', revision: REV_RUN, target: 'base', state: 'merging', startedAt: '2026-10-09T08:30:00.000Z' } }
  const { files, clock } = await finished($, on, long)

  await clock.advance(30_000)
  expect(stored(files).merge).toBeDefined()
})
