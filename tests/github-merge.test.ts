import { expect, test } from 'claude-code/testing'

import { checksAt, flights, lookAtBase, reconcileRun, settle, survey } from '../hooks/github-merge'
import type { FlightHost, GithubAnswer, GithubHost, SettleHost, SurveyHost } from '../hooks/github-merge'
import { onMain } from '../hooks/merge'
import type { Outcome, Raw } from '../hooks/signals'
import type { Ledger } from '../types'
import { ci, pull } from './world'

const HEAD = 'b'.repeat(40)
const MAIN = 'a'.repeat(40)
const COMMIT = 'c'.repeat(40)
const START = '2026-11-18T10:00:00.000Z'
const NOW = Date.parse('2026-11-18T10:10:00.000Z')

/** What GitHub answers for a path, as recorded; a path not recorded is a 404. */
type Recorded = Record<string, unknown>
const answer = (json: unknown, status = 200): GithubAnswer => ({ status, json, text: JSON.stringify(json) })
const runsOf = (list: ReturnType<typeof ci>) => ({ total_count: list.length, check_runs: list })
const NO_STATUS = { state: 'pending', total_count: 0, statuses: [] }
const checks = (sha: string, list: ReturnType<typeof ci>): Recorded => ({
  [`/commits/${sha}/check-runs?per_page=100`]: runsOf(list),
  [`/commits/${sha}/status?per_page=100`]: NO_STATUS,
})

/** The mod's host: answers from the recording and says `error` for a path that is down, never throws. */
function modHost(recorded: Recorded, down: readonly string[] = []): SurveyHost & { asked: string[] } {
  const asked: string[] = []

  return {
    asked,
    base: async () => 'main',
    repo: () => 'acme/widgets',
    github: async path => {
      asked.push(path)
      if (down.some(part => path.includes(part))) return { error: 'no answer within 15 s' }
      return path in recorded ? answer(recorded[path]) : answer({ message: 'Not Found' }, 404)
    },
  }
}

/** The Codex script's host: its `gh` function answers bare JSON and throws when it fails. */
function codexHost(recorded: Recorded, now = NOW): GithubHost & { now(): number } {
  const api = async (endpoint: string): Promise<unknown> => {
    const path = endpoint.replace('repos/acme/widgets', '')
    if (!(path in recorded)) throw new Error(`gh: Not Found (HTTP 404) ${path}`)
    return recorded[path]
  }

  return { github: async path => ({ status: 200, json: await api(`repos/acme/widgets${path}`), text: '' }), now: () => now }
}

test('checksAt reports pending while any check run is queued', async () => {
  const host = modHost(checks(HEAD, [...ci('success', ['build']), { name: 'test', status: 'queued', conclusion: null }]))
  expect(await checksAt(host, HEAD)).toEqual({ verdict: 'running', line: 'build=success, test=queued', failed: [] })
})

test('checksAt reports failure on one failed check, and green when every one passed', async () => {
  expect(await checksAt(modHost(checks(HEAD, [...ci('success', ['build']), ...ci('failure', ['test'])])), HEAD)).toEqual({ verdict: 'failed', line: 'build=success, test=failure', failed: ['test'] })
  expect(await checksAt(modHost(checks(HEAD, ci('success'))), HEAD)).toMatchObject({ verdict: 'green' })
})

test('checksAt asks for the check runs and the commit statuses at once, and says why it could not read them', async () => {
  const host = modHost(checks(HEAD, ci('success')))
  await checksAt(host, HEAD)
  expect(host.asked).toEqual([`/commits/${HEAD}/check-runs?per_page=100`, `/commits/${HEAD}/status?per_page=100`])
  expect(await checksAt(modHost({}), HEAD)).toEqual({ error: `the checks of ${HEAD.slice(0, 7)} could not be read (HTTP 404 and 404)` })
  expect(await checksAt(modHost(checks(HEAD, ci('success')), ['/status']), HEAD)).toEqual({ error: 'no answer within 15 s' })
})

test('lookAtBase reads the base branch head and the verdict of its checks, and says why it could not', async () => {
  const recorded = { '/branches/main': { commit: { sha: MAIN } }, ...checks(MAIN, ci('success')) }
  expect(await lookAtBase(modHost(recorded))).toMatchObject({ head: MAIN, verdict: { verdict: 'green' } })
  expect(await lookAtBase(modHost({}))).toEqual({ error: 'the head of main could not be read (HTTP 404)' })
  expect(await lookAtBase(modHost(recorded, ['/branches']))).toEqual({ error: 'no answer within 15 s' })
  expect(await lookAtBase(modHost({ '/branches/main': { commit: { sha: MAIN } } }))).toEqual({ error: `the checks of ${MAIN.slice(0, 7)} could not be read (HTTP 404 and 404)` })
})

