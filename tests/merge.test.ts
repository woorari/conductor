import { describe, expect, test } from 'claude-code/testing'

import { boardView, detail, summary } from '../hooks/board'
import { dashboardSvg } from '../hooks/dashboard'
import { handover } from '../hooks/handover'
import { parseLedger } from '../hooks/ledger'
import {
  abandoned,
  byHand,
  checksOf,
  closes,
  configOf,
  elsewhere,
  flightsOf,
  githubRepo,
  headOf,
  isForges,
  judge,
  mayClose,
  messageOf,
  obstacles,
  onMain,
  ownerSaysMerged,
  precheck,
  pullOf,
  startMerge,
} from '../hooks/merge'
import type { Asked, Facts, Verdict } from '../hooks/merge'
import { updateTask } from '../hooks/signals'
import type { Caller, Raw } from '../hooks/signals'
import type { Ledger, Merge } from '../types'
import { LEDGER, NOW } from './fixture'
import { TEST_MERGE, ci, pull } from './world'

const AT = '2026-10-09T10:30:00.000Z'
const HEAD = 'b'.repeat(40)
const MAIN = 'a'.repeat(40)
const COMMIT = 'c'.repeat(40)
const ORCHESTRATOR: Caller = { kind: 'orchestrator' }
const raw = (ledger: Ledger = LEDGER): Raw => JSON.parse(JSON.stringify(ledger)) as Raw
const parsed = (ledger: Raw): Ledger => {
  const read = parseLedger(JSON.stringify(ledger))
  expect(read.error, 'the edit leaves a ledger that still reads').toBeUndefined()

  return read.ledger!
}
const task = (ledger: Raw, id: string) => ledger.tasks.find(one => one.id === id)!
const FLIGHT: Merge = { task: 't395-1', pr: 548, head: HEAD, state: 'merging', startedAt: AT }
const flying = (more: Partial<Merge> = {}): Ledger => ({ ...LEDGER, merge: { ...FLIGHT, ...more } })
const GREEN: Verdict = { verdict: 'green', line: 'build=success', failed: [] }
const checks = (runs: unknown[], statuses: unknown[] = [], totals: { runs?: number; statuses?: number } = {}) =>
  checksOf({ total_count: totals.runs ?? runs.length, check_runs: runs }, { state: 'pending', statuses, total_count: totals.statuses ?? statuses.length })!

describe('where the repository is', () => {
  test('a remote on github.com, however it is spelled, names its repository', () => {
    for (const remote of [
      'git@github.com:acme/widgets.git',
      'git@github.com:acme/widgets',
      'https://github.com/acme/widgets.git',
      'https://github.com/acme/widgets/',
      'https://x-access-token:secret@github.com/acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git',
      'ssh://git@ssh.github.com:443/acme/widgets.git',
      'https://www.github.com/acme/widgets',
    ]) {
      expect(githubRepo(remote), remote).toBe('acme/widgets')
      expect(isForges(remote), remote).toBe(true)
    }
  })

  test('any other host, a path that names no repository and no origin are not GitHub', () => {
    for (const remote of ['https://gitlab.com/acme/widgets.git', 'git@bitbucket.org:acme/widgets.git', 'https://github.example.com/acme/widgets', 'https://github.com/acme', '/srv/git/widgets.git', '']) {
      expect(githubRepo(remote), remote).toBeUndefined()
    }
    expect(isForges(null)).toBe(false)
    expect(isForges(undefined)).toBe(false)
  })

  test('elsewhere, the board says which repository this is and how a task is closed', () => {
    expect(elsewhere('https://gitlab.com/acme/widgets.git')).toContain('acme/widgets, which is not on GitHub')
    expect(elsewhere(null)).toContain('not known (it has none to read)')
    expect(elsewhere(null)).toContain('/merged <task>')
  })
})

describe('the options the mod was installed with', () => {
  test('empty or odd options are the defaults', () => {
    expect(configOf(undefined)).toEqual({ base: 'main', method: 'merge', token: '' })
    expect(configOf({ baseBranch: '  ', mergeMethod: 'octopus', githubToken: 42 })).toEqual({ base: 'main', method: 'merge', token: '' })
  })

  test('a base branch, a merge method and a token are taken as given, trimmed', () => {
    expect(configOf({ baseBranch: ' trunk ', mergeMethod: 'squash', githubToken: ' t0ken ' })).toEqual({ base: 'trunk', method: 'squash', token: 't0ken' })
    expect(configOf({ mergeMethod: 'rebase' }).method).toBe('rebase')
  })
})

