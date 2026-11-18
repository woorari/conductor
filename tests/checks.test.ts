import { expect, test } from 'claude-code/testing'

import type { Ledger } from '../types'
import { CHECK_SCRIPT, checkLog, checkOnGreen, nextCheck, runCheck, startCheck, watchChecks } from '../hooks/checks'
import type { CheckHost } from '../hooks/checks'
import { REV_MAIN, REV_T1, STATUS_CLEAN } from './lore-output'

const HOME = '/work/Game'
const PATH = `${HOME}/.claude/conductor/runs/R-1/ledger.json`
const NOW = Date.parse('2026-10-09T10:00:00.000Z')
const CHECK = { argv: ['./check.sh', '--fast'], timeoutMin: 20 }
const BASE: Ledger = {
  version: 1,
  run: {
    id: 'R-1',
    title: 'Run',
    source: 'R-1',
    plan: 'approved',
    startedAt: '2026-10-09T09:00:00.000Z',
    config: { check: CHECK },
    lore: { remote: 'lores://x', repository: 'r', base: 'main', branch: 'conductor/R-1' },
  },
  tasks: [{ id: 't1', title: 'T', tier: 'sonnet', tierReason: 'r', status: 'green', files: [], revision: REV_T1, workspace: `${HOME}.conductor/t1` }],
  problems: [],
  posts: [],
  rulings: [],
} as unknown as Ledger

/** A fake host over one ledger and a table of files; records every program, lore call and told line. */
function fake(ledger: Ledger, over: { files?: Record<string, string>; now?: number; atRevision?: string; workspaceError?: string; startExit?: number } = {}) {
  const files: Record<string, string> = { [PATH]: JSON.stringify(ledger), ...over.files }
  const calls: string[] = []
  const told: string[] = []
  let now = over.now ?? NOW
  const host: CheckHost = {
    now: async () => now,
    read: async path => files[path],
    run: async (argv, ms, env) => {
      calls.push(`run ${argv.join(' ')}${env === undefined ? '' : ` OUT=${env.OUT}`}${ms === undefined ? '' : ` ${ms}`}`)

      return { exitCode: argv[0] === '/bin/sh' ? (over.startExit ?? 0) : 0, out: '' }
    },
    lore: async (args, cwd) => {
      calls.push(`lore ${args.join(' ')} @${cwd}`)

      return { exitCode: 0, out: args[0] === 'status' ? STATUS_CLEAN.replaceAll(REV_T1, over.atRevision ?? REV_T1) : '' }
    },
    mutate: async (path, change) => {
      const raw = JSON.parse(files[path] ?? '{}')
      const said = change(raw)
      if (said.isChanged) files[path] = JSON.stringify(raw)

      return { value: said.value }
    },
    ledgerPath: async () => PATH,
    backend: async () => ({ kind: 'lore', root: HOME }),
    runsRoot: async fallback => fallback,
    workspace: async making => {
      calls.push(`workspace ${making.path} ${making.branch} ${making.taskId}`)

      return over.workspaceError === undefined ? {} : { error: over.workspaceError }
    },
    tell: text => void told.push(text),
  }

  return { host, files, calls, told, advance: (ms: number) => void (now += ms), stored: () => JSON.parse(files[PATH] ?? '{}') as Ledger }
}
const LOG = checkLog(HOME, 'R-1', 't1', REV_T1)
const JOB = { taskId: 't1', cwd: '', revision: REV_T1 }

test('a check that exits 0 records a pass', async () => {
  const world = fake(BASE)
  await startCheck(world.host, PATH, BASE, JOB)
  expect(world.stored().tasks[0]?.check).toEqual({ revision: REV_T1, verdict: 'running', at: '2026-10-09T10:00:00.000Z' })
  expect(world.calls).toContain(`run /bin/sh -c ${CHECK_SCRIPT} sh ${HOME}.conductor/R-1/_check -- ./check.sh --fast OUT=${LOG} 30000`)
  world.files[`${LOG}.exit`] = '0\n'
  world.advance(5_000)
  await watchChecks(world.host)
  expect(world.stored().tasks[0]?.check).toEqual({ revision: REV_T1, verdict: 'passed', at: '2026-10-09T10:00:05.000Z' })
  expect(world.told).toEqual([`Run board: the check on t1 passed (${REV_T1.slice(0, 7)}).`])
})

