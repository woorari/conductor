import { programCalls, isQuarantine } from './world'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Ledger } from '../types'
import { BRANCH_INFO_PUSHED, MERGE_ABORT, MERGE_CLEAN, MERGE_CONFLICT, PUSH_PROTECTED, PUSH_RUN, REV_MAIN, REV_RUN, REV_T1, STATUS_CLEAN, STATUS_COPIED, STATUS_COPIED_FOLDER, STATUS_UNTRACKED } from './lore-output'
import { BASE, LORE_ROOT, LORE_RUNS, RUN, RUN_BRANCH, answers, lored, ok, pinnable, ranIn, stored, task } from './lore-world'
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
  const { files, engine, clock } = await lored($, on, ledger)
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

  return { files, engine, clock }
}

test('merging a task carrying the parent ticket cannot close the Lore run issue', async ($, on) => {
  const ledger: Ledger = { ...GREEN, run: { ...GREEN.run, tickets: 'linear' }, tasks: GREEN.tasks.map(one => ({ ...one, ticket: 'ABC-12' })) }
  const { engine } = await green($, on, ledger)
  engine.linear.issues['ABC-12'] = { ...engine.linear.issues['ABC-13']!, id: 'issue-ABC-12', identifier: 'ABC-12' }
  await call($, 'merge', MERGE)
  expect(engine.linear.updated.filter(one => one.id === 'issue-ABC-12')).toEqual([])
})

/** The lore call that merges this branch, whatever its message. */
const mergeOf = (branch: string) => (argv: readonly string[]): boolean => {
  const args = argv.slice(1).filter(one => one !== '--non-interactive')

  return args[0] === 'branch' && args[1] === 'merge' && args[2] === branch
}
const MINUTE = 60_000

const AWHILE = 5000
const BACKGROUND = `t1 is merging into ${RUN_BRANCH}, and it goes on in the background: a large Lore merge can take up to an hour. The board tells you when it has landed or why it did not. Merge nothing else until then; anything else may go on.`

test('a merge that outlasts what one tool call waits goes on without the call, and the orchestrator is woken when it lands', { timeoutMs: 30_000 }, async ($, on) => {
  const { files, engine, clock } = await green($, on)
  engine.slow.push({ match: mergeOf(T1_BRANCH), ms: 11 * MINUTE, sleep: clock.sleep })

  const merging = call($, 'merge', MERGE)
  await clock.settle()
  await clock.advance(AWHILE)
  const said = await merging
  expect(said.isError).toBeUndefined()
  expect(said.text).toBe(BACKGROUND)
  expect(stored(files).merge, 'the claim holds while it merges').toMatchObject({ task: 't1', state: 'merging' })
  expect(stored(files).tasks[0]?.status).toBe('green')

  await clock.advance(11 * MINUTE)
  await clock.settle()
  expect(stored(files).tasks[0]).toMatchObject({ status: 'done', mergeCommit: REV_RUN })
  expect(stored(files).merge).toBeUndefined()
  await clock.advance(AWHILE)
  expect(engine.woke.at(-1)).toContain(`Run board: Merged: t1 is on ${RUN_BRANCH} as ${REV_RUN.slice(0, 7)}, and the task is done.`)
  expect(engine.stopped).toEqual([])
})

test('a merge that lands within the call is said by the call alone: nobody is woken for it', async ($, on) => {
  const { engine, clock } = await green($, on)

  expect((await call($, 'merge', MERGE)).text).toContain(`Merged: t1 is on ${RUN_BRANCH}`)
  await clock.advance(AWHILE)
  expect(engine.woke).toEqual([])
})

test('a merge still running after an hour is stopped and aborted; the claim is let go, nothing is pushed, and the orchestrator is told', { timeoutMs: 90_000 }, async ($, on) => {
  const { files, engine, clock } = await green($, on)
  engine.slow.push({ match: mergeOf(T1_BRANCH), ms: 3 * 60 * MINUTE, sleep: clock.sleep })

  const merging = call($, 'merge', MERGE)
  await clock.settle()
  await clock.advance(AWHILE)
  expect((await merging).text).toBe(BACKGROUND)
  await clock.advance(61 * MINUTE)
  await clock.settle()
  expect(engine.stopped.map(one => one.slice(2).join(' ')), 'the merge itself is stopped, nothing else').toEqual([`branch merge ${T1_BRANCH} --message=t1: Task t1`])
  const ran = ranIn(engine, RUN_WS)
  const merged = ran.findIndex(one => one.startsWith(`branch merge ${T1_BRANCH}`))
  expect(ran.indexOf('branch merge abort'), 'the half-done merge is aborted after it is stopped').toBeGreaterThan(merged)
  expect(ran).not.toContain('push')
  expect(stored(files).merge, 'the claim is let go: the merge may be tried again').toBeUndefined()
  expect(stored(files).tasks[0]?.status).toBe('green')
  expect(stored(files).run.lore?.head, 'the board puts nothing new on the run branch').toBe(GREEN.run.lore?.head)
  await clock.advance(AWHILE)
  expect(engine.woke.at(-1)).toContain('Run board: t1 was not merged: lore did not merge it: lore branch merge was still running after 60 minutes')
})