describe('what a commit\'s checks say', () => {
  test('green needs at least one check, and every one passed, was neutral or skipped', () => {
    expect(judge(checks(ci('success')))).toEqual({ verdict: 'green', line: 'build=success, test=success', failed: [] })
    expect(judge(checks([...ci('success', ['build']), ...ci('skipped', ['deploy']), ...ci('neutral', ['lint'])])).verdict).toBe('green')
    expect(judge(checks([]))).toEqual({ verdict: 'running', line: 'no checks yet', failed: [] })
  })

  test('a check still going is no verdict yet', () => {
    expect(judge(checks([...ci('success', ['build']), ...ci(null, ['test'])]))).toEqual({ verdict: 'running', line: 'build=success, test=in_progress', failed: [] })
    expect(judge(checks([{ name: 'build', status: 'queued', conclusion: null }])).verdict).toBe('running')
  })

  test('any check that finished another way failed, and says which', () => {
    for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']) {
      expect(judge(checks([...ci('success', ['build']), ...ci(conclusion, ['test'])])), conclusion).toMatchObject({ verdict: 'failed', failed: ['test'] })
    }
  })

  test('commit statuses count beside check runs', () => {
    expect(judge(checks(ci('success'), [{ context: 'ci/legacy', state: 'success' }])).verdict).toBe('green')
    expect(judge(checks(ci('success'), [{ context: 'ci/legacy', state: 'pending' }])).verdict).toBe('running')
    expect(judge(checks(ci('success'), [{ context: 'ci/legacy', state: 'error' }]))).toMatchObject({ verdict: 'failed', failed: ['ci/legacy'] })
    expect(judge(checks([], [{ context: 'ci/legacy', state: 'success' }])).verdict, 'statuses alone are checks too').toBe('green')
  })

  test('more checks than one page holds is never green', () => {
    const many = checks(ci('success'), [], { runs: 150 })
    expect(many.isPartial).toBe(true)
    expect(judge(many).verdict).toBe('running')
    expect(judge(checks([...ci('success'), ...ci('failure', ['lint'])], [], { runs: 150 })).verdict, 'a failure on the page is a failure all the same').toBe('failed')
  })

  test('an answer that is not one is not guessed at', () => {
    expect(checksOf({ message: 'Not Found' }, { statuses: [] })).toBeUndefined()
    expect(checksOf({ check_runs: [{ status: 'completed' }] }, { statuses: [] })).toBeUndefined()
    expect(checksOf({ check_runs: [] }, null)).toBeUndefined()
  })
})

describe('what GitHub answered', () => {
  test('a pull request is read from its answer, and an answer that is none is not guessed at', () => {
    expect(pullOf({ number: 548, ...pull(HEAD, { title: 'Daily cap', body: 'Closes #395' }) })).toEqual({
      state: 'open',
      isMerged: false,
      mergeable: true,
      mergeableState: 'clean',
      isDraft: false,
      base: 'main',
      head: HEAD,
      title: 'Daily cap',
      body: 'Closes #395',
      commit: undefined,
    })
    expect(pullOf(pull(HEAD))?.commit, "before the merge GitHub's merge_commit_sha is a test merge, never the merge's").toBeUndefined()
    expect(TEST_MERGE).not.toBe(COMMIT)
    expect(pullOf({ ...pull(HEAD, { merged: true, state: 'closed', merge_commit_sha: COMMIT }) })).toMatchObject({ isMerged: true, commit: COMMIT })
    expect(pullOf(pull(HEAD, { mergeable: null, mergeable_state: undefined as never }))).toMatchObject({ mergeable: null, mergeableState: 'unknown' })
    expect(pullOf({ message: 'Not Found' })).toBeUndefined()
    expect(pullOf(null)).toBeUndefined()
  })

  test('a branch\'s head and GitHub\'s own words about a refusal', () => {
    expect(headOf({ name: 'main', commit: { sha: MAIN } })).toBe(MAIN)
    expect(headOf({ name: 'main' })).toBeUndefined()
    expect(messageOf('{"message":"Head branch was modified. Review and try the merge again."}')).toBe('Head branch was modified. Review and try the merge again.')
    expect(messageOf('not json')).toBe('')
  })
})