test('a non-zero exit records a fail with the log tail', async () => {
  const world = fake(BASE)
  await startCheck(world.host, PATH, BASE, JOB)
  world.files[`${LOG}.exit`] = '3\n'
  world.files[LOG] = 'building\n2 tests "failed"\n\n'
  await watchChecks(world.host)
  expect(world.stored().tasks[0]?.check).toMatchObject({ verdict: 'failed', line: '2 tests "failed"' })
  expect(world.told[0]).toContain(`"2 tests 'failed'"`)
})

test('a timeout records a timeout and kills the process group', async () => {
  const world = fake(BASE)
  await startCheck(world.host, PATH, BASE, JOB)
  world.files[`${LOG}.pid`] = '4242\n'
  world.advance(20 * 60_000 + 1)
  await watchChecks(world.host)
  expect(world.calls).toContain('run kill -TERM -- -4242')
  expect(world.stored().tasks[0]?.check).toMatchObject({ verdict: 'failed', line: 'timed out after 20 min' })
})

test('a check inside its time is left running', async () => {
  const world = fake(BASE)
  await startCheck(world.host, PATH, BASE, JOB)
  world.advance(60_000)
  await watchChecks(world.host)
  expect(world.stored().tasks[0]?.check?.verdict).toBe('running')
  expect(world.told).toEqual([])
})

test('a second start for the same task is refused while one runs', async () => {
  const world = fake(BASE)
  await Promise.all([startCheck(world.host, PATH, BASE, JOB), startCheck(world.host, PATH, BASE, JOB)])
  expect(world.calls.filter(one => one.startsWith('run /bin/sh'))).toHaveLength(1)
  expect(world.calls.filter(one => one.startsWith('workspace'))).toHaveLength(1)
})

test('a start that cannot make its workspace, put it at the revision or run is recorded as failed', async () => {
  const noWorkspace = fake(BASE, { workspaceError: 'no disk' })
  await startCheck(noWorkspace.host, PATH, BASE, JOB)
  expect(noWorkspace.stored().tasks[0]?.check).toMatchObject({ verdict: 'failed', line: 'the check workspace could not be made: no disk' })
  const wrongRevision = fake(BASE, { atRevision: REV_MAIN })
  await startCheck(wrongRevision.host, PATH, BASE, JOB)
  expect(wrongRevision.stored().tasks[0]?.check?.line).toContain(`could not be put at ${REV_T1.slice(0, 7)}`)
  const noStart = fake(BASE, { startExit: 97 })
  await startCheck(noStart.host, PATH, BASE, JOB)
  expect(noStart.stored().tasks[0]?.check?.line).toContain('the check could not start')
})

test('checkOnGreen starts a check only when the task is green', async () => {
  const review = { ...BASE, tasks: [{ ...BASE.tasks[0]!, status: 'review' as const }] }
  const waiting = fake(review)
  await checkOnGreen(waiting.host, 't1')
  expect(waiting.stored().tasks[0]?.check).toBeUndefined()
  const green = fake(BASE)
  await checkOnGreen(green.host, 'nobody')
  await checkOnGreen(green.host, 7)
  expect(green.stored().tasks[0]?.check).toBeUndefined()
  await checkOnGreen(green.host, 't1')
  expect(green.stored().tasks[0]?.check?.verdict).toBe('running')
  // One already running or passed on this revision is not started again; a failed one is.
  const before = green.calls.length
  await checkOnGreen(green.host, 't1')
  expect(green.calls.length).toBe(before)
})

test('nextCheck starts the run branch check once every task is merged, and runCheck refuses what is not due', async () => {
  const done = { ...BASE, run: { ...BASE.run, lore: { ...BASE.run.lore!, head: REV_MAIN } }, tasks: [{ ...BASE.tasks[0]!, status: 'done' as const }] }
  const world = fake(done, { atRevision: REV_MAIN })
  await nextCheck(world.host, PATH)
  expect(world.stored().run.check).toMatchObject({ revision: REV_MAIN, verdict: 'running' })
  expect(await runCheck(fake(BASE).host, PATH, undefined)).toEqual({ error: "The run branch's check runs once every task is merged into it." })
  expect(await runCheck(fake(BASE).host, PATH, 'zzz')).toEqual({ error: 'zzz is no green task with a revision: a check runs on what you judged green.' })
  const again = fake(BASE)
  expect(await runCheck(again.host, PATH, 't1')).toEqual({ text: 'The check on t1 is started again.' })
})
