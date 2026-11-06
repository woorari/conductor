import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { REPOSITORY_INFO } from './lore-output'
import { answers, ok } from './lore-world'
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
