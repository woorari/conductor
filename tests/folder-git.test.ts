import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { PLACEHOLDER_SNIPPET, placeConfig } from '../hooks/project'
import type { Ledger, Place } from '../types'
import { LEDGER, NOW } from './fixture'
import { FOLDER_CONFIG, GIT_WS, HOME_ROOT, composePrompt, folderLedgerPath, folderWorld, startAt } from './folder-world'
import { API, ORIGIN, board, ci, pull, spawn } from './world'
import type { Files, LoreAnswer, World } from './world'

type Ran = { text?: string; isError?: true; deny?: string }
const raise = ($: Engine, input: Record<string, unknown>) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const call = ($: Engine, tool: string, input: Record<string, unknown>) => raise($, { tool: `mcp__conductor__${tool}`, tool_use_id: `call-${tool}`, ...input })
const bash = ($: Engine, command: string, agentId?: string) =>
  raise($, { tool: 'Bash', tool_use_id: 'bash', command, description: 'A command', ...(agentId === undefined ? {} : { agentId }) })
const worktree = ($: Engine, name: string) => ($.classic as unknown as { WorktreeCreate: (e: { name: string }) => Promise<{ worktreePath?: string }> }).WorktreeCreate({ name })
const HEAD = 'b'.repeat(40)
const STUDIO = (FOLDER_CONFIG.places as Place[])[0]!
const gitRan = (engine: World): string[][] => engine.calls.filter(one => one.argv[0] === 'git').map(one => one.argv)
const git = (answer: LoreAnswer['answer'], ...words: string[]): LoreAnswer => ({ match: argv => argv[0] === 'git' && words.every((word, at) => argv[3 + at] === word), answer })

/** A git run of the folder home in the studio repository, bound: `ledger` given, else a run with two queued tasks and an approved plan. */
async function gitBound($: Engine, on: Parameters<typeof folderWorld>[0], more: { base?: string; ledger?: Ledger; run?: string } = {}) {
  mock.clock(on, { now: NOW })
  const run = more.run ?? 'ABC-12'
  const workspace = { kind: 'git' as const, root: GIT_WS, place: 'studio', base: more.base ?? 'main', remote: ORIGIN }
  const ledger: Ledger = more.ledger ?? {
    version: 1,
    run: { id: run, title: 'Retry', source: run, plan: 'approved', tickets: 'linear', startedAt: '2026-10-09T10:00:00.000Z', config: placeConfig(STUDIO, 'ABC'), workspace },
    tasks: [
      { id: 't1', title: 'Task t1', tier: 'sonnet', tierReason: 'a change', status: 'queued', files: ['src/a.ts'] },
      { id: 't2', title: 'Task t2', tier: 'sonnet', tierReason: 'a change', status: 'queued', files: ['src/b.ts'] },
    ],
    problems: [],
    posts: [],
    rulings: [],
  }
  const files: Files = {
    [folderLedgerPath(ledger.run.id)]: { text: JSON.stringify({ ...ledger, run: { ...ledger.run, workspace } }), mtimeMs: 1 },
    [`${HOME_ROOT}/.claude/settings.local.json`]: { text: PLACEHOLDER_SNIPPET, mtimeMs: 1 },
  }
  const engine = folderWorld(on, files)
  engine.programs.unshift(git({ exitCode: 0, stdout: '' }, 'fetch'), git({ exitCode: 0, stdout: 'Preparing worktree\n' }, 'worktree', 'add'), git({ exitCode: 0, stdout: '' }, 'worktree', 'remove'))
  await startAt($)
  await board($, ledger.run.id)

  return { engine, files }
}

test("owner and name come from the run's workspace", async ($, on) => {
  const { engine } = await gitBound($, on, { ledger: LEDGER })
  engine.forge.pulls[548] = pull(HEAD, { title: 'Daily cap thresholds', body: 'Two thresholds per UTC day.\n\nCloses #395' })
  engine.forge.checks[HEAD] = ci('success')
  const said = await call($, 'merge_check', { task: 't395-1', closes: [395] })
  expect(said.text?.startsWith('t395-1 may merge now.'), said.text).toBe(true)
  expect(engine.forge.asked.length).toBeGreaterThan(0)
  expect(engine.forge.asked.every(one => one.startsWith(`GET ${API}/`))).toBe(true)
  expect((await composePrompt($)).sections.map(one => one.text).join('\n')).toContain('mcp__conductor__merge takes a task only after everything it waits for is done')
})

