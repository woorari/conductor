import { expect, test } from 'claude-code/testing'

import type { Io } from '../hooks/home'
import { ISSUE_IN_FOLDER, fixWorkspace, pickWorkspace, placeRun, teamOfKey } from '../hooks/place-run'
import type { PlaceHost } from '../hooks/place-run'
import { PLACEHOLDER_SNIPPET } from '../hooks/project'
import type { Place } from '../types'

const HOME = '/work/studio-home'
const CODE = `${HOME}/game/code`
const WS = `${CODE}/Big Game`
const PLACES: Place[] = [
  { folder: 'game/code', teams: ['DEF'], about: 'engine and game code', lore: { branchPrefix: 'eng/', carry: [], minFreeGB: 0 } },
  { folder: 'tools', teams: ['ABC'], about: 'the tools' },
]

function tree(paths: readonly string[]): Io {
  const dirs = new Set<string>()
  for (const path of paths) for (let at = path; at !== ''; at = at.slice(0, at.lastIndexOf('/'))) dirs.add(at)

  return {
    exists: async path => dirs.has(path),
    list: async path => [...dirs].filter(one => one.startsWith(`${path}/`) && !one.slice(path.length + 1).includes('/')).map(one => ({ name: one.slice(path.length + 1), kind: 'dir' as const })),
    real: async path => (dirs.has(path) ? path : undefined),
    userHome: '/Users/me',
  }
}

/** A fake host: the disk as `tree`, the session's folder and git state, and the programs it answers. */
function fake(paths: string[], more: { files?: Record<string, string>; inGit?: boolean; loreBin?: boolean; loreOut?: { exitCode: number; out: string }; remote?: string } = {}) {
  const calls: string[] = []
  const host: PlaceHost = {
    io: async () => tree(paths),
    isInGit: async () => more.inGit ?? false,
    cwd: async () => `${HOME}/`,
    read: async path => more.files?.[path],
    hasLore: async () => more.loreBin ?? true,
    loreMissing: 'lore is not installed.',
    lore: async (args, cwd) => {
      calls.push(`lore ${args.join(' ')} @${cwd}`)

      return more.loreOut ?? { exitCode: 0, out: 'big-game (01a1b056c981721b88ecc4b6b66d6f45)\nRemote URL: lores://lore.example.test:41337\nDefault branch: main\n' }
    },
    run: async argv => {
      calls.push(argv.join(' '))

      return { exitCode: more.remote === undefined ? 2 : 0, stdout: `${more.remote ?? ''}\n` }
    },
    baseBranch: 'main',
  }

  return { host, calls }
}
const SETTINGS = { [`${HOME}/.claude/settings.local.json`]: PLACEHOLDER_SNIPPET }
const PROJECT = { places: PLACES }

test('a Linear key picks the team before the dash and its one workspace is fixed', async () => {
  expect(teamOfKey('ABC-12')).toBe('ABC')
  const world = fake([`${HOME}/tools/.git`], { files: SETTINGS, remote: 'git@example.test:tools.git' })
  const placed = await placeRun(world.host, HOME, { id: 'ABC-12', source: 'ABC-12', kind: 'linear' }, PROJECT)
  expect(placed).toEqual({
    workspace: { kind: 'git', root: `${HOME}/tools`, place: 'tools', base: 'main', remote: 'git@example.test:tools.git' },
    config: { tickets: 'linear', linear: { team: 'ABC' } },
  })
  expect(world.calls).toEqual([`git -C ${HOME}/tools remote get-url origin`])
})

test('several workspaces for the team are listed for the orchestrator to pick from', async () => {
  const world = fake([`${WS}/.lore`, `${CODE}/Tools/.lore`], { files: SETTINGS })
  const placed = await placeRun(world.host, HOME, { id: 'DEF-4', source: 'DEF-4', kind: 'linear' }, PROJECT)
  expect(placed).toEqual({
    config: { places: [PLACES[0]] },
    candidates: [
      { kind: 'lore', root: `${CODE}/Big Game`, place: 'game/code', about: 'engine and game code' },
      { kind: 'lore', root: `${CODE}/Tools`, place: 'game/code', about: 'engine and game code' },
    ],
  })
})

test('a GitHub issue, and a config that lists no places, start no run', async () => {
  const world = fake([`${HOME}/tools/.git`])
  expect(await placeRun(world.host, HOME, { id: '12', source: '#12', kind: 'issue' }, PROJECT)).toEqual({ error: ISSUE_IN_FOLDER })
  expect(await placeRun(world.host, HOME, { id: 'ABC-12', source: 'ABC-12', kind: 'linear' }, {})).toMatchObject({ error: expect.stringContaining('No run was started: config.json: this home is not a repository') })
})