test('the next merge after a stopped one starts from the run branch as the server has it', { timeoutMs: 90_000 }, async ($, on) => {
  const { engine, clock } = await green($, on)
  engine.slow.push({ match: mergeOf(T1_BRANCH), ms: 3 * 60 * MINUTE, sleep: clock.sleep })
  const first = call($, 'merge', MERGE)
  await clock.settle()
  await clock.advance(AWHILE)
  expect((await first).text).toBe(BACKGROUND)
  await clock.advance(61 * MINUTE)
  await clock.settle()
  expect(engine.stopped, 'the first merge was stopped').toHaveLength(1)
  engine.slow.length = 0
  engine.loreCalls.length = 0

  const said = await call($, 'merge', MERGE)
  expect(said.text).toContain(`Merged: t1 is on ${RUN_BRANCH}`)
  const ran = ranIn(engine, RUN_WS)
  expect(ran.indexOf(`branch switch ${RUN_BRANCH} --reset`), 'the workspace is reset before anything is merged in it').toBeLessThan(ran.findIndex(one => one.startsWith(`branch merge ${T1_BRANCH}`)))
})

test('the steps that move a large branch are streamed past the engine limit; short lore commands keep their short limit', async ($, on) => {
  const { engine } = await green($, on)

  await call($, 'merge', MERGE)
  const lore = engine.calls.filter(one => one.cwd === RUN_WS && /(^|\/)lore$/.test(one.argv[0] ?? ''))
  const streamed = lore.filter(one => one.isStreamed === true).map(one => one.argv.slice(2).join(' '))
  expect(streamed).toEqual([`branch switch ${RUN_BRANCH} --reset`, `branch merge ${T1_BRANCH} --message=t1: Task t1`, 'push'])
  const short = lore.filter(one => one.isStreamed !== true)
  expect(short.map(one => one.argv.slice(2, 4).join(' '))).toEqual(expect.arrayContaining(['branch info', 'lock release']))
  expect(short.every(one => (one.timeoutMs ?? 30_000) <= 30_000), 'a look at a branch or a lock is no long step').toBe(true)
})

test('a green task is merged into the run branch, pinned to its judged revision', async ($, on) => {
  const { files, engine } = await green($, on)

  const said = await call($, 'merge', MERGE)
  expect(said.text).toBe(`Merged: t1 is on ${RUN_BRANCH} as ${REV_RUN.slice(0, 7)}, and the task is done. Its workspace was moved into _deleted: everything in it is in Lore. Go on at once: start what can start and merge the next green task.`)
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
  expect(programCalls(engine)).toContainEqual(['quarantine', '--', T1_WS])
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
  expect(programCalls(engine)).not.toContainEqual(['quarantine', '--', T1_WS])
  expect(stored(files).tasks[0]?.workspace).toBe(T1_WS)
})

test('a kept workspace names what keeps it', async ($, on) => {
  const { engine } = await green($, on)
  engine.lore.unshift(answers(['status', '--scan'], ok(STATUS_UNTRACKED), T1_WS))

  expect((await call($, 'merge', MERGE)).text).toContain(`Its workspace is kept at ${T1_WS}: it holds changes that are not pushed (untracked.txt). Look at it before you remove it.`)
})

const SETTINGS = '{ "hooks": { "WorktreeCreate": [] } }\n'
/** The owner's workspace holds a settings file Lore does not track, and the copy took it along; `text` is the copy's. */
function copiedAlong(world: Awaited<ReturnType<typeof green>>, text = SETTINGS): void {
  world.files[`${LORE_ROOT}/.claude/settings.local.json`] = { text: SETTINGS, mtimeMs: 1 }
  world.files[`${T1_WS}/.claude/settings.local.json`] = { text, mtimeMs: 1 }
  world.engine.dirs.push(`${LORE_ROOT}/.claude`, `${T1_WS}/.claude`)
  world.engine.lore.unshift(answers(['status', '--scan'], ok(STATUS_COPIED), T1_WS))
}

