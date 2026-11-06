import { expect, mock, test } from 'claude-code/testing'

import { PLACEHOLDER_SNIPPET, placeConfig } from '../hooks/project'
import type { Ledger, Place } from '../types'
import { NOW } from './fixture'
import { FOLDER_CONFIG, HOME_CONFIG, HOME_ROOT, LORE_WS, callTool, composePrompt, conductIn, folderLedgerPath, folderWorld, startAt } from './folder-world'
import type { Files, World } from './world'

const PLACES = FOLDER_CONFIG.places as Place[]
const TOOLS = `${HOME_ROOT}/game/code/Tools`
const PATH = folderLedgerPath('DEF-4')
const ledgerOf = (files: Files): Ledger => JSON.parse(files[PATH]?.text ?? '{}') as Ledger
const pick = ($: Parameters<typeof callTool>[0], path: string) => callTool($, { tool: 'mcp__conductor__run_workspace', tool_use_id: 'pick', path })

/** A run from DEF-4 in a home whose game/code holds two Lore workspaces: the orchestrator picks one. */
async function open($: Parameters<typeof startAt>[0], on: Parameters<typeof folderWorld>[0]): Promise<{ engine: World; files: Files }> {
  mock.clock(on, { now: NOW })
  const files: Files = { [`${HOME_ROOT}/.claude/settings.local.json`]: { text: PLACEHOLDER_SNIPPET, mtimeMs: 1 } }
  const engine = folderWorld(on, files)
  engine.dirs.push(TOOLS, `${TOOLS}/.lore`)
  engine.listings[`${HOME_ROOT}/game/code`] = [{ name: 'Big Game 5.8', kind: 'dir' }, { name: 'Tools', kind: 'dir' }]
  await startAt($)
  await conductIn($, 'DEF-4')

  return { engine, files }
}

test('run_plan waits for the pick', async ($, on) => {
  const { files } = await open($, on)
  const answer = await callTool($, { tool: 'mcp__conductor__run_plan', tool_use_id: 'plan', title: 'Retry' })
  expect(answer.text).toContain("Pick the run's workspace first: run_workspace takes one of the workspaces this run lists.")
  expect(ledgerOf(files).run.plan).toBe('draft')
})

test('run_workspace takes only a listed workspace', async ($, on) => {
  const { engine, files } = await open($, on)
  expect((await pick($, '/elsewhere')).text).toContain('/elsewhere is not one of the workspaces this run lists')
  engine.dirs.splice(engine.dirs.indexOf(`${TOOLS}/.lore`), 1)
  expect((await pick($, TOOLS)).text, 'a workspace that has gone').toContain(`${TOOLS} is not one of the workspaces this run lists`)
  expect(ledgerOf(files).run.workspace).toBeUndefined()

  const answer = await pick($, LORE_WS)
  expect(answer.isError).not.toBe(true)
  expect(answer.text).toContain('game/code/Big Game 5.8')
  const run = ledgerOf(files).run
  expect(run.workspace).toEqual({ kind: 'lore', root: LORE_WS, place: 'game/code', base: 'main' })
  expect(run.config, 'the place\'s settings, with the places frozen at /conduct kept for a new pick').toEqual({ ...placeConfig(PLACES[1]!, 'DEF'), places: [PLACES[1], PLACES[2]] })
  expect(run.lore?.repository).toBe('conductor-spike')
})

test('a folder put into Lore after /conduct counts', async ($, on) => {
  const { engine, files } = await open($, on)
  const extra = `${HOME_ROOT}/game/code/Extra`
  engine.dirs.push(extra, `${extra}/.lore`)
  engine.listings[`${HOME_ROOT}/game/code`] = [{ name: 'Big Game 5.8', kind: 'dir' }, { name: 'Tools', kind: 'dir' }, { name: 'Extra', kind: 'dir' }]
  await pick($, extra)
  expect(ledgerOf(files).run.workspace?.root).toBe(extra)
})

