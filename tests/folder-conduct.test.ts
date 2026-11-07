import { expect, mock, test } from 'claude-code/testing'

import { PLACEHOLDER_SNIPPET, placeConfig } from '../hooks/project'
import type { Ledger, Place } from '../types'
import { NOW } from './fixture'
import { FOLDER_CONFIG, GIT_WS, HOME_CONFIG, HOME_ROOT, LORE_WS, conductIn, folderLedgerPath, folderWorld, startAt } from './folder-world'
import { ORIGIN, world } from './world'
import type { Files, World } from './world'

const PLACES = FOLDER_CONFIG.places as Place[]
const PLACEHOLDER = `${HOME_ROOT}/.claude/settings.local.json`
const ledgerOf = (files: Files, run: string): Ledger => JSON.parse(files[folderLedgerPath(run)]?.text ?? '{}') as Ledger
const runsWritten = (files: Files): string[] => Object.keys(files).filter(path => path.includes('/.claude/conductor/runs/'))

/** A home whose session folder declares the WorktreeCreate placeholder, and whose git repository answers its origin. */
function placed(on: Parameters<typeof folderWorld>[0], files: Files = {}, more: Parameters<typeof folderWorld>[2] = {}): { engine: World; files: Files } {
  files[PLACEHOLDER] ??= { text: PLACEHOLDER_SNIPPET, mtimeMs: 1 }
  const engine = folderWorld(on, files, more)
  engine.programs.unshift({
    match: (argv, cwd) => argv[0] === 'git' && argv[1] === '-C' && argv[2] === GIT_WS && argv[3] === 'remote' && argv[4] === 'get-url' && argv[5] === 'origin' && cwd === undefined,
    answer: { exitCode: 0, stdout: `${ORIGIN}\n` },
  })

  return { engine, files }
}

/** A second Lore workspace in game/code, beside the first. */
function secondLoreWorkspace(engine: World): string {
  const tools = `${HOME_ROOT}/game/code/Tools`
  engine.dirs.push(tools, `${tools}/.lore`)
  engine.listings[`${HOME_ROOT}/game/code`] = [{ name: 'Big Game 5.8', kind: 'dir' }, { name: 'Tools', kind: 'dir' }]

  return tools
}

test('a ticket with one workspace fixes it at /conduct', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files } = placed(on)
  await startAt($)
  const answer = await conductIn($, 'ABC-12')
  expect(answer.text.startsWith('Run ABC-12 is started from ABC-12.'), 'Run ABC-12 is started from ABC-12.').toBe(true)
  const run = ledgerOf(files, 'ABC-12').run
  expect(run.workspace).toEqual({ kind: 'git', root: GIT_WS, place: 'studio', base: 'main', remote: ORIGIN })
  expect(run.config).toEqual(placeConfig(PLACES[0]!, 'ABC'))
  expect(run.tickets).toBe('linear')
  expect(run.candidates).toBeUndefined()
})

test('a ticket whose team has several workspaces lists them for the orchestrator', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { engine, files } = placed(on)
  const tools = secondLoreWorkspace(engine)
  await startAt($)
  await conductIn($, 'DEF-4')
  const run = ledgerOf(files, 'DEF-4').run
  expect(run.candidates).toEqual([
    { kind: 'lore', root: LORE_WS, place: 'game/code', about: 'engine and game code' },
    { kind: 'lore', root: tools, place: 'game/code', about: 'engine and game code' },
  ])
  expect(run.workspace).toBeUndefined()
  expect(run.lore).toBeUndefined()
  expect(run.config).toEqual({ places: [PLACES[1], PLACES[2]] })
})

test('a Linear link gives its team', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files } = placed(on)
  await startAt($)
  await conductIn($, 'https://linear.app/team/issue/ABC-12')
  expect(ledgerOf(files, 'ABC-12').run.workspace?.root).toBe(GIT_WS)
})

