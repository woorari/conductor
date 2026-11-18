import { expect, test } from 'claude-code/testing'

import type { ApprovalHost } from '../hooks/approvals'
import { bringBaseIn, landOnBase, mergeRun, mergeRunMain } from '../hooks/land'
import type { ApproveJob, LandHost, LandWork, Said } from '../hooks/land'
import type { Outcome, Raw } from '../hooks/signals'
import type { Ledger } from '../types'
import { MERGE_CLEAN, MERGE_CONFLICT, MERGE_INTO_DONE, PROTECTED, PUSH_RUN, REV_ON_MAIN, REV_RUN, STATUS_CLEAN, UNPROTECTED } from './lore-output'
import { RUN, RUN_BRANCH, lored, task } from './lore-world'
import { MAIN as MAIN_SHA, ci, pull } from './world'

const HEAD = 'b'.repeat(40)
const NOW = Date.parse('2026-11-18T10:10:00.000Z')
const GREEN_TASK = { id: 't1', title: 'One', tier: 'sonnet', status: 'green', files: ['a.ts'], pr: 7 }
const GITHUB: Ledger = {
  version: 1,
  run: { id: 'demo', title: 'Demo', source: '#1', startedAt: '2026-11-18T08:00:00Z' },
  problems: [],
  posts: [],
  rulings: [],
  tasks: [GREEN_TASK as Ledger['tasks'][number]],
}

type Recorded = Record<string, unknown>
const answered = (json: unknown, status = 200) => ({ status, json, text: JSON.stringify(json) })
const NO_STATUS = { state: 'pending', total_count: 0, statuses: [] }
const runs = (list: ReturnType<typeof ci>) => ({ total_count: list.length, check_runs: list })

/** A merge's GitHub: the pull request, its checks and the base's, as recorded. */
function forge(over: { pull?: ReturnType<typeof pull>; head?: string } = {}): Recorded {
  const head = over.head ?? HEAD

  return {
    '/pulls/7': over.pull ?? pull(head),
    '/branches/main': { commit: { sha: MAIN_SHA } },
    [`/commits/${head}/check-runs?per_page=100`]: runs(ci('success')),
    [`/commits/${head}/status?per_page=100`]: NO_STATUS,
    [`/commits/${MAIN_SHA}/check-runs?per_page=100`]: runs(ci('success')),
    [`/commits/${MAIN_SHA}/status?per_page=100`]: NO_STATUS,
  }
}

/** A host over one ledger held in memory and a recorded GitHub; every request and call is noted. */
function hostOf(ledger: Ledger, recorded: Recorded, lore: (args: string[]) => { exitCode?: number; out?: string } = () => ({})) {
  const state: { raw: Raw } = { raw: JSON.parse(JSON.stringify(ledger)) as Raw }
  const requests: string[] = []
  const lores: string[] = []
  const works: LandWork[] = []
  const removed: string[] = []
  const checks: string[] = []
  const host: LandHost = {
    base: async () => 'main',
    repo: () => 'acme/widgets',
    github: async (path, init) => {
      requests.push(`${init?.method ?? 'GET'} ${path}`)
      if (init?.method === 'PUT') return answered({ message: 'Pull Request successfully merged' })
      return path in recorded ? answered(recorded[path]) : answered({ message: 'Not Found' }, 404)
    },
    runsDir: () => undefined,
    list: async () => [],
    read: async () => JSON.stringify(state.raw),
    mutate: async (_path, change) => {
      const out = change(state.raw)

      return { value: out.value }
    },
    redraw: async () => undefined,
    carry: (_outcome: Outcome) => undefined,
    steps: {
      lore: async (args: string[]) => {
        lores.push(args.join(' '))
        const said = lore(args)

        return { exitCode: said.exitCode ?? 0, out: said.out ?? '', err: '' }
      },
      remove: async (path: string) => void removed.push(path),
      readText: async () => JSON.stringify(state.raw),
    } as unknown as LandHost['steps'],
    approvals: {
      boundLedger: async () => '/runs/ledger.json',
      unbound: async () => 'This session is bound to no run.',
      read: async () => JSON.stringify(state.raw),
    } as unknown as ApprovalHost,
    now: async () => NOW,
    caller: agentId => (agentId === undefined ? { kind: 'orchestrator' } : { kind: 'stranger' }),
    remember: async () => undefined,
    retireWorktree: async () => undefined,
    issueDone: async () => undefined,
    moveIssue: async () => undefined,
    method: () => 'squash',
    hereRoot: async () => null,
    copiedIn: async () => new Set(),
    startCheck: async (_path, _ledger, target) => void checks.push(target.revision),
    outlasting: async (_key, work) => {
      works.push(work)

      return undefined
    },
  }

  return { host, state, requests, lores, works, removed, checks }
}

const CALL = { tool: 'mcp__conductor__merge', task: 't1', told: [] }