test('the pick may change until the plan is approved, then it is fixed', async ($, on) => {
  const { files } = await open($, on)
  await pick($, LORE_WS)
  await pick($, TOOLS)
  expect(ledgerOf(files).run.workspace?.root).toBe(TOOLS)
  const approved = ledgerOf(files)
  approved.run.plan = 'approved'
  files[PATH] = { text: JSON.stringify(approved), mtimeMs: (files[PATH]?.mtimeMs ?? 0) + 1 }
  expect((await pick($, LORE_WS)).text).toContain("This run's workspace is fixed: the plan naming it is approved.")
  expect(ledgerOf(files).run.workspace?.root).toBe(TOOLS)
})

test('the home config edited after /conduct does not move the pick', async ($, on) => {
  const { files } = await open($, on)
  files[HOME_CONFIG] = { text: JSON.stringify({ places: [PLACES[0]] }), mtimeMs: 5 }
  await pick($, LORE_WS)
  expect(ledgerOf(files).run.workspace?.root).toBe(LORE_WS)
})

test('the proposed plan names the workspace', async ($, on) => {
  await open($, on)
  await pick($, LORE_WS)
  await callTool($, { tool: 'mcp__conductor__task_add', tool_use_id: 'add', id: 't1', title: 'A task', tier: 'haiku', tierReason: 'small', files: ['Source/a.cpp'] })
  const answer = await callTool($, { tool: 'mcp__conductor__run_plan', tool_use_id: 'plan', title: 'Retry' })
  expect(answer.text).toContain('The plan is proposed')
  expect(answer.text).toContain('It works in game/code/Big Game 5.8.')
})

test('the orchestrator is told to pick first', async ($, on) => {
  await open($, on)
  const text = (await composePrompt($)).sections.map(one => one.text).join('\n')
  expect(text).toContain("This run's workspace is not picked yet.")
  expect(text).toContain(`${LORE_WS} (engine and game code)`)
  expect(text).toContain(`${TOOLS} (engine and game code)`)
  expect(text).toContain('If the work lies outside all of them, say so with mcp__conductor__board_post and propose no plan.')
})

test('a new pick after the plan is proposed sends the plan back to draft', async ($, on) => {
  const { files } = await open($, on)
  await pick($, LORE_WS)
  await callTool($, { tool: 'mcp__conductor__task_add', tool_use_id: 'add', id: 't1', title: 'A task', tier: 'haiku', tierReason: 'small', files: ['Source/a.cpp'] })
  await callTool($, { tool: 'mcp__conductor__run_plan', tool_use_id: 'plan', title: 'Retry' })
  expect(ledgerOf(files).run.plan).toBe('proposed')
  const answer = await pick($, TOOLS)
  expect(answer.text).toContain('The plan goes back to a draft: propose it again with run_plan, so the owner approves the plan for this workspace.')
  expect(ledgerOf(files).run.plan).toBe('draft')
  expect(ledgerOf(files).run.workspace?.root).toBe(TOOLS)
})

test("the guard follows a new pick: Lore writes are refused once the run works in a Lore workspace", async ($, on) => {
  const { engine } = await open($, on)
  const gitRoot = `${HOME_ROOT}/game/code/tools-git`
  engine.dirs.push(gitRoot, `${gitRoot}/.git`)
  engine.listings[`${HOME_ROOT}/game/code`] = [{ name: 'Big Game 5.8', kind: 'dir' }, { name: 'tools-git', kind: 'dir' }]
  const bash = (command: string) => callTool($, { tool: 'Bash', tool_use_id: 'bash', command, description: 'A command' }) as Promise<{ deny?: string }>
  await pick($, gitRoot)
  await bash('git status')
  await pick($, LORE_WS)
  expect((await bash('lore branch merge x')).deny, 'the guard reads the workspace picked last').toBeDefined()
})