test("what the copy took along from the owner's workspace is not the worker's: the workspace is removed after the merge", async ($, on) => {
  const world = await green($, on)
  copiedAlong(world)

  const said = await call($, 'merge', MERGE)
  expect(said.text).toContain('Its workspace was moved into _deleted: everything in it is in Lore.')
  expect(programCalls(world.engine)).toContainEqual(['quarantine', '--', T1_WS])
  expect(stored(world.files).tasks[0]?.workspace).toBeUndefined()
})

test('a file the worker changed after the copy is its own, and keeps the workspace', async ($, on) => {
  const world = await green($, on)
  copiedAlong(world, '{ "hooks": {} }\n')

  const said = await call($, 'merge', MERGE)
  expect(said.text).toContain('it holds changes that are not pushed (.claude/, .claude/settings.local.json)')
  expect(programCalls(world.engine)).not.toContainEqual(['quarantine', '--', T1_WS])
  expect(stored(world.files).tasks[0]?.workspace).toBe(T1_WS)
})

test("a file the owner's workspace does not hold is the worker's, and keeps the workspace", async ($, on) => {
  const world = await green($, on)
  copiedAlong(world)
  delete world.files[`${LORE_ROOT}/.claude/settings.local.json`]

  expect((await call($, 'merge', MERGE)).text).toContain('it holds changes that are not pushed (.claude/, .claude/settings.local.json)')
  expect(programCalls(world.engine)).not.toContainEqual(['quarantine', '--', T1_WS])
})

test('bytes the engine does not hand back as base64 are never taken for the same, and keep the workspace', async ($, on) => {
  const world = await green($, on)
  copiedAlong(world)
  world.engine.isBytesWithoutBase64 = true

  expect((await call($, 'merge', MERGE)).text).toContain('it holds changes that are not pushed (.claude/, .claude/settings.local.json)')
  expect(programCalls(world.engine)).not.toContainEqual(['quarantine', '--', T1_WS])
})

/** As copiedAlong, with Lore listing the untracked folder by itself; the copy's folder holds `inside`. */
function folderAlong(world: Awaited<ReturnType<typeof green>>, inside: { name: string; kind: 'dir' | 'file' }[]): void {
  copiedAlong(world)
  world.engine.lore.shift()
  world.engine.lore.unshift(answers(['status', '--scan'], ok(STATUS_COPIED_FOLDER), T1_WS))
  world.engine.listings[`${T1_WS}/.claude`] = inside
}

test("a folder Lore lists by itself is the owner's only when every file in it is: then the workspace is removed", async ($, on) => {
  const world = await green($, on)
  folderAlong(world, [{ name: 'settings.local.json', kind: 'file' }])

  expect((await call($, 'merge', MERGE)).text).toContain('Its workspace was moved into _deleted: everything in it is in Lore.')
  expect(programCalls(world.engine)).toContainEqual(['quarantine', '--', T1_WS])
})

test("a file the worker added inside a folder the copy took along keeps the workspace, though Lore lists only the folder", async ($, on) => {
  const world = await green($, on)
  folderAlong(world, [
    { name: 'settings.local.json', kind: 'file' },
    { name: 'notes.md', kind: 'file' },
  ])
  world.files[`${T1_WS}/.claude/notes.md`] = { text: 'the worker\'s own\n', mtimeMs: 1 }

  expect((await call($, 'merge', MERGE)).text).toContain('it holds changes that are not pushed (.claude/)')
  expect(programCalls(world.engine)).not.toContainEqual(['quarantine', '--', T1_WS])
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
  pinnable(engine)

  await call($, 'merge', MERGE)
  const checks = engine.calls.filter(one => one.argv[0] === '/bin/sh' && one.argv.includes('--'))
  expect(checks.map(one => one.argv[4]), 'in the check workspace, never in the run workspace merges reset').toEqual([`${BASE}/ABC-12/_check`])
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
  const removed = programCalls(engine).filter(argv => argv[0] === 'quarantine').map(argv => argv.at(-1))
  expect(removed).not.toContain('/work/Big Game 5.8')
  expect(removed.every(one => (one ?? '').startsWith(`${BASE}/`))).toBe(true)
})

test('a run whose workspaces folder reads as / removes nothing', async ($, on) => {
  const { engine } = await green($, on, { ...GREEN, run: { ...GREEN.run, config: { lore: { workspaces: '/' } } } })

  await call($, 'merge', MERGE)
  expect(engine.calls.filter(one => isQuarantine(one.argv))).toEqual([])
})