test('refusals: no place for the team, no workspace, a GitHub issue, settings out of place', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { engine, files } = placed(on)
  await startAt($)
  expect((await conductIn($, 'XYZ-1')).text).toBe("No run was started. No place in .claude/conductor/config.json takes team XYZ: add XYZ to a place's teams.")
  expect((await conductIn($, '#12')).text).toBe(
    'No run was started. In a home that is not a repository, tickets are Linear: give the ticket\'s key, like /conduct ABC-12. A GitHub issue is run from a session in its own repository.',
  )
  engine.dirs.splice(engine.dirs.indexOf(`${LORE_WS}/.lore`), 1)
  expect((await conductIn($, 'DEF-4')).text).toBe(
    'No run was started. game/code and game/art hold no git or Lore workspace. Put the folder the work needs into Lore or git first, then give /conduct again.',
  )
  files[HOME_CONFIG] = { text: JSON.stringify({ ...FOLDER_CONFIG, lore: { minFreeGB: 5 } }), mtimeMs: 2 }
  expect((await conductIn($, 'ABC-12')).text).toBe('No run was started: config.json: in a home that is not a repository, lore belongs in a place: move it into the place it is for.')
  expect(runsWritten(files)).toEqual([])
})

test('a spec run works in the workspace that holds the spec', async ($, on) => {
  mock.clock(on, { now: NOW })
  const spec = `${LORE_WS}/docs/x.md`
  const { engine, files } = placed(on, { [spec]: { text: '# x\n', mtimeMs: 1 } })
  engine.dirs.push(`${LORE_WS}/docs`)
  await startAt($)
  await conductIn($, '"game/code/Big Game 5.8/docs/x.md"')
  const run = ledgerOf(files, 'x').run
  expect(run.workspace).toEqual({ kind: 'lore', root: LORE_WS, place: 'game/code', base: 'main' })
  expect(run.config?.linear?.team).toBe('DEF')
  expect(run.lore?.repository).toBe('conductor-spike')
  expect(run.lore?.branch.startsWith('conductor/'), 'conductor/').toBe(true)
})

test('in a folder home the ledgers need no .loreignore line', async ($, on) => {
  mock.clock(on, { now: NOW })
  const { files } = placed(on)
  await startAt($)
  expect(files[`${LORE_WS}/.loreignore`]).toBeUndefined()
  await conductIn($, 'DEF-4')
  expect(ledgerOf(files, 'DEF-4').run.workspace?.root).toBe(LORE_WS)
})

test("in a folder home the placeholder is read from the session's own folder", async ($, on) => {
  mock.clock(on, { now: NOW })
  const files: Files = { [`${LORE_WS}/.claude/settings.local.json`]: { text: PLACEHOLDER_SNIPPET, mtimeMs: 1 } }
  folderWorld(on, files)
  await startAt($)
  const answer = await conductIn($, 'DEF-4')
  expect(answer.text.startsWith('No run was started. Outside git, Claude Code lets the mod make each worker\'s workspace only when the project declares a WorktreeCreate hook'), 'No run was started. Outside git, Claude Code lets the mod make each worker\'s workspace only when the project declares a WorktreeCreate hook').toBe(true)
  expect(answer.text).toContain(PLACEHOLDER)
  expect(runsWritten(files)).toEqual([])
  files[PLACEHOLDER] = { text: PLACEHOLDER_SNIPPET, mtimeMs: 1 }
  await conductIn($, 'DEF-4')
  expect(ledgerOf(files, 'DEF-4').run.workspace?.root).toBe(LORE_WS)
})

test('a repository home refuses places', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files: Files = { '/repo/.claude/conductor/config.json': { text: JSON.stringify(FOLDER_CONFIG), mtimeMs: 1 } }
  world(on, files)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect((await conductIn($, 'ABC-12')).text).toBe('No run was started: config.json: places is for a home that is not itself a repository. Here the repository is the workspace: remove places.')
})

test('a git run names no check command: checks run for Lore workspaces only', async ($, on) => {
  mock.clock(on, { now: NOW })
  placed(on)
  await startAt($)
  const answer = await conductIn($, 'ABC-12')
  expect(answer.text).not.toContain('check command')
})
