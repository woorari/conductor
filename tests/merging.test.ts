import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Ledger, Merge, Task } from '../types'
import { LEDGER, NOW } from './fixture'
import { API, MAIN, TOKEN, board, ci, file, ledgerPath, mergeCommit, pull, spawn, start, world } from './world'
import type { Files } from './world'

const PATH = ledgerPath('demo')
const HEAD = 'b'.repeat(40)
const COMMIT = mergeCommit(548)
const HALF_MINUTE = 30_000
const stored = (files: Files): Ledger => JSON.parse(files[PATH]?.text ?? '{}') as Ledger
const task = (files: Files, id: string): Task => stored(files).tasks.find(one => one.id === id)!

type Ran = { text?: string; isError?: true; deny?: string; context?: readonly string[] }
const raise = ($: Engine, input: Record<string, unknown>) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const call = ($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) =>
  raise($, { tool: `mcp__conductor__${tool}`, tool_use_id: `call-${tool}`, ...input, ...(agentId === undefined ? {} : { agentId }) })
const bash = ($: Engine, command: string, agentId?: string) =>
  raise($, { tool: 'Bash', tool_use_id: 'bash', command, description: 'A command', ...(agentId === undefined ? {} : { agentId }) })
const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

/** A session bound to the demo run, whose green task t395-1 has PR 548 open, mergeable and green, on a main that is green. */
async function bound($: Engine, on: Parameters<typeof world>[0], ledger: Ledger = LEDGER, isBound = true) {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(ledger, 1) }
  const engine = world(on, files)
  const { forge } = engine
  forge.pulls[548] = pull(HEAD, { title: 'Daily cap thresholds', body: 'Two thresholds per UTC day.\n\nCloses #395' })
  forge.checks[HEAD] = ci('success')
  await start($)
  if (isBound) await board($, 'demo')

  return { clock, files, engine, forge }
}
const MERGE = { task: 't395-1', told: ['Triage issues'], closes: [395] }

test('merge_check reads GitHub and says what stands in the way; it merges nothing and writes nothing', async ($, on) => {
  const { files, forge } = await bound($, on)
  const before = files[PATH]?.mtimeMs

  expect((await call($, 'merge_check', { task: 't395-1', closes: [395] })).text).toBe(
    't395-1 may merge now. PR 548 is open and mergeable into main, its checks are green on bbbbbbb (build=success, test=success), the checks on main are green for aaaaaaa, and it closes #395. GitHub would merge it with its merge method. Before you call mcp__conductor__merge: tell the other sessions that may merge (ListAgents shows them) and name them in told.',
  )

  forge.checks[HEAD] = ci(null)
  forge.pulls[548]!.mergeable_state = 'blocked'
  expect((await call($, 'merge_check', { task: 't395-1' })).text).toBe(
    [
      't395-1 cannot merge yet:',
      "- GitHub's branch protection blocks PR 548: a required review or a required check is missing.",
      "- PR 548's checks have no verdict yet on bbbbbbb (build=in_progress, test=in_progress).",
      "- PR 548's description would close #395, which this merge was not said to close. Pass closes: [395] if that is meant; otherwise have the wording changed.",
    ].join('\n'),
  )
  expect(forge.merges, 'no merge call').toEqual([])
  expect(forge.asked.every(one => one.startsWith(`GET ${API}/`)), "only reads, and only of this repository's").toBe(true)
  expect(files[PATH]?.mtimeMs, 'the ledger is not written').toBe(before)
})

