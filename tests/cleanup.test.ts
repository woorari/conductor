import { programCalls, isQuarantine } from './world'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { PLACEHOLDER_SNIPPET } from '../hooks/project'
import type { Ledger } from '../types'
import { LEDGER, NOW } from './fixture'
import { STATUS_COPIED, STATUS_UNTRACKED } from './lore-output'
import { BASE, LORE_ROOT, RUN, answers, lored, ok, stored, task } from './lore-world'
import { board, file, ledgerPath, start, world } from './world'
import type { Files, World } from './world'

const cleanup = ($: Engine, args = '', kind = 'composer') =>
  $.command.run({ command: 'cleanup', args, origin: { kind } as never, presentation: { isFullscreen: true, columns: 160 } })

const T1_WS = `${BASE}/ABC-12/t1`
const T2_WS = `${BASE}/ABC-12/t2`
const T3_WS = `${BASE}/ABC-12/t3`
const LISTED = '/cleanup <task id> or /cleanup all moves these workspaces into _deleted. Nothing is permanently deleted.'
const FREE = `87 GB are free now on the disk that holds ${LORE_ROOT}.`

/** A Lore run that kept the workspaces of two done tasks, t1 with a file of its worker's and t2 with only what its copy took along, while t3 still builds. */
const KEPT: Ledger = {
  ...RUN,
  tasks: [
    task('t1', { status: 'done', workspace: T1_WS }),
    task('t2', { status: 'done', workspace: T2_WS }),
    task('t3', { status: 'building', workspace: T3_WS }),
    task('t4', { status: 'done' }),
  ],
}

async function kept($: Engine, on: Parameters<typeof lored>[1], ledger: Ledger = KEPT) {
  const made = await lored($, on, ledger)
  const { files, engine } = made
  engine.dirs.push(T1_WS, T2_WS, T3_WS, `${LORE_ROOT}/.claude`, `${T2_WS}/.claude`)
  files[`${T2_WS}/.claude/settings.local.json`] = { text: PLACEHOLDER_SNIPPET, mtimeMs: 1 }
  engine.lore.unshift(answers(['status', '--scan'], ok(STATUS_UNTRACKED), T1_WS), answers(['status', '--scan'], ok(STATUS_COPIED), T2_WS))

  return made
}

const removed = (engine: World): string[][] => programCalls(engine).filter(argv => argv[0] === 'quarantine')

test('/cleanup lists the kept workspaces of done tasks and what keeps each, and removes nothing', async ($, on) => {
  const { files, engine } = await kept($, on)

  expect((await cleanup($)).text).toBe(
    [
      'Run ABC-12 keeps the workspaces of 2 done tasks:',
      `- t1 at ${T1_WS}: it holds changes that are not pushed (untracked.txt)`,
      `- t2 at ${T2_WS}: it holds nothing of its own, only what the copy took along`,
      LISTED,
    ].join('\n'),
  )
  expect(removed(engine)).toEqual([])
  expect(stored(files).tasks.map(one => one.workspace)).toEqual([T1_WS, T2_WS, T3_WS, undefined])
})

test('/cleanup with a task id removes that done task\'s workspace, changes not pushed and all, and the board forgets it', async ($, on) => {
  const { files, engine } = await kept($, on)

  expect((await cleanup($, 't1')).text).toBe(`Cleared workspace records for t1; existing folders moved into _deleted. ${FREE}`)
  expect(removed(engine)).toEqual([['quarantine', '--', T1_WS]])
  expect(stored(files).tasks.map(one => one.workspace)).toEqual([undefined, T2_WS, T3_WS, undefined])
})

test('/cleanup all removes every kept workspace of a done task, never one whose task is still at work', async ($, on) => {
  const { files, engine } = await kept($, on)

  expect((await cleanup($, 'all')).text).toBe(`Cleared workspace records for t1, t2; existing folders moved into _deleted. ${FREE}`)
  expect(removed(engine)).toEqual([['quarantine', '--', T1_WS], ['quarantine', '--', T2_WS]])
  expect(stored(files).tasks.map(one => one.workspace)).toEqual([undefined, undefined, T3_WS, undefined])
})