describe('what a description would close', () => {
  test('GitHub\'s own keywords close, in prose', () => {
    expect(closes('Daily cap.\n\nCloses #395\n(fixes #12) and resolved: #7')).toEqual([7, 12, 395])
    expect(closes('Part of #334. See #391.')).toEqual([])
  })

  test('a keyword inside backticks or a fenced block closes nothing', () => {
    expect(closes('Write `Closes #370` as plain text.\n```\nfixes #371\n```')).toEqual([])
    expect(mayClose('Write `Closes #370` as plain text.')).toEqual([])
  })

  test('a wording nobody meant as a closing is still asked about', () => {
    expect(closes('After this lands, fixing #12 is next.')).toEqual([])
    expect(mayClose('After this lands, fixing #12 is next. Then close #367.')).toEqual([12, 367])
  })
})

describe('the board\'s side of a merge', () => {
  const ask = (input: Record<string, unknown>, ledger: Ledger = LEDGER, caller: Caller = ORCHESTRATOR, isCheckOnly = false) =>
    precheck(ledger, caller, input, [], isCheckOnly)
  const refusal = (...args: Parameters<typeof ask>): string => {
    const said = ask(...args)

    return 'error' in said ? said.error : 'accepted'
  }

  test('a green task with a pull request, asked for by the orchestrator who says whom it told', () => {
    const said = ask({ task: 't395-1', told: [' Triage issues '], closes: [395, 395] })
    expect(said).toMatchObject({ pr: 548, closes: [395], told: ['Triage issues'], isOnRedMain: false })
    expect(ask({ task: 't395-1', told: [], onRedMain: true })).toMatchObject({ isOnRedMain: true, closes: [] })
  })

  test('a worker never merges', () => {
    expect(refusal({ task: 't395-1', told: [] }, LEDGER, { kind: 'worker', taskId: 't395-1' })).toContain('Only the orchestrator merges. A worker never does')
    expect(refusal({ task: 't395-1', told: [] }, LEDGER, { kind: 'stranger' })).toContain('Only the orchestrator merges')
  })

  test('the task has to exist, be open and have a pull request', () => {
    expect(refusal({ task: 't999', told: [] })).toContain('There is no task t999 in this run.')
    expect(refusal({ task: 't390-1', told: [] })).toBe('t390-1 is done already.')
    expect(refusal({ task: 't392-1', told: [] })).toBe('t392-1 has no pull request: record its number with task_update first.')
  })

  test('a merge says whom it told; a check need not', () => {
    expect(refusal({ task: 't395-1' })).toContain('Say whom you told first')
    expect(ask({ task: 't395-1' }, LEDGER, ORCHESTRATOR, true)).toMatchObject({ pr: 548, told: [] })
    expect(refusal({ task: 't395-1', told: [''] })).toContain('told is a list of the sessions')
    expect(refusal({ task: 't395-1', told: [], closes: ['395'] })).toContain('closes is a list of issue numbers')
  })

  test('what the task waits for and is not done yet is noted, for the merge to refuse', () => {
    const stacked: Ledger = { ...LEDGER, tasks: LEDGER.tasks.map(one => (one.id === 't395-1' ? { ...one, dependsOn: ['t390-1', 't393-1', 't391-1'] } : one)) }
    expect(ask({ task: 't395-1', told: [] }, stacked)).toMatchObject({ unmerged: ['t393-1 (review)', 't391-1 (building)'] })
    expect(ask({ task: 't395-1', told: [] })).toMatchObject({ unmerged: [] })
  })

  test('one merge at a time in a run', () => {
    expect(refusal({ task: 't393-1', told: [] }, flying())).toBe('t395-1 is still merging (PR 548): one merge at a time. The board settles it and tells you.')
    expect(refusal({ task: 't395-1', told: [] }, flying())).toContain('t395-1 is merging already (PR 548)')
  })

  test('and one at a time across runs, for as long as the other one is fresh', () => {
    const other = (minutesAgo: number): Ledger => ({ ...flying({ startedAt: new Date(NOW - minutesAgo * 60_000).toISOString() }), run: { ...LEDGER.run, id: 'signin' } })
    expect(flightsOf([other(10), flying()], 'demo', NOW)).toEqual([{ run: 'signin', task: 't395-1', pr: 548, startedAt: new Date(NOW - 600_000).toISOString() }])
    expect(flightsOf([other(46)], 'demo', NOW), 'taken as abandoned').toEqual([])
    expect(flightsOf([other(10)], 'signin', NOW), 'its own').toEqual([])
    const said = precheck(LEDGER, ORCHESTRATOR, { task: 't395-1', told: [] }, flightsOf([other(10)], 'demo', NOW), false)
    expect('error' in said ? said.error : '').toContain('Run signin is merging PR 548 (t395-1) since')
  })
})

