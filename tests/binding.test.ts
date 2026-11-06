import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { APPROVED } from '../hooks/plan'
import { BOUND_KEPT_DAYS, boundKey, isStale, kept } from '../hooks/store'
import type { Ledger, Merge } from '../types'
import { LEDGER, NOW } from './fixture'
import { board, file, ledgerPath, mergeCommit, pull, start, world } from './world'
import type { Files } from './world'

const PATH = ledgerPath('demo')
const KEY = 'bound:session-1'
const DAY = 24 * 60 * 60_000
const stored = (files: Files): Ledger => JSON.parse(files[PATH]?.text ?? '{}') as Ledger
const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const call = ($: Engine, tool: string, input: Record<string, unknown>) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ text?: string }>)({ tool: `mcp__conductor__${tool}`, tool_use_id: `call-${tool}`, ...input })

describe('what the store keeps of a binding', () => {
  test('a run under the session\'s id, and anything else found there is no binding', () => {
    expect(boundKey('3ec754b5')).toBe('bound:3ec754b5')
    expect(kept({ run: 'Nightly', at: '2026-10-09T08:52:31.025Z' })).toEqual({ run: 'Nightly', at: '2026-10-09T08:52:31.025Z' })
    expect(kept({ run: 'Nightly' })).toEqual({ run: 'Nightly' })
    for (const other of [undefined, null, 'Nightly', 7, [], {}, { run: 7 }, { run: '../x' }, { run: '' }]) {
      expect(kept(other), JSON.stringify(other)).toBeUndefined()
    }
  })

  test('one is old after thirty days, or when it does not say when it was made', () => {
    const at = (daysAgo: number) => ({ run: 'demo', at: new Date(NOW - daysAgo * DAY).toISOString() })
    expect(BOUND_KEPT_DAYS).toBe(30)
    expect([isStale(at(29), NOW), isStale(at(31), NOW)]).toEqual([false, true])
    expect(isStale({ run: 'demo' }, NOW)).toBe(true)
    expect(isStale('nonsense', NOW)).toBe(true)
  })
})

test('binding a session writes it down under the session\'s id; letting go removes it', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = world(on, { [PATH]: file(LEDGER, 1) })
  await start($)
  expect(engine.store, 'a bare /board only views').toEqual({})
  await board($)
  expect(engine.store).toEqual({})

  await board($, 'demo')
  expect(engine.store).toEqual({ [KEY]: { run: 'demo', at: new Date(NOW).toISOString() } })
  await board($, 'none')
  expect(engine.store).toEqual({})

  await command($, 'conduct', '#334')
  expect(engine.store[KEY]).toMatchObject({ run: '334' })
})

test('after a restart the session is bound to its run again, and /approve works', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const proposed: Ledger = { ...LEDGER, run: { ...LEDGER.run, plan: 'proposed' } }
  const files: Files = { [PATH]: file(proposed, 1) }
  const engine = world(on, files)
  // What a restart leaves: the store still has the binding, the session's own state is empty.
  engine.store[KEY] = { run: 'demo', at: new Date(NOW - 40 * 60_000).toISOString() }
  await start($)

  expect((await command($, 'approve')).text).toBe('Plan approved: 9 tasks may start.')
  expect(stored(files).run.plan).toBe('approved')
  await clock.advance(5000)
  expect(engine.woke, 'and the orchestrator is told to start the workers').toEqual([APPROVED])
  expect((await call($, 'board_read', {})).text, 'the tools write the board again').toContain('# Run demo: Nightly import speed')
  expect((await board($)).text, 'a bare /board says so').toContain('This session is bound to run demo.')
})

test('a merge claim is settled again after a restart', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const commit = mergeCommit(548)
  const head = 'b'.repeat(40)
  const flight: Merge = { task: 't395-1', pr: 548, head, state: 'merging', startedAt: new Date(NOW - 5 * 60_000).toISOString() }
  const files: Files = { [PATH]: file({ ...LEDGER, merge: flight }, 1) }
  const engine = world(on, files)
  engine.forge.pulls[548] = pull(head, { state: 'closed', merged: true, merge_commit_sha: commit })
  engine.store[KEY] = { run: 'demo', at: new Date(NOW - 60 * 60_000).toISOString() }
  await start($)

  await clock.advance(30_000)
  expect(stored(files).merge, 'settled').toBeUndefined()
  expect(stored(files).tasks.find(one => one.id === 't395-1')?.status).toBe('done')
})

test('a session nobody bound stays unbound, and its commands say which run to bind', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file({ ...LEDGER, run: { ...LEDGER.run, plan: 'proposed' } }, 1) }
  const engine = world(on, files)
  engine.store['bound:another-session'] = { run: 'demo', at: new Date(NOW).toISOString() }
  await start($)

  const told = 'This session is bound to no run; it only views demo. /board demo binds it: then give this command again.'
  expect((await command($, 'approve')).text).toBe(told)
  expect((await command($, 'merged', 't395-1')).text).toBe(told)
  expect((await command($, 'tier', 't392-1 opus')).text).toBe(told)
  expect(stored(files).run.plan, 'nothing was approved').toBe('proposed')
  expect(engine.store[KEY]).toBeUndefined()
})

test('in a repository with no run the command says only how to bind', async ($, on) => {
  mock.clock(on, { now: NOW })
  world(on, {})
  await start($)
  expect((await command($, 'approve')).text).toBe('This session is bound to no run: /board <run id> binds it.')
})

test('a kept run whose ledger is gone is forgotten, not bound to', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = world(on, { [PATH]: file(LEDGER, 1) })
  engine.store[KEY] = { run: 'gone', at: new Date(NOW).toISOString() }
  await start($)
  expect(engine.store).toEqual({})
  expect((await command($, 'approve')).text).toContain('bound to no run; it only views demo')
})

test('a session bound before bindings were kept is written down the next time the mod starts', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = world(on, { [PATH]: file(LEDGER, 1) })
  await start($)
  await board($, 'demo')
  delete engine.store[KEY]

  // A hot reload of the mod: it starts again, and the session's state is still there.
  await start($)
  expect(engine.store[KEY]).toMatchObject({ run: 'demo' })
  expect((await board($)).text).toContain('This session is bound to run demo.')
})

test('binding drops other sessions\' bindings that are old, and nothing else in the store', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = world(on, { [PATH]: file(LEDGER, 1) })
  const at = (daysAgo: number) => ({ run: 'demo', at: new Date(NOW - daysAgo * DAY).toISOString() })
  Object.assign(engine.store, { 'bound:old': at(40), 'bound:recent': at(2), 'bound:undated': { run: 'demo' }, settings: { theme: 'dark' } })
  await start($)
  expect(Object.keys(engine.store), 'starting drops nothing').toHaveLength(4)

  await board($, 'demo')
  expect(Object.keys(engine.store).sort()).toEqual(['bound:recent', KEY, 'settings'].sort())
})

test('a store that cannot be written leaves the session bound for as long as it lives', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = world(on, { [PATH]: file(LEDGER, 1) })
  engine.isStoreFull = true
  await start($)
  expect((await board($, 'demo')).text).toContain('This session is bound to run demo.')
  expect(engine.store).toEqual({})
  expect((await call($, 'board_read', {})).text).toContain('# Run demo')
})
