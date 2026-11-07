import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { Ledger } from '../types'
import { BRANCH_CREATE, BRANCH_INFO_NEW, BRANCH_SWITCH, PUSH_FIRST, REPOSITORY_INFO, STATUS_CLEAN } from './lore-output'
import { DF, answers, ok, program } from './lore-world'
import { HOME, world } from './world'
import type { Files, World } from './world'

/** A home that is not a repository, inside the user's home folder, with a git place and a Lore place. */
export const HOME_ROOT = `${HOME}/work`
export const HOME_CONFIG = `${HOME_ROOT}/.claude/conductor/config.json`
export const LORE_WS = `${HOME_ROOT}/game/code/Big Game 5.8`
export const GIT_WS = `${HOME_ROOT}/studio`
export const FOLDER_CONFIG = {
  places: [
    { folder: 'studio', teams: ['ABC'], about: "the studio's own tools", check: { argv: ['npm', 'test'], timeoutMin: 20 } },
    { folder: 'game/code', teams: ['DEF'], about: 'engine and game code', lore: { branchPrefix: 'conductor/' } },
    { folder: 'game/art', teams: ['DEF'], about: '3D art and source assets' },
  ],
}
export const folderLedgerPath = (run: string): string => `${HOME_ROOT}/.claude/conductor/runs/${run}/ledger.json`

/** `/bin/pwd -P` run in a folder: its real path. Every folder here is its own real path unless a test says otherwise. */
export const realPaths = (links: Record<string, string> = {}) => ({
  match: (argv: readonly string[]) => argv[0] === '/bin/pwd' && argv[1] === '-P',
  answer: (_argv: readonly string[], cwd?: string) => {
    if (cwd === undefined) return { exitCode: 1, stdout: '', stderr: 'no folder' }
    let real = cwd
    for (const [from, to] of Object.entries(links)) {
      if (real === from || real.startsWith(`${from}/`)) real = `${to}${real.slice(from.length)}`
    }

    return { exitCode: 0, stdout: `${real}\n` }
  },
})

/**
 * The world beneath the mod in a home that is not a repository: the session
 * starts in the home (or where `cwd` says), which holds the config of three
 * places. `studio` is a git repository, `game/code` holds one Lore workspace,
 * and `game/art` holds none. `gitRoot` is the repository git names for the
 * session, when it starts inside one.
 */
export function folderWorld(on: On, files: Files, more: { cwd?: string; gitRoot?: string; config?: unknown } = {}): World {
  files[HOME_CONFIG] ??= { text: JSON.stringify(more.config ?? FOLDER_CONFIG), mtimeMs: 1 }
  const engine = world(on, files, more.gitRoot === undefined ? null : { root: more.gitRoot })
  engine.homes = [HOME_ROOT]
  engine.cwd = more.cwd ?? HOME_ROOT
  engine.dirs.push(HOME_ROOT, GIT_WS, `${GIT_WS}/.git`, `${HOME_ROOT}/game`, `${HOME_ROOT}/game/code`, LORE_WS, `${LORE_WS}/.lore`, `${HOME_ROOT}/game/art`)
  engine.listings[`${HOME_ROOT}/game/code`] = [{ name: 'Big Game 5.8', kind: 'dir' }]
  engine.listings[`${HOME_ROOT}/game/art`] = []
  engine.listings[GIT_WS] = []
  engine.programs.push(realPaths())
  engine.lore.push(answers(['--version'], ok('lore 0.12.0+1967')), answers(['repository', 'info'], ok(REPOSITORY_INFO)))

  return engine
}

export const startAt = ($: Engine, cwd = HOME_ROOT) => $.session.start({ cwd, surface: 'terminal', isInteractive: true })

export const conductIn = ($: Engine, args: string) =>
  $.command.run({ command: 'conduct', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

/** Calls a tool as the engine does, with its input beside the tool's name. */
export const callTool = ($: Engine, input: Record<string, unknown>) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ text?: string; result?: string; isError?: boolean }>)(input)

export const composePrompt = ($: Engine) =>
  $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })

/** A Lore run of the folder home, bound, its plan approved, in `root` (LORE_WS unless a test says), with every program answering as on a good day. */
export function loreRunIn(run: string, root = LORE_WS): Ledger {
  return {
    version: 1,
    run: {
      id: run,
      title: 'Retry',
      source: run,
      plan: 'approved',
      tickets: 'linear',
      startedAt: '2026-10-09T10:00:00.000Z',
      config: { tickets: 'linear', linear: { team: 'DEF' }, lore: { branchPrefix: 'conductor/' } },
      workspace: { kind: 'lore', root, place: 'game/code', base: 'main' },
      lore: { remote: 'lores://lore.example.test:41337', repository: 'conductor-spike', base: 'main', branch: `conductor/${run}` },
    },
    tasks: [
      { id: 't1', title: 'Task t1', tier: 'sonnet', tierReason: 'a change', status: 'queued', files: ['Source/t1.cpp'] },
      { id: 't2', title: 'Task t2', tier: 'sonnet', tierReason: 'a change', status: 'queued', files: ['Source/t2.cpp'] },
    ],
    problems: [],
    posts: [],
    rulings: [],
  }
}

/** Every lore and host program a Lore worker's start runs, answering as on a good day, for the workspace at `root`. */
export function goodDay(engine: World, files: Files, run: string, root = LORE_WS): void {
  for (const id of ['t1', 't2', '_run', '_check']) files[`${HOME_ROOT}/.claude/conductor/runs/${run}/listing-${id}.txt`] = { text: 'Source/\nSource/a.cpp\n', mtimeMs: 1 }
  engine.listings[root] = [
    { name: '.lore', kind: 'dir' },
    { name: 'Source', kind: 'dir' },
    { name: 'Game.uproject', kind: 'file' },
  ]
  engine.programs.push(program('df', ok(DF)), program('stat', ok('16777232\n')), program('cp', ok()), program('mkdir', ok()), program('/bin/sh', ok()), program('rm', ok()))
  engine.lore.unshift(
    answers(['repository', 'update-path'], ok()),
    answers(['status', '--scan'], ok(STATUS_CLEAN)),
    answers(['status'], ok(STATUS_CLEAN)),
    answers(['branch', 'switch'], ok(BRANCH_SWITCH)),
    answers(['branch', 'info'], ok(BRANCH_INFO_NEW)),
    answers(['branch', 'create'], ok(BRANCH_CREATE)),
    answers(['push'], ok(PUSH_FIRST)),
  )
}
