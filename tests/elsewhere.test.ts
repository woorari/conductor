import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { elsewhere, slugOf } from '../hooks/merge'
import type { Ledger, Task } from '../types'
import { LEDGER, NOW } from './fixture'
import { API, HOME, ORIGIN, OTHER_ORIGIN, board, ci, file, ledgerPath, mergeCommit, pull, spawn, start, world } from './world'
import type { Files } from './world'

/**
 * GitHub's side of the mod is for a repository on GitHub. In one whose
 * `origin` is elsewhere, a task's pull request number means nothing GitHub
 * could be asked about: so nothing there asks GitHub at all.
 */

const PATH = ledgerPath('demo')
const HEAD = 'b'.repeat(40)
const HALF_MINUTE = 30_000
const AT = '2026-10-09T10:30:00.000Z'
const stored = (files: Files): Ledger => JSON.parse(files[PATH]?.text ?? '{}') as Ledger
const task = (files: Files, id: string): Task => stored(files).tasks.find(one => one.id === id)!

type Ran = { text?: string; isError?: true; deny?: string }
const raise = ($: Engine, input: Record<string, unknown>) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const call = ($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) =>
  raise($, { tool: `mcp__conductor__${tool}`, tool_use_id: `call-${tool}`, ...input, ...(agentId === undefined ? {} : { agentId }) })
const bash = ($: Engine, command: string, agentId?: string) =>
  raise($, { tool: 'Bash', tool_use_id: 'bash', command, description: 'A command', ...(agentId === undefined ? {} : { agentId }) })
const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const compose = ($: Engine) =>
  $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })

/**
 * A session bound to the demo run in a repository with this `origin`. The
 * pretend GitHub has a pull request 548 all the same, open, mergeable and
 * green: what the green task t395-1 would be taken for.
 */
async function bound($: Engine, on: Parameters<typeof world>[0], origin: string | null, ledger: Ledger = LEDGER) {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(ledger, 1) }
  const engine = world(on, files)
  engine.origin = origin
  const { forge } = engine
  forge.pulls[548] = pull(HEAD, { title: 'Daily cap thresholds', body: 'Closes #395' })
  forge.checks[HEAD] = ci('success')
  await start($)
  await board($, 'demo')

  return { clock, files, engine, forge }
}
const MERGE = { task: 't395-1', told: [], closes: [395] }
const REFUSED = `Not done. ${elsewhere(OTHER_ORIGIN)}`

describe('which repository an origin names', () => {
  test('owner and name, however the remote is written', () => {
    expect(slugOf('git@gitlab.com:acme/widgets.git')).toBe('acme/widgets')
    expect(slugOf('https://gitlab.com/acme/widgets/')).toBe('acme/widgets')
    expect(slugOf('ssh://git@git.example.com:2222/acme/widgets.git')).toBe('acme/widgets')
    expect(slugOf('widgets'), 'no owner, no repository').toBeUndefined()
    expect(slugOf('')).toBeUndefined()
  })

  test('the refusal names the repository and the way a task is closed', () => {
    expect(elsewhere(OTHER_ORIGIN)).toBe(
      "This repository's origin is acme/widgets, which is not on GitHub, so the board reads no pull request and merges nothing here. A pull request is merged by this repository's own path, and its task is then done on the owner's word: /merged <task>.",
    )
  })
})

test('elsewhere merge_check and merge refuse before GitHub is asked, though it has an open, green pull request of that number', async ($, on) => {
  const { engine, files, forge } = await bound($, on, OTHER_ORIGIN)
  const before = files[PATH]?.mtimeMs

  expect((await call($, 'merge_check', { task: 't395-1', closes: [395] })).text).toBe(REFUSED)
  expect((await call($, 'merge', MERGE)).text).toBe(REFUSED)
  expect(forge.merges).toEqual([])
  expect(forge.asked, 'GitHub is not asked anything').toEqual([])
  expect(engine.processes, 'and gh is not asked for a token').toEqual([])
  expect(files[PATH]?.mtimeMs, 'the ledger is not written').toBe(before)
})

test('elsewhere a pull request of that number merged on GitHub is not taken for the task\'s: the task is not done', async ($, on) => {
  const { clock, files, forge } = await bound($, on, OTHER_ORIGIN)
  forge.pulls[548] = pull(HEAD, { state: 'closed', merged: true, merge_commit_sha: mergeCommit(548) })

  expect((await call($, 'merge', MERGE)).text).toBe(REFUSED)
  await clock.advance(HALF_MINUTE)
  expect(task(files, 't395-1').status).toBe('green')
  expect(task(files, 't395-1').mergeCommit).toBeUndefined()
  expect(forge.asked).toEqual([])
})

