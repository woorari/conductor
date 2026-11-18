import { expect, test } from 'claude-code/testing'

import { landBase, landTask, prepareWorkspace } from '../hooks/lore-steps'
import type { LoreHost, Making } from '../hooks/lore-steps'
import { BRANCH_INFO_NEW, BRANCH_INFO_PUSHED, MERGE_CLEAN, MERGE_CONFLICT, MERGE_INTO_DONE, MERGE_INTO_PROTECTED, PROTECTED, PUSH_FIRST, PUSH_RUN, REV_MAIN, REV_ON_MAIN, REV_RUN, REV_T1, REV_T2, STATUS_CLEAN, UNPROTECTED } from './lore-output'

type Said = { exitCode?: number; out?: string }

/**
 * A host that answers `lore` from a table (the first row whose words start the
 * arguments) and records every call in order: `lore ...` for the CLI, the
 * method name for the rest.
 */
function recording(table: readonly [string, Said | (() => Said)][], more: Partial<LoreHost> = {}) {
  const calls: string[] = []
  const argv: string[] = []
  const note = (name: string): void => void calls.push(name)
  const host: LoreHost = {
    async lore(args, cwd) {
      const line = args.join(' ')
      argv.push(line)
      calls.push(`lore ${line}`)
      const row = table.find(([start]) => line === start || line.startsWith(`${start} `))
      const said = row === undefined ? {} : typeof row[1] === 'function' ? row[1]() : row[1]

      return { exitCode: said.exitCode ?? 0, out: said.out ?? '', err: '' }
    },
    freeGb: async () => (note('freeGb'), 100),
    removeFiles: async paths => note(`removeFiles ${paths.join(',')}`),
    sameDisk: async () => (note('sameDisk'), true),
    copyTree: async (_from, _to, entries) => void note(`copyTree ${entries.join(',')}`),
    mkdir: async () => note('mkdir'),
    remove: async path => note(`remove ${path}`),
    removeMany: async paths => note(`removeMany ${paths.join(',')}`),
    exists: async () => (note('exists'), false),
    mark: async path => note(`mark ${path}`),
    readText: async () => '/Saved/\n**/Intermediate/\n',
    listDir: async () => [
      { name: 'Source', isDir: true },
      { name: 'Saved', isDir: true },
      { name: '_deleted', isDir: true },
      { name: 'game.cfg', isDir: false },
    ],
    listTree: async () => `${MAKING.path}/Source/\n${MAKING.path}/Source/Intermediate/\n${MAKING.path}/Source/a.cpp\n`,
    ...more,
  }

  return { host, calls, argv }
}

const MAKING: Making = {
  home: '/work/game-code',
  root: '/work/game-code',
  base: '/work/game-code.conductor',
  path: '/work/game-code.conductor/ENG-1/lead-a',
  branch: 'conductor/ENG-1/lead-a',
  from: 'main',
  carry: [],
  minFreeGB: 20,
  runId: 'ENG-1',
  taskId: 'lead-a',
}

test('prepareWorkspace refuses a path outside base or inside root', async () => {
  const outside = recording([])
  const said = await prepareWorkspace(outside.host, { ...MAKING, path: '/elsewhere/lead-a' })
  expect(said.error).toContain('no place for a workspace')
  const inside = recording([])
  expect((await prepareWorkspace(inside.host, { ...MAKING, base: '/work/game-code/ws', path: '/work/game-code/ws/lead-a' })).error).toContain('no place for a workspace')
  expect(outside.calls).toEqual([])
  expect(inside.calls).toEqual([])
})

test('prepareWorkspace refuses below the disk floor', async () => {
  const { host, calls } = recording([], { freeGb: async () => 5 })
  const said = await prepareWorkspace(host, MAKING)
  expect(said.error).toContain('only 5 GB are free')
  expect(said.error).toContain('at least 20 GB')
  expect(calls.some(call => call.startsWith('copyTree'))).toBe(false)
  expect(calls.some(call => call.startsWith('lore '))).toBe(false)
  // The half-made folder is taken away again.
  expect(calls.at(-1)).toBe(`remove ${MAKING.path}`)
})

