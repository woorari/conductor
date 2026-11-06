import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { PLACEHOLDER_SNIPPET } from '../hooks/project'
import type { Ledger, Task } from '../types'
import { NOW } from './fixture'
import { BRANCH_CREATE, BRANCH_INFO_NEW, BRANCH_SWITCH, PROTECTED, PUSH_FIRST, REPOSITORY_INFO, STATUS_CLEAN, UNPROTECTED } from './lore-output'
import { board, world } from './world'
import type { Files, LoreAnswer, World } from './world'

/** A Lore workspace whose path has a space in it, as real ones do. */
export const LORE_ROOT = '/work/Big Game 5.8'
export const LORE_RUNS = `${LORE_ROOT}/.claude/conductor/runs`
export const loreLedgerPath = (run: string): string => `${LORE_RUNS}/${run}/ledger.json`

/** An answer for every `lore` call whose arguments after the binary and `--non-interactive` begin with these. */
export const answers = (args: readonly string[], answer: LoreAnswer['answer'], cwd?: string): LoreAnswer => ({
  match: (argv, at) => {
    const rest = argv.slice(1).filter(one => one !== '--non-interactive')

    return /(^|\/)lore$/.test(argv[0] ?? '') && args.every((one, index) => rest[index] === one) && (cwd === undefined || at === cwd)
  },
  answer,
})

export const ok = (stdout = ''): LoreAnswer['answer'] => ({ exitCode: 0, stdout })

/**
 * The world beneath the mod in a Lore workspace: no git repository, a `.lore`
 * folder at the root, `lore` on the PATH, and its `repository info` answered.
 * A test adds answers in front with `engine.lore.unshift(...)`.
 */
export function loreWorld(on: On, files: Files, more: { cwd?: string } = {}): World {
  const engine = world(on, files, null)
  engine.origin = null
  engine.dirs.push(`${LORE_ROOT}/.lore`)
  engine.cwd = more.cwd ?? LORE_ROOT
  engine.lore.push(answers(['--version'], ok('lore 0.12.0+1967')), answers(['repository', 'info'], ok(REPOSITORY_INFO)))

  return engine
}

export const startIn = ($: Engine, cwd = LORE_ROOT) => $.session.start({ cwd, surface: 'terminal', isInteractive: true })

/** The arguments of each `lore` call after the binary and `--non-interactive`, with where it ran. */
export const loreRan = (engine: World): { args: string[]; cwd?: string }[] =>
  engine.loreCalls.map(call => ({ args: call.argv.slice(1).filter(one => one !== '--non-interactive'), cwd: call.cwd }))

export const BASE = `${LORE_ROOT}.conductor`
export const RUN_BRANCH = 'conductor/ABC-12-retry'
export const task = (id: string, more: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, tier: 'sonnet', tierReason: 'a change', status: 'queued', files: [`Source/${id}.cpp`], ...more })
export const RUN: Ledger = {
  version: 1,
  run: {
    id: 'ABC-12',
    title: 'Retry',
    source: 'ABC-12',
    plan: 'approved',
    startedAt: '2026-10-09T10:00:00.000Z',
    lore: { remote: 'lores://lore.example.test:41337', repository: 'conductor-spike', base: 'main', branch: RUN_BRANCH },
  },
  tasks: [task('t1'), task('t2')],
  problems: [],
  posts: [],
  rulings: [],
}
export const PATH = loreLedgerPath('ABC-12')
export const stored = (files: Files): Ledger => JSON.parse(files[PATH]?.text ?? '{}') as Ledger
export const program = (name: string, answer: LoreAnswer['answer']): LoreAnswer => ({ match: argv => argv[0] === name, answer })
export const DF = `Filesystem 1024-blocks      Used Available Capacity Mounted on\n/dev/disk3s5 971000000 850000000 92000000 91% /System/Volumes/Data\n`

/** A bound session in a Lore workspace whose run's plan is approved, with every program answering as on a good day. */
export async function lored($: Engine, on: Parameters<typeof world>[0], ledger: Ledger = RUN) {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = {
    [PATH]: { text: JSON.stringify(ledger), mtimeMs: 1 },
    [`${LORE_ROOT}/.loreignore`]: { text: '/Saved/\n/Intermediate/\n**/Intermediate/\n*.log\n.claude/conductor/runs/\n', mtimeMs: 1 },
    [`${LORE_ROOT}/.claude/settings.local.json`]: { text: PLACEHOLDER_SNIPPET, mtimeMs: 1 },
  }
  for (const id of ['t1', 't2', '_run']) files[`${LORE_RUNS}/ABC-12/listing-${id}.txt`] = { text: 'Source/\nSource/a.cpp\nSource/build.log\n', mtimeMs: 1 }
  const engine = loreWorld(on, files)
  engine.listings[LORE_ROOT] = [
    { name: '.lore', kind: 'dir' },
    { name: '.claude', kind: 'dir' },
    { name: 'Content', kind: 'dir' },
    { name: 'Saved', kind: 'dir' },
    { name: 'Source', kind: 'dir' },
    { name: 'Game.uproject', kind: 'file' },
  ]
  engine.programs.push(program('df', ok(DF)), program('cp', ok()), program('mkdir', ok()), program('/bin/sh', ok()), program('rm', ok()))
  engine.lore.unshift(
    answers(['repository', 'update-path'], ok()),
    answers(['status', '--scan'], ok(STATUS_CLEAN)),
    answers(['branch', 'switch'], ok(BRANCH_SWITCH)),
    answers(['branch', 'info'], ok(BRANCH_INFO_NEW)),
    answers(['branch', 'create'], ok(BRANCH_CREATE)),
    answers(['push'], ok(PUSH_FIRST)),
    answers(['branch', 'protect'], ok(PROTECTED)),
    answers(['branch', 'unprotect'], ok(UNPROTECTED)),
  )
  await startIn($)
  await board($, 'ABC-12')

  return { files, engine, clock }
}
/** The lore commands that ran in a folder, as their arguments joined. */
export const ranIn = (engine: World, cwd: string): string[] => loreRan(engine).filter(one => one.cwd === cwd).map(one => one.args.join(' '))