test('a task that is not done, keeps no workspace or is not in the run is named with why, and nothing of it is removed', async ($, on) => {
  const { files, engine } = await kept($, on)

  expect((await cleanup($, 't3, t4 t9')).text).toBe('Not removed: t3 (it is building, not done), t4 (it keeps no workspace), t9 (there is no such task in this run).')
  expect(removed(engine)).toEqual([])
  expect(stored(files).tasks.map(one => one.workspace)).toEqual([T1_WS, T2_WS, T3_WS, undefined])
})

test('only the owner removes a workspace: another session, a plugin or a channel removes nothing', async ($, on) => {
  const { files, engine } = await kept($, on)
  for (const kind of ['peer', 'plugin', 'channel', 'scheduled-trigger']) {
    expect((await cleanup($, 'all', kind)).text, kind).toBe('Not done. Only the owner removes workspaces, typing /cleanup in the terminal, the desktop app or Remote Control. Nothing was removed.')
  }
  expect(removed(engine)).toEqual([])
  expect(stored(files).tasks.map(one => one.workspace)).toEqual([T1_WS, T2_WS, T3_WS, undefined])
})

test('a folder the mod did not make for its task is listed as left alone and never removed', async ($, on) => {
  const elsewhere = '/work/elsewhere/t1'
  const { files, engine } = await kept($, on, { ...KEPT, tasks: [task('t1', { status: 'done', workspace: elsewhere })] })
  engine.dirs.push(elsewhere)

  expect((await cleanup($)).text).toBe(
    ['Run ABC-12 keeps the workspaces of 1 done task:', `- t1 at ${elsewhere}: it is not the folder the mod made for this task, so /cleanup leaves it alone`, LISTED].join('\n'),
  )
  expect((await cleanup($, 'all')).text).toBe('Not removed: t1 (it is not the folder the mod made for this task).')
  expect(removed(engine)).toEqual([])
  expect(stored(files).tasks[0]?.workspace).toBe(elsewhere)
})

test('a workspace that is gone already is listed so, and /cleanup forgets it without removing anything', async ($, on) => {
  const { files, engine } = await kept($, on, { ...KEPT, tasks: [task('t1', { status: 'done', workspace: T1_WS })] })
  engine.dirs.splice(engine.dirs.indexOf(T1_WS), 1)

  expect((await cleanup($)).text).toContain(`- t1 at ${T1_WS}: it is gone already`)
  expect((await cleanup($, 't1')).text).toBe(`Cleared workspace records for t1; existing folders moved into _deleted. ${FREE}`)
  expect(removed(engine)).toEqual([])
  expect(stored(files).tasks[0]?.workspace).toBeUndefined()
})

test('a removal that fails keeps the workspace on the board and says why', async ($, on) => {
  const { files, engine } = await kept($, on)
  engine.programs.unshift({ match: argv => isQuarantine(argv), answer: { exitCode: 1, stdout: 'rm: Directory not empty' } })

  expect((await cleanup($, 't1')).text).toBe(`Not removed: t1 (quarantine could not move it: rm: Directory not empty). ${FREE}`)
  expect(stored(files).tasks[0]?.workspace).toBe(T1_WS)
})

test('a run that keeps no workspace of a done task says so', async ($, on) => {
  await kept($, on, { ...KEPT, tasks: [task('t1', { status: 'done' })] })

  expect((await cleanup($)).text).toBe('Run ABC-12 keeps no workspace of a done task.')
  expect((await cleanup($, 'all')).text).toBe('Run ABC-12 keeps no workspace of a done task.')
})

test('a Lore session registers /cleanup', async ($, on) => {
  const { engine } = await kept($, on)
  expect(engine.registered).toContain('/cleanup')
})

test('in a run that is not a Lore run, /cleanup removes nothing and says so', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files: Files = { [ledgerPath('demo')]: file(LEDGER, 1) }
  world(on, files)
  await start($)
  await board($, 'demo')

  expect((await cleanup($, 'all')).text).toBe('Run demo is no Lore run: /cleanup removes only the workspaces a Lore run copied. A git worktree is git\'s: git worktree list shows them.')
})