test('survey reads the pull request, the base head and both verdicts', async () => {
  const recorded = { '/pulls/12': pull(HEAD), '/branches/main': { commit: { sha: MAIN } }, ...checks(MAIN, ci('success')), ...checks(HEAD, ci('failure')) }
  const surveyed = await survey(modHost(recorded), 12)
  expect(surveyed).toMatchObject({ facts: { base: 'main', baseHead: MAIN, pull: { head: HEAD }, checks: { verdict: 'failed' }, main: { verdict: 'green' } } })
})

test("survey leaves a merged pull request's own checks unread and says when GitHub knows no pull request", async () => {
  const merged = { '/pulls/12': pull(HEAD, { merged: true, state: 'closed', merge_commit_sha: COMMIT }), '/branches/main': { commit: { sha: MAIN } }, ...checks(MAIN, ci('success')) }
  const host = modHost(merged)
  expect(await survey(host, 12)).toMatchObject({ facts: { checks: { verdict: 'green', line: 'merged' } } })
  expect(host.asked.some(path => path.includes(HEAD))).toBe(false)
  expect(await survey(modHost({ '/branches/main': { commit: { sha: MAIN } }, ...checks(MAIN, ci('success')) }), 99)).toEqual({ error: 'it knows no pull request 99 in acme/widgets' })
})

test('survey passes on why GitHub could not be asked, before any verdict', async () => {
  const recorded = { '/pulls/12': pull(HEAD), '/branches/main': { commit: { sha: MAIN } }, ...checks(MAIN, ci('success')), ...checks(HEAD, ci('success')) }
  expect(await survey(modHost(recorded, ['/pulls/']), 12)).toEqual({ error: 'no answer within 15 s' })
  expect(await survey(modHost({ ...recorded, '/pulls/12': { nope: true } }), 12)).toEqual({ error: 'pull request 12 could not be read (HTTP 200)' })
})

/** A folder of runs: each run's ledger text, by name. */
function runsHost(runs: Record<string, string | Error>, dir: string | undefined = '/repo/runs'): FlightHost {
  return {
    runsDir: () => dir,
    list: async () => [...Object.keys(runs).map(name => ({ kind: 'dir', name })), { kind: 'file', name: 'notes.txt' }, { kind: 'dir', name: '.hidden' }],
    read: async path => {
      const got = runs[path.split('/').at(-2)!]
      if (got instanceof Error) throw got
      return got!
    },
  }
}
const ledgerOf = (id: string, merge?: Ledger['merge']): string =>
  JSON.stringify({ version: 1, run: { id, title: id, source: '#1', startedAt: START }, problems: [], posts: [], rulings: [], tasks: [{ id: 't1', title: 'One', tier: 'sonnet', status: 'green' }], ...(merge === undefined ? {} : { merge }) })

test("flights lists the merges other runs have in flight and not the run's own", async () => {
  const claim = { task: 't1', pr: 5, head: HEAD, state: 'merging' as const, startedAt: START }
  const host = runsHost({ mine: ledgerOf('mine', claim), other: ledgerOf('other', claim), idle: ledgerOf('idle'), broken: 'not json', gone: new Error('ENOENT') })
  expect(await flights(host, 'mine', NOW)).toEqual([{ run: 'other', task: 't1', pr: 5, startedAt: START }])
})

test('flights skips a claim that is too old and answers none when there is no folder of runs or it cannot be listed', async () => {
  const stale = { task: 't1', pr: 5, head: HEAD, state: 'merging' as const, startedAt: '2026-11-18T08:00:00.000Z' }
  expect(await flights(runsHost({ other: ledgerOf('other', stale) }), 'mine', NOW)).toEqual([])
  expect(await flights(runsHost({}, undefined), 'mine', NOW)).toEqual([])
  const broken: FlightHost = { runsDir: () => '/repo/runs', list: async () => Promise.reject(new Error('EACCES')), read: async () => '' }
  expect(await flights(broken, 'mine', NOW)).toEqual([])
})

/** A claim on a ledger of one task. */
const claimed = (): Raw => {
  const raw = JSON.parse(ledgerOf('demo', { task: 't1', pr: 12, head: HEAD, state: 'merging', startedAt: START })) as Raw
  ;(raw as unknown as { codex: { base: string } }).codex = { base: 'main' }

  return raw
}

function board(over: { error?: string } = {}) {
  const log: string[] = []
  const raw = claimed()
  const host: SettleHost = {
    mutate: async (_path, change) => {
      log.push('write')
      if (over.error !== undefined) return { error: over.error }
      const said = change(raw)

      return { value: said.value }
    },
    redraw: async () => void log.push('redraw'),
    carry: (outcome: Outcome) => void log.push(`carry ${outcome.text}`),
  }

  return { host, log, raw }
}

