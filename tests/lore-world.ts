import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { REPOSITORY_INFO } from './lore-output'
import { world } from './world'
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