test('prepareWorkspace says why the free disk could not be read, as the host says it', async () => {
  const { host, calls } = recording([], {
    freeGb: async () => {
      throw new Error('df did not say how much disk is free: no such device')
    },
  })
  const said = await prepareWorkspace(host, MAKING)
  expect(said.error).toBe('df did not say how much disk is free: no such device')
  expect(calls.some(call => call.startsWith('copyTree'))).toBe(false)
  expect(calls.at(-1)).toBe(`remove ${MAKING.path}`)
})

test('prepareWorkspace removes the copy\'s untracked entries as files only', async () => {
  const { host, calls } = recording([
    ['status --scan', { out: STATUS_CLEAN.replace('No tracked changes', 'Untracked files:\nA stray.txt\nTracked changes: 1 added') }],
    ['branch info conductor/ENG-1/lead-a', { out: BRANCH_INFO_PUSHED }],
  ])
  expect((await prepareWorkspace(host, MAKING)).error).toBeUndefined()
  expect(calls).toContain(`removeFiles ${MAKING.path}/stray.txt`)
  // The folders the ignore rules take out are the only recursive removal.
  expect(calls.filter(call => call.startsWith('removeMany'))).toEqual([`removeMany ${MAKING.path}/Source/Intermediate`])
})

test('prepareWorkspace copies the seed then switches and creates the task branch', async () => {
  const { host, calls, argv } = recording([
    ['status --scan', { out: STATUS_CLEAN }],
    ['branch info conductor/ENG-1/lead-a', { out: BRANCH_INFO_NEW }],
    ['push', { out: PUSH_FIRST }],
  ])
  const said = await prepareWorkspace(host, MAKING)
  expect(said.error).toBeUndefined()
  expect(argv).toEqual(['repository update-path', 'status --scan', 'branch switch main --reset', 'branch info conductor/ENG-1/lead-a', 'branch create conductor/ENG-1/lead-a', 'push'])
  // The copy takes what is not ignored, never the mod's own _deleted, then comes what the ignore rules take out again.
  expect(calls.filter(call => !call.startsWith('lore '))).toEqual([
    'exists',
    'mkdir',
    'sameDisk',
    'freeGb',
    'copyTree Source,game.cfg',
    `removeMany ${MAKING.path}/Source/Intermediate`,
    `mark /work/game-code/.claude/conductor/runs/ENG-1/ready-lead-a`,
  ])
  expect(calls.indexOf('copyTree Source,game.cfg')).toBeLessThan(calls.indexOf('lore repository update-path'))
})

test('prepareWorkspace goes on from a task branch that was pushed before', async () => {
  const { argv } = await (async () => {
    const world = recording([
      ['status --scan', { out: STATUS_CLEAN }],
      ['branch info conductor/ENG-1/lead-a', { out: BRANCH_INFO_PUSHED }],
    ])
    await prepareWorkspace(world.host, MAKING)

    return world
  })()
  expect(argv.slice(-2)).toEqual(['branch info conductor/ENG-1/lead-a', 'branch switch conductor/ENG-1/lead-a --reset'])
})

const TASK = {
  runWorkspace: '/work/game-code.conductor/ENG-1/_run',
  runBranch: 'conductor/ENG-1',
  taskBranch: 'conductor/ENG-1/lead-a',
  revision: REV_T1,
  runHead: REV_MAIN,
  message: 'lead-a: Make it',
}
const RUN_INFO = `Branch conductor/ENG-1\n  ID: 01a1b056f6bb701783e7a1beb2aa49a0\n  Latest: ${REV_MAIN}\n  Remote Latest: ${REV_MAIN}\n`

test('landTask aborts on conflict', async () => {
  const { host, argv } = recording([
    ['branch info conductor/ENG-1', { out: RUN_INFO }],
    ['branch merge conductor/ENG-1/lead-a', { out: MERGE_CONFLICT }],
  ])
  const said = await landTask(host, TASK)
  expect(said.conflict).toBe('a.txt')
  expect(said.landed).toBeUndefined()
  expect(argv).toEqual(['branch switch conductor/ENG-1 --reset', 'branch info conductor/ENG-1', 'branch merge conductor/ENG-1/lead-a --message=lead-a: Make it', 'branch merge abort'])
})

