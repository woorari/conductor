import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { PLACEHOLDER_SNIPPET } from '../hooks/project'
import { NOW } from './fixture'
import { HOME_ROOT, LORE_WS, composePrompt, folderLedgerPath, folderWorld, goodDay, loreRunIn, startAt } from './folder-world'
import { board, spawn } from './world'
import type { Files } from './world'

type Ran = { text?: string; isError?: true; deny?: string }
const raise = ($: Engine, input: Record<string, unknown>) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const bash = ($: Engine, command: string, agentId?: string) =>
  raise($, { tool: 'Bash', tool_use_id: 'bash', command, description: 'A command', ...(agentId === undefined ? {} : { agentId }) })
const worktree = ($: Engine, name: string) => ($.classic as unknown as { WorktreeCreate: (e: { name: string }) => Promise<{ worktreePath?: string }> }).WorktreeCreate({ name })
const TOOLS = `${HOME_ROOT}/game/code/Tools`

/** A session in the folder home, bound to a Lore run in `root` whose plan is approved. */
async function bound($: Engine, on: Parameters<typeof folderWorld>[0], more: { root?: string; files?: Files } = {}) {
  mock.clock(on, { now: NOW })
  const root = more.root ?? LORE_WS
  const files: Files = {
    [folderLedgerPath('DEF-4')]: { text: JSON.stringify(loreRunIn('DEF-4', root)), mtimeMs: 1 },
    [`${HOME_ROOT}/.claude/settings.local.json`]: { text: PLACEHOLDER_SNIPPET, mtimeMs: 1 },
    ...more.files,
  }
  const engine = folderWorld(on, files)
  if (root !== LORE_WS) engine.dirs.push(root, `${root}/.lore`)
  goodDay(engine, files, 'DEF-4', root)
  await startAt($)
  await board($, 'DEF-4')

  return { engine, files }
}

test("a worker's workspace is a copy of the run's workspace", async ($, on) => {
  const { engine } = await bound($, on)
  engine.agentIds.push('a1')
  await spawn($, 't1')
  const path = `${LORE_WS}.conductor/DEF-4/t1`
  const copies = engine.calls.filter(one => one.argv[0] === 'cp').map(one => one.argv)
  expect(copies).toEqual(['.lore', 'Source', 'Game.uproject'].map(entry => ['cp', '-c', '-R', `${LORE_WS}/${entry}`, `${path}/`]))
  expect(await worktree($, 'agent-a1')).toEqual({ worktreePath: path })
})

test("the orchestrator's lore commands are guarded against the run's workspace", async ($, on) => {
  const { engine } = await bound($, on)
  expect((await bash($, 'lore branch merge x')).deny, 'a lore write by hand').toBeDefined()
  expect((await bash($, 'lore status')).deny, 'a read').toBeUndefined()
  expect(engine.bash.at(-1)).toBe('lore status')
})

test("a worker's lore line is pinned to its own workspace", async ($, on) => {
  const { engine } = await bound($, on)
  engine.agentIds.push('a1')
  await spawn($, 't1')
  await worktree($, 'agent-a1')
  expect((await bash($, 'lore status', 'a1')).deny).toBeUndefined()
  expect(engine.bash.at(-1)).toBe(`cd -- '${LORE_WS}.conductor/DEF-4/t1' || exit 97\nlore status`)
})

test("the worker's brief comes from the home", async ($, on) => {
  const { engine } = await bound($, on, { files: { [`${HOME_ROOT}/.claude/conductor/brief.md`]: { text: 'Home rule: keep every name plain.\n', mtimeMs: 1 } } })
  engine.agentIds.push('a1')
  await spawn($, 't1')
  expect(engine.briefs.at(-1)).toContain('Home rule: keep every name plain.')
})

test('the orchestrator is told where the run works', async ($, on) => {
  await bound($, on)
  const text = (await composePrompt($)).sections.map(one => one.text).join('\n')
  expect(text).toContain(`- This run works in game/code/Big Game 5.8, a Lore workspace inside this home. Run its commands there: cd -- '${LORE_WS}' first.`)
})

test('binding another run moves the backend', async ($, on) => {
  const { engine, files } = await bound($, on)
  engine.dirs.push(TOOLS, `${TOOLS}/.lore`)
  files[folderLedgerPath('DEF-5')] = { text: JSON.stringify(loreRunIn('DEF-5', TOOLS)), mtimeMs: 1 }
  goodDay(engine, files, 'DEF-5', TOOLS)
  await board($, 'DEF-5')
  engine.agentIds.push('a1')
  await spawn($, 't1')
  const copies = engine.calls.filter(one => one.argv[0] === 'cp').map(one => one.argv[3])
  expect(copies.length).toBeGreaterThan(0)
  expect(copies.every(one => one?.startsWith(`${TOOLS}/`))).toBe(true)
})