describe('what stands in the way', () => {
  const asked = (more: Partial<Asked> = {}): Asked => ({ task: LEDGER.tasks.find(one => one.id === 't395-1')!, pr: 548, closes: [], told: [], isOnRedMain: false, unmerged: [], ...more })
  const facts = (more: Partial<Facts> = {}, change: Parameters<typeof pull>[1] = {}): Facts => ({
    pull: pullOf(pull(HEAD, change))!,
    checks: GREEN,
    base: 'main',
    baseHead: MAIN,
    main: GREEN,
    ...more,
  })

  test('nothing, when the task is green, the pull request open and mergeable, and every check green', () => {
    expect(obstacles(facts(), asked())).toEqual([])
    expect(obstacles(facts({}, { mergeable_state: 'unstable' }), asked()), 'unstable is a check that is not required: the checks say').toEqual([])
    expect(obstacles(facts({}, { mergeable_state: 'has_hooks' }), asked())).toEqual([])
  })

  test('a task the orchestrator has not judged green', () => {
    const review = asked({ task: LEDGER.tasks.find(one => one.id === 't393-1')!, pr: 547 })
    expect(obstacles(facts(), review)).toEqual(['t393-1 is review: only a task you judged green (its checks green, its change reviewed) is merged.'])
  })

  test('a pull request that is closed, a draft or into another branch', () => {
    expect(obstacles(facts({}, { state: 'closed' }), asked())).toEqual(['PR 548 is closed, not open.'])
    expect(obstacles(facts({}, { draft: true, mergeable_state: 'draft' }), asked())).toEqual(['PR 548 is a draft.'])
    expect(obstacles(facts({}, { base: { ref: 'release' } }), asked())).toEqual(['PR 548 merges into release, not main.'])
    expect(obstacles(facts({ base: 'trunk' }, { base: { ref: 'trunk' } }), asked()), 'the base branch is the one the mod was set up with').toEqual([])
  })

  test('what GitHub says of its mergeability', () => {
    expect(obstacles(facts({}, { mergeable: null, mergeable_state: 'unknown' }), asked())).toEqual(['GitHub has not worked out yet whether PR 548 can be merged: ask again in a moment.'])
    expect(obstacles(facts({}, { mergeable: false, mergeable_state: 'dirty' }), asked())).toEqual(['PR 548 has a conflict with main: have its branch updated and graded again.'])
    expect(obstacles(facts({}, { mergeable_state: 'blocked' }), asked())).toEqual(["GitHub's branch protection blocks PR 548: a required review or a required check is missing."])
    expect(obstacles(facts({}, { mergeable_state: 'behind' }), asked())).toEqual(['PR 548 is behind main, and branch protection wants it up to date: have its branch updated and graded again.'])
    expect(obstacles(facts({}, { mergeable_state: 'something-new' }), asked())).toEqual(['GitHub says PR 548 cannot be merged as it is (mergeable_state something-new).'])
  })

  test('checks that are not green on its head', () => {
    const running: Verdict = { verdict: 'running', line: 'build=in_progress', failed: [] }
    const failed: Verdict = { verdict: 'failed', line: 'build=failure', failed: ['build'] }
    expect(obstacles(facts({ checks: running }), asked())).toEqual(["PR 548's checks have no verdict yet on bbbbbbb (build=in_progress)."])
    expect(obstacles(facts({ checks: failed }), asked())).toEqual(["PR 548's checks failed on bbbbbbb: build."])
  })

  test('checks still running on the base branch hold nothing', () => {
    const running: Verdict = { verdict: 'running', line: 'build=in_progress', failed: [] }
    expect(obstacles(facts({ main: running }), asked())).toEqual([])
  })

  test('failed checks on the base branch, unless this is the pull request that repairs them', () => {
    const failed: Verdict = { verdict: 'failed', line: 'test=failure', failed: ['test'] }
    expect(obstacles(facts({ main: failed }), asked())[0]).toContain('The checks on main failed for aaaaaaa (test)')
    expect(obstacles(facts({ main: failed }), asked({ isOnRedMain: true }))).toEqual([])
  })

  test('a description that would close an issue nobody said this merge closes', () => {
    const said = obstacles(facts({}, { body: 'Daily cap.\n\nThen close #367.' }), asked())
    expect(said).toEqual([
      "PR 548's description would close #367, which this merge was not said to close. Pass closes: [367] if that is meant; otherwise have the wording changed.",
    ])
    expect(obstacles(facts({}, { body: 'Closes #395' }), asked({ closes: [395] }))).toEqual([])
  })

  test('an issue meant to be closed that the description does not close', () => {
    const said = obstacles(facts({}, { body: 'Daily cap. `Closes #395`' }), asked({ closes: [395] }))
    expect(said).toEqual([
      'PR 548 is meant to close #395, but its description does not say so in plain text (a "Closes #N" inside backticks does nothing): the issue would stay open.',
    ])
  })

  test('a task that waits for one that is not merged yet', () => {
    expect(obstacles(facts(), asked({ unmerged: ['t393-1 (green)'] }))).toEqual(['t395-1 waits for t393-1 (green): what a task waits for is merged first, in that order.'])
  })

  test('everything wrong is said at once', () => {
    const running: Verdict = { verdict: 'running', line: 'no checks yet', failed: [] }
    const failed: Verdict = { verdict: 'failed', line: 'test=failure', failed: ['test'] }
    expect(obstacles(facts({ checks: running, main: failed }, { draft: true, mergeable: false, mergeable_state: 'dirty' }), asked())).toHaveLength(4)
  })
})