test('landTask resets a wrong revision and pushes nothing', async () => {
  // Lore took in the task's latest, which is not the revision that was judged.
  const wrong = MERGE_CLEAN.replace(REV_T1, REV_T2)
  const { host, argv } = recording([
    ['branch info conductor/ENG-1', { out: RUN_INFO }],
    ['branch merge conductor/ENG-1/lead-a', { out: wrong }],
  ])
  const said = await landTask(host, TASK)
  expect(said.error).toContain('not the judged')
  expect(argv).toEqual([
    'branch switch conductor/ENG-1 --reset',
    'branch info conductor/ENG-1',
    'branch merge conductor/ENG-1/lead-a --message=lead-a: Make it',
    `branch reset ${REV_MAIN} --branch conductor/ENG-1`,
    'branch switch conductor/ENG-1 --reset',
  ])
})

test('landTask pushes, lets the locks go and answers the pushed revision', async () => {
  const { host, argv } = recording([
    ['branch info conductor/ENG-1', { out: RUN_INFO }],
    ['branch merge conductor/ENG-1/lead-a', { out: MERGE_CLEAN }],
    ['push', { out: PUSH_RUN }],
  ])
  const said = await landTask(host, TASK)
  expect(said).toEqual({ landed: REV_RUN })
  expect(argv.slice(-2)).toEqual(['push', 'lock release --branch conductor/ENG-1/lead-a'])
})

const BASE = {
  runWorkspace: '/work/game-code.conductor/ENG-1/_run',
  runBranch: 'conductor/ENG-1',
  base: 'main',
  baseAt: REV_ON_MAIN,
  revision: REV_RUN,
  message: 'Run ENG-1: Make it',
}
const MAIN_INFO = `Branch main\n  ID: e726318bbc3fd75ac8733a7e030cc35b\n  Latest: ${REV_ON_MAIN}\n  Remote Latest: ${REV_ON_MAIN}\n`
const AT_RUN = STATUS_CLEAN.replace(REV_T1, REV_RUN)

test('landBase re-protects when the merge fails', async () => {
  const { host, argv } = recording([
    ['status', { out: AT_RUN }],
    ['branch unprotect main', { out: UNPROTECTED }],
    ['branch info main', { out: MAIN_INFO }],
    ['branch merge into', { exitCode: 1, out: MERGE_INTO_PROTECTED }],
    ['branch protect main', { out: PROTECTED }],
  ])
  const said = await landBase(host, BASE)
  expect(said.landed).toBeUndefined()
  expect(said.error).toContain('Not authorized')
  expect(said.unprotected).toBeUndefined()
  expect(argv).toEqual(['branch switch conductor/ENG-1 --reset', 'status', 'branch unprotect main', 'branch info main', 'branch merge into main Run ENG-1: Make it', 'branch protect main'])
})

test('landBase lands and protects again', async () => {
  const { host, argv } = recording([
    ['status', { out: AT_RUN }],
    ['branch unprotect main', { out: UNPROTECTED }],
    ['branch info main', { out: MAIN_INFO }],
    ['branch merge into', { out: MERGE_INTO_DONE }],
    ['branch protect main', { out: PROTECTED }],
  ])
  expect(await landBase(host, BASE)).toEqual({ landed: REV_ON_MAIN })
  expect(argv.at(-1)).toBe('branch protect main')
})

test('landBase reports unprotected when protect fails', async () => {
  const { host } = recording([
    ['status', { out: AT_RUN }],
    ['branch unprotect main', { out: UNPROTECTED }],
    ['branch info main', { out: MAIN_INFO }],
    ['branch merge into', { out: MERGE_INTO_DONE }],
    ['branch protect main', { exitCode: 1, out: '[Error] Not authorized to access repository' }],
  ])
  const said = await landBase(host, BASE)
  expect(said.landed).toBe(REV_ON_MAIN)
  expect(said.unprotected).toBe(true)
  expect(said.protectError).toContain('Not authorized')
})

test('landBase gives up before touching protection when the run branch moved after the approval', async () => {
  const { host, argv } = recording([['status', { out: STATUS_CLEAN }]])
  const said = await landBase(host, BASE)
  expect(said.error).toContain('moved after the approval')
  expect(argv).toEqual(['branch switch conductor/ENG-1 --reset', 'status'])
})