test('elsewhere nothing is watched: a claim and a base branch to look at are not asked of GitHub', async ($, on) => {
  const flying: Ledger = {
    ...LEDGER,
    merge: { task: 't395-1', pr: 548, head: HEAD, state: 'merging', startedAt: new Date(NOW - 10 * 60_000).toISOString() },
    main: { since: AT, commit: mergeCommit(548) },
  }
  const { clock, files, forge } = await bound($, on, OTHER_ORIGIN, flying)
  forge.pulls[548] = pull(HEAD, { state: 'closed', merged: true, merge_commit_sha: mergeCommit(548) })
  forge.checks[mergeCommit(548)] = ci('failure')

  for (let look = 0; look < 4; look += 1) await clock.advance(HALF_MINUTE)
  expect(forge.asked).toEqual([])
  expect(task(files, 't395-1').status).toBe('green')
  expect(stored(files).merge).toEqual(flying.merge)
  expect(stored(files).main).toEqual(flying.main)
})

test("elsewhere the orchestrator merges by the repository's own path, and a worker still never merges", async ($, on) => {
  const { engine } = await bound($, on, OTHER_ORIGIN)
  engine.agentIds.push('a1')
  await spawn($, 't392-1')
  const merge = 'curl -sS -X PUT "https://gitlab.com/api/v4/projects/7/merge_requests/105/merge"'

  expect((await bash($, 'gh pr merge 105', 'a1')).deny).toBe(
    "conductor: this command merges a pull request. A worker never merges and never pushes to main: set your task to review with its pull request and hand back. Merging is the orchestrator's.",
  )
  expect((await bash($, 'git push origin HEAD:main', 'a1')).deny).toContain('A worker never merges')
  expect(engine.ran.filter(one => one.tool === 'Bash'), 'neither ran').toEqual([])

  expect((await bash($, 'gh pr merge 105')).deny, 'the board merges nothing here, so this is no way round it').toBeUndefined()
  expect((await bash($, merge)).deny).toBeUndefined()
  expect(engine.ran.filter(one => one.tool === 'Bash')).toHaveLength(2)
})

test('elsewhere the orchestrator is told how a task is merged and closed there, and nothing of the merge tool', async ($, on) => {
  const { files } = await bound($, on, OTHER_ORIGIN)
  const told = (await compose($)).sections[1]?.text ?? ''

  expect(told).toContain("- This repository's origin is not on GitHub, so the mod reads no pull request and merges nothing here")
  expect(told).toContain("is merged by this repository's own path and rules, one at a time.")
  expect(told).toContain("becomes done on the owner's word alone: once it is merged and what this repository checks after a merge is good, tell the owner in one line to type /merged <task>.")
  expect(told).toContain('A task is merged only after everything it waits for is done, so merge in that order.')
  expect(told, 'not sent to the merge tool').not.toContain('becomes done through mcp__conductor__merge alone')
  expect(told).not.toContain('mcp__conductor__merge takes a task')

  const read = (await call($, 'board_read', {})).text ?? ''
  expect(read).toContain('- The board merges nothing in this repository, whose origin is not on GitHub.')
  expect(read).not.toContain('A green task is merged with mcp__conductor__merge')

  // The way a task with a pull request is closed there.
  expect((await call($, 'task_update', { task: 't395-1', status: 'done' })).text).toContain('The owner can also say so with /merged t395-1.')
  expect((await command($, 'merged', 't395-1')).text).toBe('t395-1 is done, by your word that its pull request is merged.')
  expect(task(files, 't395-1').status).toBe('done')
})

test('a repository with no origin is not known to be on GitHub: nothing is asked and nothing merged', async ($, on) => {
  const { forge } = await bound($, on, null)

  expect((await call($, 'merge', MERGE)).text).toBe(`Not done. ${elsewhere(null)}`)
  expect(forge.asked).toEqual([])
})

test('on GitHub nothing of this applies, whichever way the origin is written', async ($, on) => {
  const { forge } = await bound($, on, 'https://github.com/acme/widgets.git')
  const told = (await compose($)).sections[1]?.text ?? ''

  expect(ORIGIN).not.toBe('https://github.com/acme/widgets.git')
  expect(told).toContain('becomes done through mcp__conductor__merge alone')
  expect(told).toContain("merges into main pinned to that head with GitHub's merge method")
  expect(told).not.toContain('is not on GitHub')
  expect((await call($, 'board_read', {})).text).toContain('- A green task is merged with mcp__conductor__merge, one at a time;')
  expect((await bash($, `curl -sS -X PUT "${API}/pulls/548/merge"`)).deny).toMatch(/^conductor: this command merges a pull request by hand\./)
  expect((await call($, 'merge', MERGE)).text).toMatch(/^Merged: PR 548 \(t395-1\) is on main as /)
  expect(forge.merges).toEqual([{ pr: 548, body: { sha: HEAD, merge_method: 'merge' } }])
  expect(HOME).toBe('/home/owner')
})