describe('what a merge writes', () => {
  const claim = { task: 't395-1', pr: 548, head: HEAD, told: ['Triage issues'], closes: [395] }

  test('the claim, then the merge: the task is done and the base branch is watched', () => {
    const ledger = raw()
    expect(startMerge(ledger, AT, claim)).toMatchObject({ isChanged: true, isError: false })
    expect(parsed(ledger).merge).toEqual({ task: 't395-1', pr: 548, head: HEAD, state: 'merging', startedAt: AT, told: ['Triage issues'], closes: [395] })
    expect(startMerge(ledger, AT, { ...claim, task: 't393-1', pr: 547 }).text, 'a second claim').toBe('t395-1 is merging already: one merge at a time.')

    const done = onMain(ledger, '2026-10-09T10:31:00.000Z', COMMIT, 'main')
    expect(done.text).toContain('Merged: PR 548 (t395-1) is on main as ccccccc, and the task is done.')
    expect(done.text).toContain('The board watches the checks on main and says so if they fail.')
    const after = parsed(ledger)
    expect(after.merge).toBeUndefined()
    expect(after.main).toEqual({ since: '2026-10-09T10:31:00.000Z', commit: COMMIT })
    expect(task(ledger, 't395-1')).toMatchObject({ status: 'done', mergeCommit: COMMIT, mergedAt: '2026-10-09T10:31:00.000Z' })
  })

  test('a pull request merged outside the board is taken over: done, with no claim', () => {
    const ledger = raw()
    const said = onMain(ledger, AT, COMMIT, 'trunk', { isAdopted: true, task: 't395-1', pr: 548 })
    expect(said.text).toContain('Taken over: PR 548 (t395-1) is on trunk as ccccccc')
    expect(task(ledger, 't395-1').status).toBe('done')
    expect(onMain(raw(), AT, COMMIT, 'main').isError, 'with no claim and no task named there is nothing to settle').toBe(true)
  })

  test('a merge GitHub refused lets the claim go and leaves the task where it stood', () => {
    const ledger = raw()
    startMerge(ledger, AT, claim)
    const said = abandoned(ledger, 'GitHub answered HTTP 409: Head branch was modified')
    expect(said.tell).toBe('Run board: PR 548 (t395-1) was not merged: GitHub answered HTTP 409: Head branch was modified. The claim is let go; the task stands where it stood.')
    expect(parsed(ledger).merge).toBeUndefined()
    expect(task(ledger, 't395-1').status).toBe('green')
  })

  test('the owner\'s word finishes a task, whatever the board saw', () => {
    const ledger = raw(flying())
    expect(ownerSaysMerged(ledger, AT, 't395-1').text).toBe('t395-1 is done, by your word that its pull request is merged.')
    expect(parsed(ledger).merge, 'its merge in flight is settled with it').toBeUndefined()
    expect(task(ledger, 't395-1')).toMatchObject({ status: 'done', note: "merged, by the owner's word" })
    expect(ownerSaysMerged(ledger, AT, 't395-1').isError).toBe(true)
    expect(ownerSaysMerged(ledger, AT, 't999').text).toBe('There is no task t999 in this run.')
  })

  test('the orchestrator cannot call a task with a pull request done', () => {
    const ledger = raw()
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't395-1', status: 'done' }).text).toContain('t395-1 has a pull request, so it is done once that is merged')
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't392-1', status: 'done', pr: 560 }).isError, 'nor one it gives a pull request in the same breath').toBe(true)
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't392-1', status: 'done' }).isError, 'a task with none is its to finish').toBe(false)
  })

  test('a ledger whose merge names no task of the run, or an unknown state, does not read', () => {
    expect(parseLedger(JSON.stringify(flying({ task: 't999' }))).error).toBe('merge: task names "t999", which is no task of this run')
    expect(parseLedger(JSON.stringify(flying({ state: 'landed' as never }))).error).toBe('merge.state: expected merging, got "landed"')
    expect(parseLedger(JSON.stringify(flying())).ledger?.merge).toEqual(FLIGHT)
  })
})