test('a missing placeholder reports the folder', async () => {
  const world = fake([`${HOME}/tools/.git`])
  const placed = await placeRun(world.host, HOME, { id: 'ABC-12', source: 'ABC-12', kind: 'linear' }, PROJECT)
  expect(placed).toEqual({ error: expect.stringContaining(`Add this to ${HOME}/.claude/settings.local.json (or ${HOME}/.claude/settings.json)`) })
  expect(JSON.stringify(placed)).toContain(JSON.stringify(PLACEHOLDER_SNIPPET).slice(1, 40))
  // Inside git the placeholder is not asked for.
  const inGit = fake([`${HOME}/tools/.git`], { inGit: true })
  expect(await placeRun(inGit.host, HOME, { id: 'ABC-12', source: 'ABC-12', kind: 'linear' }, PROJECT)).toMatchObject({ workspace: { kind: 'git' } })
})

test('a spec lying in no workspace of a place starts no run', async () => {
  const world = fake([`${HOME}/tools/.git`], { files: SETTINGS })
  expect(await placeRun(world.host, HOME, { id: 's', source: 'elsewhere/spec.md', kind: 'spec' }, PROJECT)).toEqual({
    error: 'No run was started. elsewhere/spec.md lies in no workspace of a place in .claude/conductor/config.json.',
  })
})

test('fixWorkspace fixes a Lore workspace with its repository and run branch, and says why it could not', async () => {
  const candidate = { kind: 'lore' as const, root: WS, place: 'game/code', about: '' }
  const world = fake([`${WS}/.lore`], { files: SETTINGS })
  const fixed = await fixWorkspace(world.host, { id: 'DEF-4', source: 'DEF-4', title: 'Retry' }, candidate, PLACES[0]!, 'DEF')
  expect(fixed).toMatchObject({ workspace: { kind: 'lore', root: WS, place: 'game/code', base: 'main' }, lore: { remote: 'lores://lore.example.test:41337', repository: 'big-game', base: 'main' } })
  expect('lore' in fixed && fixed.lore?.branch.startsWith('eng/')).toBe(true)
  const none = fake([`${WS}/.lore`], { files: SETTINGS, loreBin: false })
  expect(await fixWorkspace(none.host, { id: 'DEF-4', source: 'DEF-4' }, candidate, PLACES[0]!, 'DEF')).toEqual({ error: 'No run was started. lore is not installed.' })
  const unread = fake([`${WS}/.lore`], { files: SETTINGS, loreOut: { exitCode: 1, out: 'boom\n' } })
  expect(await fixWorkspace(unread.host, { id: 'DEF-4', source: 'DEF-4' }, candidate, PLACES[0]!, 'DEF')).toEqual({ error: `No run was started. lore could not read the repository of ${WS}: boom` })
})

test('fixWorkspace keeps a folder that is already in place', async () => {
  const candidate = { kind: 'git' as const, root: `${HOME}/tools`, place: 'tools', about: '' }
  const place: Place = { ...PLACES[1]!, base: 'develop' }
  const world = fake([`${HOME}/tools/.git`], { files: SETTINGS })
  expect(await fixWorkspace(world.host, { id: 'ABC-1', source: 'ABC-1' }, candidate, place, 'ABC')).toEqual({
    workspace: { kind: 'git', root: `${HOME}/tools`, place: 'tools', base: 'develop' },
    config: { tickets: 'linear', linear: { team: 'ABC' } },
  })
})

test('pickWorkspace refuses an ambiguous workspace and lists the candidates', async () => {
  const world = fake([`${WS}/.lore`, `${CODE}/Tools/.lore`], { files: SETTINGS })
  const ledger = { run: { id: 'DEF-4', source: 'DEF-4', title: 'Run DEF-4', config: { places: PLACES } } }
  expect(await pickWorkspace(world.host, ledger as never, HOME, '/elsewhere')).toEqual({ error: `/elsewhere is not one of the workspaces this run lists: ${WS}, ${CODE}/Tools.` })
  expect(await pickWorkspace(world.host, ledger as never, HOME, '')).toEqual({ error: `That is not one of the workspaces this run lists: ${WS}, ${CODE}/Tools.` })
  const picked = await pickWorkspace(world.host, ledger as never, HOME, `${CODE}/Tools`)
  expect(picked).toMatchObject({ chosen: { root: `${CODE}/Tools` }, fixed: { workspace: { kind: 'lore', root: `${CODE}/Tools` } }, places: PLACES })
})