test('check-only reports what would block and merges nothing', async () => {
  const { host, state, requests } = hostOf({ ...GITHUB, tasks: [{ ...GREEN_TASK, status: 'review' } as Ledger['tasks'][number]] }, forge())
  const said = await mergeRun(host, '/runs/ledger.json', { ...CALL, tool: 'mcp__conductor__merge_check' }, true)
  expect(said.isError).toBeUndefined()
  expect(said.text).toContain('t1 cannot merge yet:')
  expect(said.text).toContain('t1 is review')
  expect(requests.every(one => one.startsWith('GET '))).toBe(true)
  expect(state.raw.merge).toBeUndefined()
})

test('check-only on a task that may merge says so, and still sends no merge', async () => {
  const { host, requests } = hostOf(GITHUB, forge())
  const said = await mergeRun(host, '/runs/ledger.json', { ...CALL, tool: 'mcp__conductor__merge_check' }, true)
  expect(said.text).toContain('t1 may merge now. PR 7 is open and mergeable into main')
  expect(said.text).toContain('GitHub would merge it with its squash method')
  expect(requests.some(one => one.startsWith('PUT'))).toBe(false)
})

test('a merge into a protected base needs the approval recorded for its head, and sends nothing without it', async () => {
  const { host, state, requests } = hostOf(GITHUB, forge())
  const said = await mergeRun(host, '/runs/ledger.json', CALL, false)
  expect(said.isError).toBe(true)
  expect(said.text).toBe(`Not done. Nothing was merged. Main/base merge needs owner approval: /approve-merge t1 ${HEAD}.`)
  expect(requests.some(one => one.startsWith('PUT'))).toBe(false)
  expect(state.raw.merge).toBeUndefined()
})

test('a merge with the approval claims, merges pinned to the graded head, and records what GitHub says', async () => {
  const ledger: Ledger = { ...GITHUB, run: { ...GITHUB.run, mergeApprovals: { t1: { pr: 7, head: HEAD, base: 'main', at: '2026-11-18T09:00:00Z' } } } as Ledger['run'] }
  const recorded = forge()
  const { host, state, requests } = hostOf(ledger, recorded)
  // GitHub merges when asked: the pull request read afterwards is merged.
  const github = host.github
  host.github = async (path, init) => {
    const answer = await github(path, init)
    if (init?.method === 'PUT') recorded['/pulls/7'] = pull(HEAD, { merged: true, state: 'closed' })
    return answer
  }
  const said = await mergeRun(host, '/runs/ledger.json', CALL, false)
  expect(said.isError).toBeUndefined()
  expect(requests.filter(one => one.startsWith('PUT'))).toEqual(['PUT /pulls/7/merge'])
  expect(state.raw.tasks.find(one => one.id === 't1')?.status).toBe('done')
})

test('a merge that GitHub refuses lets the claim go and says what it answered', async () => {
  const ledger: Ledger = { ...GITHUB, run: { ...GITHUB.run, mergeApprovals: { t1: { pr: 7, head: HEAD, base: 'main', at: '2026-11-18T09:00:00Z' } } } as Ledger['run'] }
  const { host, state } = hostOf(ledger, forge())
  const said = await mergeRun(host, '/runs/ledger.json', CALL, false)
  expect(said.isError).toBe(true)
  expect(said.text).toContain('GitHub did not merge PR 7 (HTTP 200: Pull Request successfully merged)')
  expect(state.raw.merge).toBeUndefined()
})

const LORE_BASE: Ledger = {
  ...RUN,
  run: {
    ...RUN.run,
    plan: 'approved',
    delivery: 'complete',
    deliveryBase: 'main',
    lore: { ...RUN.run.lore!, workspace: '/work/run', baseAt: REV_ON_MAIN, head: REV_RUN },
  } as Ledger['run'],
  tasks: [task('t1', { status: 'done' })],
}
const infoOf = (branch: string, rev: string) => `Branch ${branch}\n  ID: e726318bbc3fd75ac8733a7e030cc35b\n  Latest: ${rev}\n  Remote Latest: ${rev}\n`

test('landOnBase refuses when checks are red: the run cannot go into the base, and nothing is claimed or merged', async () => {
  const red: Ledger = {
    ...LORE_BASE,
    run: { ...LORE_BASE.run, config: { check: { argv: ['make', 'test'], timeoutMin: 5 } }, check: { revision: REV_RUN, verdict: 'failed', at: '2026-11-18T10:00:00.000Z' } } as unknown as Ledger['run'],
  }
  const { host, state, lores, works } = hostOf(red, {}, args => (args[1] === 'info' ? { out: infoOf(args[2]!, args[2] === 'main' ? REV_ON_MAIN : REV_RUN) } : {}))
  const text = await mergeRunMain(host, false)
  expect(text).toContain('The run cannot go into main yet:')
  expect(text).toContain('the check (make test) has not passed')
  expect(state.raw.merge).toBeUndefined()
  expect(lores.every(one => one.startsWith('branch info'))).toBe(true)
  expect(works).toEqual([])
})