describe('what reaches the base branch by hand', () => {
  test("GitHub's merge call, gh pr merge and a push to the base branch", () => {
    expect(byHand('curl -sS -X PUT -H "Authorization: Bearer $T" "https://api.github.com/repos/acme/widgets/pulls/548/merge"', 'main')).toBe('merges a pull request')
    expect(byHand('gh api -X PUT repos/acme/widgets/pulls/548/merge', 'main')).toBe('merges a pull request')
    expect(byHand('gh pr merge 548 --squash', 'main')).toBe('merges a pull request')
    for (const command of [
      'git push origin main',
      'git push origin HEAD:main',
      'git -C /repo push --force-with-lease origin +fix/391:refs/heads/main',
      'git commit -m "x" -- a.py && git push origin "main"',
    ]) {
      expect(byHand(command, 'main'), command).toBe('pushes to main')
    }
    expect(byHand('git push origin HEAD:trunk', 'trunk')).toBe('pushes to trunk')
    expect(byHand('git push origin HEAD:main', 'trunk'), 'main is just a branch where the base is trunk').toBeUndefined()
  })

  test('a worker\'s own push, a commit that talks about main and a branch update are left alone', () => {
    for (const command of [
      'git push -u origin fix/391-pool',
      'git push origin HEAD',
      'git push origin fix/main',
      'git commit -m "push to main later"',
      'git fetch origin main && git merge origin/main',
      'gh pr view 548 --json mergeable',
      'gh api repos/acme/widgets/pulls/548',
    ]) {
      expect(byHand(command, 'main'), command).toBeUndefined()
    }
  })
})

describe('a merge in flight on the board', () => {
  const view = boardView(flying({ startedAt: new Date(NOW - 4 * 60_000).toISOString() }), NOW)

  test('the task in flight leads what is to merge and says where it stands', () => {
    expect(view.review.map(row => row.id)).toEqual(['t395-1', 't393-1'])
    expect(detail(view.review[0]!)).toBe('merging 4 min · sonnet · w395 · PR 548 · ticket 395')
    expect(summary(view)).toBe('2 problems open (2 without a task) · 1 waiting for a decision · 2 building · 1 merging · 1 in review · 1 next · 2 of 9 done')
  })

  test('the dashboard says it in the section and on the row', () => {
    const drawn = dashboardSvg(view, { width: 420, theme: 'dark' })
    expect(drawn.source).toContain('>merging · 1 in review<')
    expect(drawn.source).toContain('>merging · 4 min<')
    expect(drawn.alt).toContain('1 merging')
  })

  test('a compaction carries the merge in flight', () => {
    const text = handover(flying(), { at: AT })
    expect(text).toContain(
      'A merge is in flight: t395-1 (PR 548), pinned to bbbbbbb, merging since 2026-10-09T10:30:00.000Z. The mod settles it with GitHub, marks the task done and tells you; merge nothing else meanwhile.',
    )
    expect(handover(LEDGER, { at: AT })).not.toContain('A merge is in flight')
  })
})