test('a worker gets a worktree the mod made', async ($, on) => {
  const { engine } = await gitBound($, on)
  engine.worktree = { worktreePath: '/somewhere/else' }
  engine.agentIds.push('a1')
  await spawn($, 't1')
  const path = `${GIT_WS}.conductor/ABC-12/t1`
  expect(gitRan(engine)).toContainEqual(['git', '-C', GIT_WS, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
  expect(gitRan(engine)).toContainEqual(['git', '-C', GIT_WS, 'worktree', 'add', '-b', 'conductor/ABC-12/t1', path, 'refs/remotes/origin/main'])
  expect(await worktree($, 'agent-a1'), "the mod's own worktree, not the person's hook beneath").toEqual({ worktreePath: path })
})

test('a worktree that cannot be made says why', async ($, on) => {
  const { engine } = await gitBound($, on)
  engine.programs.unshift(git({ exitCode: 128, stdout: '', stderr: "fatal: a branch named 'conductor/ABC-12/t1' already exists" }, 'worktree', 'add'))
  engine.agentIds.push('a1')
  const started = (await spawn($, 't1')) as { deny?: string }
  expect(started.deny).toContain("fatal: a branch named 'conductor/ABC-12/t1' already exists")
  expect(engine.calls.some(one => one.argv[0] === 'rm'), 'nothing is removed').toBe(false)
})

test("a git worker without a worktree of its own cannot write in a folder home", async ($, on) => {
  const { engine } = await gitBound($, on)
  engine.agentIds.push('a1')
  await spawn($, 't1')
  expect((await bash($, 'touch x', 'a1')).deny).toContain('isolation: "worktree"')
  await worktree($, 'agent-a1')
  expect((await bash($, 'touch x', 'a1')).deny).toBeUndefined()
})

test("a done task's worktree is removed with git worktree remove", async ($, on) => {
  const path = `${GIT_WS}.conductor/demo/t395-1`
  const ledger: Ledger = { ...LEDGER, tasks: LEDGER.tasks.map(one => (one.id === 't395-1' ? { ...one, workspace: path } : one)) }
  const { engine } = await gitBound($, on, { ledger })
  engine.forge.pulls[548] = pull(HEAD, { title: 'Daily cap thresholds', body: 'Two thresholds per UTC day.\n\nCloses #395' })
  engine.forge.checks[HEAD] = ci('success')
  const said = await call($, 'merge', { task: 't395-1', told: ['Triage issues'], closes: [395] })
  expect(said.text?.startsWith('Merged: PR 548 (t395-1) is on main'), said.text).toBe(true)
  expect(gitRan(engine)).toContainEqual(['git', '-C', GIT_WS, 'worktree', 'remove', path])
})

test("a place's base is the run's base", async ($, on) => {
  const { engine } = await gitBound($, on, { base: 'master' })
  const denied = await bash($, 'git push origin master')
  expect(denied.deny).toContain('master')
  engine.agentIds.push('a1')
  await spawn($, 't1')
  expect(gitRan(engine)).toContainEqual(['git', '-C', GIT_WS, 'worktree', 'add', '-b', 'conductor/ABC-12/t1', `${GIT_WS}.conductor/ABC-12/t1`, 'refs/remotes/origin/master'])
})

test('a branch to build on that is no plain branch name reaches no git command', async ($, on) => {
  const ledger: Ledger = {
    version: 1,
    run: { id: 'ABC-12', title: 'Retry', source: 'ABC-12', plan: 'approved', tickets: 'linear', startedAt: '2026-10-09T10:00:00.000Z', config: placeConfig(STUDIO, 'ABC') },
    tasks: [
      { id: 't0', title: 'Task t0', tier: 'sonnet', tierReason: 'a change', status: 'green', files: ['src/z.ts'], pr: 5, branch: '--upload-pack=touch x' },
      { id: 't1', title: 'Task t1', tier: 'sonnet', tierReason: 'a change', status: 'queued', files: ['src/a.ts'], dependsOn: ['t0'] },
    ],
    problems: [],
    posts: [],
    rulings: [],
  }
  const { engine } = await gitBound($, on, { ledger })
  engine.agentIds.push('a1')
  const started = (await spawn($, 't1')) as { deny?: string }
  expect(started.deny).toContain('is no plain branch name')
  expect(gitRan(engine).filter(one => one[3] === 'fetch' || one[3] === 'worktree'), 'neither fetch nor worktree ran').toEqual([])
})

test("a push to the base by hand is refused when the repository's path holds spaces", async ($, on) => {
  await gitBound($, on)
  expect((await bash($, "git -C '/home/owner/work/Big Game 5.8' push origin main")).deny).toContain('pushes to main')
})