test('a run whose checks passed is claimed and handed to the session to land', async () => {
  const { host, state, works } = hostOf(LORE_BASE, {}, args => (args[1] === 'info' ? { out: infoOf(args[2]!, args[2] === 'main' ? REV_ON_MAIN : REV_RUN) } : {}))
  const text = await mergeRunMain(host, false)
  expect(text).toContain('is merging into main, and it goes on in the background')
  expect(works).toHaveLength(1)
  expect(works[0]).toMatchObject({ kind: 'approve', job: { base: 'main', head: REV_RUN, baseNow: REV_ON_MAIN } })
  expect(state.raw.merge).toMatchObject({ task: RUN.run.id, target: 'base' })
})

test('landOnBase says why nothing was merged when the run branch moved after the approval', async () => {
  const { host, lores } = hostOf(LORE_BASE, {}, args => (args[0] === 'status' ? { out: STATUS_CLEAN } : {}))
  const job: ApproveJob = { path: '/runs/ledger.json', ledger: LORE_BASE, runLore: LORE_BASE.run.lore!, run: '/work/run', base: 'main', head: REV_RUN, baseNow: REV_ON_MAIN, at: '2026-11-18T10:10:00.000Z' }
  const text = await landOnBase(host, job)
  expect(text).toContain(`${RUN_BRANCH} moved after the approval`)
  expect(lores).toEqual([`branch switch ${RUN_BRANCH} --reset`, 'status'])
})

test('landOnBase merges, protects the base again and archives the task branches', async () => {
  const withBranch: Ledger = { ...LORE_BASE, tasks: [task('t1', { status: 'done', branch: `${RUN_BRANCH}/t1` })] }
  const { host, state, lores } = hostOf(withBranch, {}, args => {
    const line = args.join(' ')
    if (line === 'status') return { out: STATUS_CLEAN.replace(/revision 2 -> \w+/, `revision 2 -> ${REV_RUN}`).replace(/Remote revision 2 -> \w+/, `Remote revision 2 -> ${REV_RUN}`) }
    if (line === 'branch unprotect main') return { out: UNPROTECTED }
    if (line === 'branch info main') return { out: infoOf('main', REV_ON_MAIN) }
    if (line.startsWith('branch merge into')) return { out: MERGE_INTO_DONE }
    if (line === 'branch protect main') return { out: PROTECTED }
    return {}
  })
  const job: ApproveJob = { path: '/runs/ledger.json', ledger: withBranch, runLore: withBranch.run.lore!, run: '/work/run', base: 'main', head: REV_RUN, baseNow: REV_ON_MAIN, at: '2026-11-18T10:10:00.000Z' }
  state.raw.merge = { task: RUN.run.id, revision: REV_RUN, target: 'base', state: 'merging', startedAt: job.at }
  const text = await landOnBase(host, job)
  expect(lores.at(-2)).toBe('branch protect main')
  expect(lores.at(-1)).toBe(`branch archive ${RUN_BRANCH}/t1`)
  expect(text).toContain("Its tasks' branches are archived.")
})

test('bringBaseIn stops on a conflict and says which files', async () => {
  const { host, state, lores, checks } = hostOf(LORE_BASE, {}, args => (args[1] === 'merge' && args[2] === 'main' ? { exitCode: 1, out: MERGE_CONFLICT } : {}))
  state.raw.merge = { task: 'main', revision: REV_ON_MAIN, target: 'sync', state: 'merging', startedAt: '2026-11-18T10:00:00.000Z' }
  const said: Said = await bringBaseIn(host, { path: '/runs/ledger.json', base: 'main', baseNow: REV_ON_MAIN, runHead: REV_RUN, run: '/work/run', runLore: LORE_BASE.run.lore! })
  expect(said.isError).toBe(true)
  expect(said.text).toContain(`main conflicts with ${RUN_BRANCH} in: a.txt. Nothing was merged; it is a blocker on the board.`)
  expect(lores.at(-1)).toBe('branch merge abort')
  expect(state.raw.merge).toBeUndefined()
  expect(state.raw.problems).toMatchObject([{ severity: 'blocker' }])
  expect(checks).toEqual([])
})

test('bringBaseIn that goes through pushes, records the head and starts the check', async () => {
  const { host, state, checks } = hostOf(LORE_BASE, {}, args => (args[1] === 'merge' && args[2] === 'main' ? { out: MERGE_CLEAN.replace(/revision \w+/, `revision ${REV_ON_MAIN}`) } : args[0] === 'push' ? { out: PUSH_RUN } : {}))
  state.raw.merge = { task: 'main', revision: REV_ON_MAIN, target: 'sync', state: 'merging', startedAt: '2026-11-18T10:00:00.000Z' }
  const said = await bringBaseIn(host, { path: '/runs/ledger.json', base: 'main', baseNow: REV_ON_MAIN, runHead: REV_RUN, run: '/work/run', runLore: LORE_BASE.run.lore! })
  expect(said.isError).toBeUndefined()
  expect(said.text).toContain(`Brought main into ${RUN_BRANCH} as`)
  expect(checks).toHaveLength(1)
})

test('a Lore-backed run is not sent to GitHub', async ($, on) => {
  const { engine } = await lored($, on)
  const call = ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ text?: string }>)
  await call({ tool: 'mcp__conductor__merge_check', tool_use_id: 'call-check', task: 't1' })
  expect(engine.forge.asked).toEqual([])
})