test('a merge is pinned to the graded head, and the task is done once GitHub has merged it', async ($, on) => {
  const { files, engine, forge } = await bound($, on)

  const said = await call($, 'merge', MERGE)
  expect(said.text).toBe(
    `Merged: PR 548 (t395-1) is on main as ${COMMIT.slice(0, 7)}, and the task is done. Go on at once: start what can start and merge the next green task. The board watches the checks on main and says so if they fail.`,
  )
  expect(forge.merges, 'one call, pinned to the head whose checks were read').toEqual([{ pr: 548, body: { sha: HEAD, merge_method: 'merge' } }])
  expect(stored(files).merge, 'settled').toBeUndefined()
  expect(task(files, 't395-1')).toMatchObject({ status: 'done', mergeCommit: COMMIT })
  expect(stored(files).main).toMatchObject({ commit: COMMIT })
  expect(JSON.stringify(files), 'the token is written nowhere').not.toContain(TOKEN)
  expect(JSON.stringify([said, engine.woke, engine.toasts]), 'and said nowhere').not.toContain(TOKEN)

  // The way is free for the next one.
  forge.pulls[547] = pull('d'.repeat(40))
  await call($, 'task_update', { task: 't393-1', status: 'green' })
  expect((await call($, 'merge_check', { task: 't393-1' })).text).toMatch(/^t393-1 cannot merge yet:\n- PR 547's checks have no verdict yet on ddddddd \(no checks yet\)/)
})

test('a task made done by its merge says which problem waited for it', async ($, on) => {
  await bound($, on)
  expect((await call($, 'problem_assign', { problem: 'P2', task: 't395-1' })).text).toBe('P2 is addressed by t395-1 (green, ticket #395).')
  expect((await call($, 'merge', MERGE)).text).toMatch(/and says so if they fail\. P2 was waiting for it\.$/)
})

test('a problem found under a task is looked at again before the task merges: it still holds and has a task, or it does not and is resolved', async ($, on) => {
  const found = '2026-10-09T09:00:00Z'
  const ledger: Ledger = {
    ...LEDGER,
    problems: [
      ...LEDGER.problems,
      { id: 'P4', text: 'The cap thresholds are not rounded', severity: 'warning', status: 'open', taskId: 't395-1', foundAt: found },
      { id: 'P5', text: 'The day boundary is read in local time', severity: 'warning', status: 'open', taskId: 't395-1', foundAt: found },
    ],
  }
  const { files, forge } = await bound($, on, ledger)

  const checked = (await call($, 'merge_check', { task: 't395-1', closes: [395] })).text ?? ''
  expect(checked).toContain('t395-1 cannot merge yet:')
  expect(checked).toContain('- P4 (warning: "The cap thresholds are not rounded") was found under t395-1 and no task deals with it: check that it still holds.')
  expect(checked).toContain('- P5 (warning: "The day boundary is read in local time") was found under t395-1')
  expect((await call($, 'merge', MERGE)).text).toMatch(/^Not done\. Nothing was merged\. t395-1 cannot merge now:\n- P4 /)
  expect(forge.merges, 'nothing reached GitHub').toEqual([])
  expect(task(files, 't395-1').status).toBe('green')

  // P4 is no problem any more: resolved. P5 still is: it gets a task of its own, and the merge may go on.
  expect((await call($, 'problem_resolve', { problem: 'P4', resolution: 'rounded already: the report read an old build' })).text).toBe('P4 resolved.')
  expect((await call($, 'merge_check', { task: 't395-1', closes: [395] })).text, 'one is left').toContain('- P5 (warning')
  const added = await call($, 'task_add', {
    id: 'fix-day',
    title: 'Read the day boundary in UTC',
    tier: 'haiku',
    tierReason: 'one line',
    files: ['src/caps.ts'],
    addresses: ['P5'],
  })
  expect(added.text).toContain('It addresses P5.')
  expect((await call($, 'merge_check', { task: 't395-1', closes: [395] })).text).toMatch(/^t395-1 may merge now\./)
  expect((await call($, 'merge', MERGE)).text).toMatch(/^Merged: PR 548 \(t395-1\)/)
  expect(forge.merges).toHaveLength(1)
})

test('a pull request merged by hand is taken over: no merge call, and the task is done', async ($, on) => {
  const { files, forge } = await bound($, on)
  const outside = 'e'.repeat(40)
  forge.pulls[548] = pull(HEAD, { state: 'closed', merged: true, merge_commit_sha: outside })

  expect((await call($, 'merge_check', { task: 't395-1' })).text).toBe(
    'PR 548 is merged already as eeeeeee, outside the board. mcp__conductor__merge takes it over and marks t395-1 done.',
  )
  expect((await call($, 'merge', MERGE)).text).toMatch(/^Taken over: PR 548 \(t395-1\) is on main as eeeeeee, and the task is done\./)
  expect(forge.merges).toEqual([])
  expect(task(files, 't395-1')).toMatchObject({ status: 'done', mergeCommit: outside })
})

test('nothing merges on checks that are not green, for a task not judged green, or from a worker; checks still running on main hold nothing', async ($, on) => {
  const { files, forge } = await bound($, on)

  forge.checks[HEAD] = [...ci('success', ['build']), ...ci('failure', ['test'])]
  expect((await call($, 'merge', MERGE)).text).toContain("- PR 548's checks failed on bbbbbbb: test.")

  forge.pulls[547] = pull('d'.repeat(40))
  forge.checks['d'.repeat(40)] = ci('success')
  expect((await call($, 'merge', { task: 't393-1', told: [] })).text).toContain('- t393-1 is review: only a task you judged green')

  expect((await call($, 'merge', MERGE, 'a-worker')).text).toMatch(/^Not done\. Only the orchestrator merges\./)
  expect(forge.merges, 'no merge call reached GitHub').toEqual([])
  expect(stored(files).merge).toBeUndefined()

  forge.checks[HEAD] = ci('success')
  forge.checks[MAIN] = ci(null)
  expect((await call($, 'merge', MERGE)).text, 'checks still going on main hold nothing').toMatch(/^Merged: PR 548/)
})

test('a head that moved after it was graded is refused by GitHub, and the claim is let go', async ($, on) => {
  const { files, forge } = await bound($, on)
  forge.onMerge = 409

  expect((await call($, 'merge', MERGE)).text).toBe(
    'Not done. Nothing was merged: GitHub did not merge PR 548 (HTTP 409: Head branch was modified. Review and try the merge again.). The claim is let go and t395-1 stands where it stood. If its head moved, have it graded again.',
  )
  expect(stored(files).merge).toBeUndefined()
  expect(task(files, 't395-1').status).toBe('green')
  forge.onMerge = 'merge'
  expect((await call($, 'merge', MERGE)).text, 'and it can be tried again').toMatch(/^Merged: PR 548/)
})

test('GitHub that cannot be asked, or no token anywhere, is no verdict: nothing is merged and nothing claimed', async ($, on) => {
  const { engine, files, forge } = await bound($, on)
  forge.isDown = true
  expect((await call($, 'merge', MERGE)).text).toMatch(
    /^Not done\. GitHub did not say what a merge needs to know \(.*getaddrinfo ENOTFOUND api\.github\.com\)\. Nothing was merged\. A request that failed is no verdict: try again\.$/,
  )
  forge.isDown = false
  engine.env = {}
  expect((await call($, 'merge', MERGE)).text).toContain(
    "there is no GitHub token: set the mod's GitHub token option, export GH_TOKEN or GITHUB_TOKEN, or sign in with gh auth login",
  )
  expect(engine.processes.filter(argv => argv[0] === 'gh'), 'gh was asked for its token').toContainEqual(['gh', 'auth', 'token'])
  expect(forge.merges).toEqual([])
  expect(stored(files).merge).toBeUndefined()
})

test('without the option or GH_TOKEN, the token is GITHUB_TOKEN, then gh auth token, asked again once GitHub refuses it', async ($, on) => {
  const { engine, forge } = await bound($, on)
  engine.env = { GITHUB_TOKEN: TOKEN }
  expect((await call($, 'merge_check', { task: 't395-1', closes: [395] })).text).toMatch(/^t395-1 may merge now\./)
  expect(engine.processes.filter(argv => argv[0] === 'gh'), 'gh is not asked while the environment has a token').toEqual([])

  engine.env = {}
  engine.gh = { exitCode: 0, stdout: `${TOKEN}\n` }
  expect((await call($, 'merge_check', { task: 't395-1', closes: [395] })).text).toMatch(/^t395-1 may merge now\./)
  expect((await call($, 'merge_check', { task: 't395-1', closes: [395] })).text).toMatch(/^t395-1 may merge now\./)
  expect(engine.processes.filter(argv => argv[0] === 'gh'), "gh's token is kept for the session").toEqual([['gh', 'auth', 'token']])

  // gh signed in anew: GitHub refuses the token kept, and the next look asks gh again.
  forge.accepts = 'a-newer-token'
  engine.gh = { exitCode: 0, stdout: 'a-newer-token\n' }
  expect((await call($, 'merge_check', { task: 't395-1', closes: [395] })).text).toContain('could not be read (HTTP 401)')
  expect((await call($, 'merge_check', { task: 't395-1', closes: [395] })).text).toMatch(/^t395-1 may merge now\./)
  expect(engine.processes.filter(argv => argv[0] === 'gh')).toHaveLength(2)
})

test('a token given as the mod\'s option comes first', { options: { githubToken: 'the-options-token' } }, async ($, on) => {
  const { engine, forge } = await bound($, on)
  // Both environment variables hold a token GitHub refuses here: only the option's is taken.
  engine.env = { GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN }
  forge.accepts = 'the-options-token'
  expect((await call($, 'merge_check', { task: 't395-1', closes: [395] })).text).toMatch(/^t395-1 may merge now\./)
  expect(engine.processes.filter(argv => argv[0] === 'gh')).toEqual([])
})

test('the base branch and the merge method are the ones the mod was installed with', { options: { baseBranch: 'trunk', mergeMethod: 'squash' } }, async ($, on) => {
  const { engine, forge } = await bound($, on)
  forge.pulls[548]!.base.ref = 'trunk'

  expect((await call($, 'merge', MERGE)).text).toMatch(/^Merged: PR 548 \(t395-1\) is on trunk as /)
  expect(forge.merges).toEqual([{ pr: 548, body: { sha: HEAD, merge_method: 'squash' } }])
  expect(forge.asked).toContain(`GET ${API}/branches/trunk`)
  engine.agentIds.push('a1')
  await spawn($, 't392-1')
  expect((await bash($, 'git push origin HEAD:trunk', 'a1')).deny).toContain('this command pushes to trunk. A worker never merges and never pushes to trunk')
  expect((await bash($, 'git push origin HEAD:main', 'a1')).deny, 'main is just a branch here').toBeUndefined()
})

test('after a merge the checks on the base branch are watched: a failure is one blocker, and only the repair merges on top', async ($, on) => {
  const { clock, files, engine, forge } = await bound($, on)
  await call($, 'merge', MERGE)
  forge.checks[COMMIT] = [...ci('success', ['build']), ...ci('failure', ['test'])]
  await clock.advance(HALF_MINUTE)

  const failed = `${COMMIT.slice(0, 7)}: test`
  expect(stored(files).main).toMatchObject({ commit: COMMIT, failed })
  expect(stored(files).problems.at(-1)).toMatchObject({ id: 'P4', severity: 'blocker', status: 'open', text: `The checks on main failed for ${failed}. Nothing merges onto a red main but its repair.` })
  await clock.advance(HALF_MINUTE)
  expect(stored(files).problems.filter(one => one.text.startsWith('The checks on main failed')), 'said once').toHaveLength(1)
  await clock.advance(5000)
  expect(engine.woke.at(-1)).toContain(`the checks on main failed for ${failed}`)

  // Main is red: only the repair may merge on top of it, and it has to say so.
  forge.pulls[547] = pull('d'.repeat(40))
  forge.checks['d'.repeat(40)] = ci('success')
  await call($, 'task_update', { task: 't393-1', status: 'green' })
  expect((await call($, 'merge', { task: 't393-1', told: [] })).text).toContain(`The checks on main failed for ${COMMIT.slice(0, 7)} (test)`)
  expect((await call($, 'merge', { task: 't393-1', told: [], onRedMain: true })).text).toMatch(/^Merged: PR 547/)

  // The repair's checks go green: the watch is over.
  forge.checks[mergeCommit(547)] = ci('success')
  await clock.advance(HALF_MINUTE)
  expect(stored(files).main).toBeUndefined()
})

test('checks cancelled by a newer push are not taken for a red base branch', async ($, on) => {
  const { clock, files, forge } = await bound($, on)
  await call($, 'merge', MERGE)
  const newer = 'e'.repeat(40)
  forge.checks[COMMIT] = ci('cancelled')
  forge.checks[newer] = ci(null)
  forge.movesTo = newer

  await clock.advance(HALF_MINUTE)
  expect(stored(files).main?.failed, 'main moved while the watch looked: the newer head decides').toBeUndefined()
  expect(stored(files).problems).toHaveLength(LEDGER.problems.length)

  forge.checks[newer] = ci('success')
  await clock.advance(HALF_MINUTE)
  expect(stored(files).main).toBeUndefined()
})

test('a base branch nothing checks is watched for an hour at most, and nothing is said', async ($, on) => {
  const { clock, files } = await bound($, on)
  await call($, 'merge', MERGE)

  await clock.advance(59 * 60_000)
  expect(stored(files).main).toMatchObject({ commit: COMMIT })
  await clock.advance(2 * 60_000)
  expect(stored(files).main).toBeUndefined()
  expect(stored(files).problems).toHaveLength(LEDGER.problems.length)
})

test('a merge whose answer was lost is settled by the watch from the pull request itself, and the orchestrator is told', async ($, on) => {
  const { clock, files, engine, forge } = await bound($, on)
  forge.onMerge = 'merge and go down'

  expect((await call($, 'merge', MERGE)).text).toMatch(
    /^Not known yet\. The merge call for PR 548 went out \(HTTP 200: Pull Request successfully merged\), but GitHub could not be asked afterwards whether it merged\./,
  )
  expect(stored(files).merge).toMatchObject({ state: 'merging' })

  forge.isDown = false
  await clock.advance(HALF_MINUTE)
  expect(stored(files).merge?.state, 'left alone while the call itself may still be at it').toBe('merging')
  await clock.advance(4 * HALF_MINUTE)
  expect(stored(files).merge).toBeUndefined()
  expect(task(files, 't395-1')).toMatchObject({ status: 'done', mergeCommit: COMMIT })
  await clock.advance(5000)
  expect(engine.woke.at(-1)).toMatch(/^Run board: PR 548 \(t395-1\) is merged as [0-9a-f]{7}, and the task is done\.$/)
})

test('a claim whose merge never happened is let go by the watch, and the orchestrator is told', async ($, on) => {
  const claim: Merge = { task: 't395-1', pr: 548, head: HEAD, state: 'merging', startedAt: new Date(NOW - 5 * 60_000).toISOString() }
  const { clock, files } = await bound($, on, { ...LEDGER, merge: claim })

  await clock.advance(HALF_MINUTE)
  expect(stored(files).merge).toBeUndefined()
  expect(task(files, 't395-1').status).toBe('green')
  const next = await raise($, { tool: 'Read', tool_use_id: 'read', file_path: '/repo/README.md' })
  expect(next.context?.join('\n')).toContain('Run board: PR 548 (t395-1) was not merged: the merge call did not go through.')
})

test('another run\'s merge in flight keeps this one waiting, while it is fresh', async ($, on) => {
  const { files, forge } = await bound($, on)
  const flight = (minutesAgo: number): Merge => ({ task: 't395-1', pr: 600, head: HEAD, state: 'merging', startedAt: new Date(NOW - minutesAgo * 60_000).toISOString() })
  const other = (minutesAgo: number) => file({ ...LEDGER, run: { ...LEDGER.run, id: 'signin' }, merge: flight(minutesAgo) }, 1)

  files[ledgerPath('signin')] = other(10)
  expect((await call($, 'merge', MERGE)).text).toMatch(/^Not done\. Run signin is merging PR 600 \(t395-1\) since .*: one merge at a time, across runs too\./)
  expect(forge.merges).toEqual([])

  files[ledgerPath('signin')] = other(50)
  expect((await call($, 'merge', MERGE)).text, 'a merge that old is taken as abandoned').toMatch(/^Merged: PR 548/)
})

test('in a run nothing reaches the base branch by hand: not from a worker, and not from the orchestrator', async ($, on) => {
  const { engine } = await bound($, on)
  engine.agentIds.push('a1')
  await spawn($, 't392-1')
  const merge = `curl -sS -X PUT -H "Authorization: Bearer $T" "${API}/pulls/548/merge"`

  expect((await bash($, merge, 'a1')).deny).toBe(
    "conductor: this command merges a pull request. A worker never merges and never pushes to main: set your task to review with its pull request and hand back. Merging is the orchestrator's.",
  )
  expect((await bash($, 'git push origin HEAD:main', 'a1')).deny).toContain('this command pushes to main. A worker never merges')
  expect((await bash($, merge)).deny).toMatch(/^conductor: this command merges a pull request by hand\. In a run a pull request reaches main through mcp__conductor__merge/)
  expect((await bash($, 'gh pr merge 548 --squash')).deny).toContain('merges a pull request by hand')
  expect((await bash($, 'git push origin main')).deny).toContain('pushes to main by hand')
  expect(engine.ran.filter(one => one.tool === 'Bash'), 'none of them ran').toEqual([])

  expect((await bash($, 'git push -u origin fix/392-busy-line', 'a1')).deny, 'a worker pushes its own branch').toBeUndefined()
  expect((await bash($, 'gh pr view 548 --json mergeable')).deny, 'the orchestrator looks at a pull request').toBeUndefined()
  expect(engine.ran.filter(one => one.tool === 'Bash')).toHaveLength(2)
})

test('a session bound to no run is left alone', async ($, on) => {
  const { engine } = await bound($, on, LEDGER, false)
  expect((await bash($, 'git push origin main')).deny).toBeUndefined()
  expect(engine.ran).toEqual([{ tool: 'Bash', agentId: undefined }])
  expect((await call($, 'merge', MERGE)).text).toMatch(/^Not done\. This session is bound to no run/)
})

test('a working orchestrator reads that the base branch went red with its next tool result, and is not woken for it as well', async ($, on) => {
  const { clock, engine, forge } = await bound($, on)
  await $.turn.start({ text: 'Carry on.', turnId: 'turn-main' })
  await call($, 'merge', MERGE)
  forge.checks[COMMIT] = ci('failure')
  await clock.advance(HALF_MINUTE)

  const next = await raise($, { tool: 'Read', tool_use_id: 'read', file_path: '/repo/README.md' })
  expect(next.context?.join('\n')).toContain('Run board: the checks on main failed for')
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 'turn-main', reason: 'answer' })
  await clock.advance(5000)
  expect(engine.woke.filter(one => one.includes('checks on main failed')), 'told once').toEqual([])
})

test('/merged finishes a task by the owner\'s word, when the board cannot see for itself', async ($, on) => {
  const { files } = await bound($, on)
  expect((await command($, 'merged')).text).toContain('Say which task: /merged <task id>.')
  expect((await command($, 'merged', 't395-1')).text).toBe('t395-1 is done, by your word that its pull request is merged.')
  expect(task(files, 't395-1')).toMatchObject({ status: 'done', note: "merged, by the owner's word" })
  expect((await command($, 'merged', 't999')).text).toBe('There is no task t999 in this run.')
})