test('settle records a merged pull request once: it writes, draws the board, then carries the outcome', async () => {
  const { host, log, raw } = board()
  const done = await settle(host, '/runs/demo/ledger.json', ledger => onMain(ledger, START, COMMIT, 'main'))
  expect(done?.isError).toBe(false)
  expect(log).toEqual(['write', 'redraw', `carry ${done!.text}`])
  expect(raw.merge).toBeUndefined()
  expect(raw.tasks[0]).toMatchObject({ status: 'done', mergeCommit: COMMIT })
  // The claim is gone, so a second settle finds no merge in flight and carries nothing.
  const again = await settle(host, '/runs/demo/ledger.json', ledger => onMain(ledger, START, COMMIT, 'main'))
  expect(again).toBeUndefined()
  expect(log.filter(one => one.startsWith('carry'))).toHaveLength(1)
})

test('settle draws the board and answers nothing when the ledger could not be written', async () => {
  const { host, log } = board({ error: 'The ledger could not be written: disk full' })
  expect(await settle(host, '/runs/demo/ledger.json', ledger => onMain(ledger, START, COMMIT, 'main'))).toBeUndefined()
  expect(log).toEqual(['write', 'redraw'])
})

/** The recording of a pull request and what its reconcile does, for the shared vectors. */
const MERGED = { '/pulls/12': pull(HEAD, { merged: true, state: 'closed', merge_commit_sha: COMMIT }) }
const OPEN = { '/pulls/12': pull(HEAD) }
const AFTER = (ms: number) => NOW - 10 * 60_000 + ms

test('reconcile marks a task done when its pull request is merged on GitHub', async () => {
  const raw = claimed()
  const result = await reconcileRun(codexHost(MERGED), raw, {})
  expect(result).toMatchObject({ isError: false, isChanged: true, text: 'Merge verified and board reconciled. Check base-branch CI now.' })
  expect(raw.merge).toBeUndefined()
  expect(raw.tasks[0]).toMatchObject({ status: 'done', mergeCommit: COMMIT })
})

test('reconcile keeps the claim and says so while GitHub does not report the pull request merged', async () => {
  const raw = claimed()
  const result = await reconcileRun(codexHost(OPEN), raw, {})
  expect(result).toMatchObject({ isError: false, isChanged: false, text: expect.stringContaining('Claim retained') })
  expect(raw.merge).toBeDefined()
})

test('reconcile releases a claim only on release, and not within two minutes', async () => {
  const early = claimed()
  await expect(reconcileRun(codexHost(OPEN, AFTER(60_000)), early, { release: true })).rejects.toThrow('Wait at least two minutes before releasing an uncertain merge claim.')
  expect(early.merge).toBeDefined()
  const late = claimed()
  const result = await reconcileRun(codexHost(OPEN), late, { release: true })
  expect(result).toMatchObject({ isChanged: true, text: expect.stringContaining('was not merged: After inspection, the merge was not applied') })
  expect(late.merge).toBeUndefined()
  expect(late.tasks[0]!.status).toBe('green')
})

test('reconcile refuses a run with no claim and a pull request that does not read, in the words the Codex script prints', async () => {
  const none = claimed()
  delete none.merge
  await expect(reconcileRun(codexHost(MERGED), none, {})).rejects.toThrow('No merge claim needs reconciliation.')
  await expect(reconcileRun(codexHost({ '/pulls/12': { nope: true } }), claimed(), {})).rejects.toThrow('Cannot read the PR.')
  await expect(reconcileRun(codexHost({}), claimed(), {})).rejects.toThrow('gh: Not Found')
})

test('the mod host and the Codex host give the same reconcile result for one recorded transcript', async () => {
  const transcript: [string, Recorded, { release?: unknown }, number][] = [
    ['merged', MERGED, {}, NOW],
    ['open, kept', OPEN, {}, NOW],
    ['open, released', OPEN, { release: true }, NOW],
  ]
  for (const [name, recorded, input, now] of transcript) {
    const fromCodex = claimed()
    const fromMod = claimed()
    const modStyle = { ...modHost(recorded), now: () => now }
    const a = await reconcileRun(codexHost(recorded, now), fromCodex, input)
    const b = await reconcileRun(modStyle, fromMod, input)
    expect(b, name).toEqual(a)
    expect(fromMod, name).toEqual(fromCodex)
  }
  // A host that cannot ask says why, in the one place: the module throws it.
  await expect(reconcileRun({ github: async () => ({ error: 'no answer within 15 s' }), now: () => NOW }, claimed(), {})).rejects.toThrow('no answer within 15 s')
})
