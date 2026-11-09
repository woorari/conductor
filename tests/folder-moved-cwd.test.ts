import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { PLACEHOLDER_SNIPPET } from '../hooks/project'
import type { Ledger } from '../types'
import { NOW } from './fixture'
import { HOME_ROOT, LORE_WS, composePrompt, folderLedgerPath, folderWorld, goodDay, loreRunIn, startAt } from './folder-world'
import { board, spawn } from './world'
import type { Files } from './world'

const RUN = 'COR-1'
const KEY = 'bound:session-1'
const PATH = folderLedgerPath(RUN)
const stored = (files: Files): Ledger => JSON.parse(files[PATH]?.text ?? '{}') as Ledger
const call = ($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ text?: string; isError?: true }>)({
    tool: `mcp__conductor__${tool}`,
    tool_use_id: `call-${tool}-${agentId ?? 'main'}`,
    ...input,
    ...(agentId === undefined ? {} : { agentId }),
  })

/**
 * A folder home with a Lore run whose plan is approved. The run's workspace
 * holds a `.claude/conductor` of its own, left from a time it was a home
 * itself, as a workspace that was once a repository home does: walking up
 * from inside it finds that one first.
 */
function folderRun(on: Parameters<typeof folderWorld>[0], cwd: string) {
  mock.clock(on, { now: NOW })
  const files: Files = {
    [PATH]: { text: JSON.stringify(loreRunIn(RUN)), mtimeMs: 1 },
    [`${HOME_ROOT}/.claude/settings.local.json`]: { text: PLACEHOLDER_SNIPPET, mtimeMs: 1 },
  }
  const engine = folderWorld(on, files, { cwd })
  engine.homes?.push(LORE_WS)
  goodDay(engine, files, RUN)

  return { engine, files }
}

/** Whatever the session's working directory, its run's tools, its router and its workers read and write the run's one ledger. */
async function findsItsLedger($: Engine, engine: ReturnType<typeof folderWorld>, files: Files): Promise<void> {
  expect((await call($, 'board_read', {})).text, 'the board tools read the ledger').toContain(`# Run ${RUN}: Retry`)
  expect((await call($, 'task_update', { task: 't2', note: 'read by the orchestrator' })).text).toBe('t2: note set.')

  engine.agentIds.push('a1')
  await spawn($, 't1')
  expect(engine.spawns.map(one => one.name), 'the router starts the worker').toEqual(['t1'])
  expect(stored(files).tasks.find(one => one.id === 't1')?.status).toBe('building')
  expect((await call($, 'task_update', { task: 't1', note: 'from the worker' }, 'a1')).text, 'the worker reaches the same ledger').toBe('t1: note set.')
  expect(stored(files).tasks.map(one => one.note)).toEqual(['from the worker', 'read by the orchestrator'])
  expect(Object.keys(files).filter(path => path.startsWith(`${LORE_WS}/.claude/`)), 'nothing of the run is written in the workspace').toEqual([])
}

test('binding a session in a folder home keeps the home with the run', async ($, on) => {
  const { engine } = folderRun(on, HOME_ROOT)
  await startAt($)
  await board($, RUN)
  expect(engine.store[KEY]).toEqual({ run: RUN, at: new Date(NOW).toISOString(), root: HOME_ROOT })
})

test('a bound session whose working directory moved into the run\'s Lore workspace still finds its ledger', async ($, on) => {
  const { engine, files } = folderRun(on, HOME_ROOT)
  await startAt($)
  await board($, RUN)

  // The orchestrator ran a bare cd into the workspace.
  engine.cwd = LORE_WS
  await findsItsLedger($, engine, files)
})

test('after a restart in the run\'s Lore workspace a session bound in the folder home finds its ledger', async ($, on) => {
  const { engine, files } = folderRun(on, LORE_WS)
  // What a restart leaves: the binding in the store, written when the session bound in the home; nothing else.
  engine.store[KEY] = { run: RUN, at: new Date(NOW - 40 * 60_000).toISOString(), root: HOME_ROOT }
  await startAt($, LORE_WS)

  expect((await board($)).text).toContain(`This session is bound to run ${RUN}.`)
  const prompt = (await composePrompt($)).sections.map(one => one.text).join('\n')
  expect(prompt, 'the home is still the folder, and the workspace one place in it').toContain('- This run works in game/code/Big Game 5.8, a Lore workspace inside this home.')
  await findsItsLedger($, engine, files)
})

test('a session bound before roots were kept, restarted in its home, keeps the home from then on', async ($, on) => {
  const { engine, files } = folderRun(on, HOME_ROOT)
  engine.store[KEY] = { run: RUN, at: new Date(NOW - 40 * 60_000).toISOString() }
  await startAt($)
  expect(engine.store[KEY]).toMatchObject({ run: RUN, root: HOME_ROOT })

  engine.cwd = LORE_WS
  await findsItsLedger($, engine, files)
})

test('an unbound session still finds its home from its working directory', async ($, on) => {
  const { engine } = folderRun(on, LORE_WS)
  await startAt($, LORE_WS)
  expect(engine.store[KEY]).toBeUndefined()
  expect((await board($)).text, 'the workspace that holds a .claude/conductor of its own is the home, as before').toBe('No run yet: nothing under .claude/conductor/runs.')
})
