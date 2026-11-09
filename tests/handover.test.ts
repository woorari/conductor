import { describe, expect, test } from 'claude-code/testing'

import { boardView, detail, orchestratorLine } from '../hooks/board'
import { KEEP, ROTATE_AT, carried, handover } from '../hooks/handover'
import { parseLedger } from '../hooks/ledger'
import { post, rule } from '../hooks/posts'
import { gauge, heldUp, overweight, rotated, weigh } from '../hooks/signals'
import type { Raw } from '../hooks/signals'
import type { Ledger } from '../types'
import { LEDGER, NOW } from './fixture'

const AT = '2026-10-09T10:30:00.000Z'
const raw = (): Raw => JSON.parse(JSON.stringify(LEDGER)) as Raw
const parsed = (ledger: Raw): Ledger => parseLedger(JSON.stringify(ledger)).ledger!

describe('the handover', () => {
  function busy(): Ledger {
    const ledger = raw()
    Object.assign(ledger.tasks.find(one => one.id === 't391-1')!, { agentId: 'a391', branch: 'fix/391-pool', files: ['api/main.py'] })
    Object.assign(ledger.tasks.find(one => one.id === 't393-1')!, { agentId: 'a393' })
    post(ledger, AT, { kind: 'worker', taskId: 't394-1' }, { kind: 'finding', text: 'Stay outside CORS.', files: ['api/main.py'] })
    post(ledger, AT, { kind: 'worker', taskId: 't391-1' }, { kind: 'question', text: 'May the 503 carry a Retry-After of 2?' })
    rule(ledger, AT, { kind: 'orchestrator' }, { text: 'Rebase on main before the merge.', tasks: ['t393-1'] })

    return parsed(ledger)
  }

  test('says where every task stands, with the worker and the agent id that still reaches it after a restart', () => {
    const text = handover(busy(), { at: AT, percent: 72 })
    expect(text.split('\n').slice(0, 2)).toEqual([
      '# Run demo: Nightly import speed',
      "State of the run on 2026-10-09T10:30:00.000Z, with the orchestrator's context 72% full. Started from #334.",
    ])
    expect(text).toContain('- t391-1 [building, sonnet] Pool exhaustion answers 503 · worker w391 (agent a391) · branch fix/391-pool · ticket 391 · after t390-1 · note: writing the middleware test')
    expect(text).toContain('- t392-2 [queued, sonnet] Clients retry a busy read · ticket 392 · after t391-1, t392-1')
    expect(text.match(/^- t\d/gm)).toHaveLength(LEDGER.tasks.filter(one => one.status !== 'done').length)
  })

  test('names the done tasks on one line: what they held is merged and needs no rereading', () => {
    const text = handover(busy(), { at: AT })
    expect(text).toContain('\n- Done: t390-1, t390-2\n')
    expect(text).not.toContain('Settings module')
    expect(text).not.toContain('PR 541')
  })

  test('names on one line the rulings that bind only done tasks, and keeps the rest whole', () => {
    const ledger = raw()
    rule(ledger, AT, { kind: 'orchestrator' }, { text: 'Keep the settings flat.', tasks: ['t390-1', 't390-2'] })
    rule(ledger, AT, { kind: 'orchestrator' }, { text: 'Rebase on main before the merge.', tasks: ['t390-1', 't393-1'] })
    rule(ledger, AT, { kind: 'orchestrator' }, { text: 'No new dependencies.' })
    const text = handover(parsed(ledger), { at: AT })
    expect(text).toContain('## Rulings\n- R2: Rebase on main before the merge.\n- R3: No new dependencies.\n- R1 binds only done tasks.')
    expect(text).not.toContain('Keep the settings flat.')
  })

  test('says nothing of resolved problems', () => {
    const text = handover(busy(), { at: AT })
    for (const one of LEDGER.problems.filter(problem => problem.status === 'resolved')) expect(text, one.id).not.toContain(one.text)
  })

  test('carries the open problems, the open questions, the rulings and what nobody has read yet', () => {
    const text = handover(busy(), { at: AT })
    expect(text).toContain('## Open problems\n- P1 warning, no task: The shared api image lacks h2\n- P2 blocker (t391-1), no task: Pool timeout test fails on the CI runner')
    expect(text).not.toContain('openapi.json conflicted')
    expect(text).toContain('## Open questions\n- Q1 from t391-1: May the 503 carry a Retry-After of 2?')
    expect(text).toContain('## Rulings\n- R1: Rebase on main before the merge.')
    expect(text).toContain('## Not read yet\n- F1 for t391-1; R1 for t393-1')
    const ledger = busy()
    const closed: Ledger = { ...ledger, tasks: ledger.tasks.map(one => (one.id === 't393-1' ? { ...one, status: 'done' as const } : one)) }
    expect(handover(closed, { at: AT }), 'what waits for a finished task is nobody\'s to chase').toContain('## Not read yet\n- F1 for t391-1\n')
    expect(text).toContain('use the agent id listed with the task')
  })

  test('leaves out a section with nothing in it', () => {
    const quiet = handover(parsed({ ...raw(), problems: [] }), { at: AT })
    for (const heading of ['## Open problems', '## Open questions', '## Rulings', '## Not read yet']) expect(quiet, heading).not.toContain(heading)
    expect(quiet).toContain('## Tasks')
  })

  test('is carried into the conversation as the state that replaces the summary\'s', () => {
    expect(carried('# Run demo').split('\n\n')).toEqual([
      "The conductor mod carried the run's state over this compaction. It was read from the ledger just now and replaces whatever the summary above says about tasks, workers, problems or rulings.",
      '# Run demo',
    ])
    expect(KEEP).toContain('leave all of it out')
    expect(ROTATE_AT).toBe(70)
  })
})

describe('what the ledger remembers of contexts', () => {
  test('the orchestrator\'s reading is written when the whole percent moved', () => {
    const ledger = raw()
    expect(gauge(ledger, AT, 43.4)).toBe(true)
    expect(ledger.orchestrator).toEqual({ contextPercent: 43, measuredAt: AT })
    expect(gauge(ledger, AT, 43.2), 'the same whole percent').toBe(false)
    expect(gauge(ledger, AT, 44.6)).toBe(true)
    expect(parseLedger(JSON.stringify(ledger)).ledger?.orchestrator?.contextPercent).toBe(45)
  })

  test('each compaction with a handover is counted', () => {
    const ledger = raw()
    rotated(ledger, AT)
    rotated(ledger, AT)
    expect(ledger.orchestrator).toEqual({ rotations: 2, rotatedAt: AT })
  })

  test('a worker\'s context is written when it moved by a thousand tokens or more', () => {
    const ledger = raw()
    expect(weigh(ledger, 't391-1', 181_400)).toBe(true)
    expect(weigh(ledger, 't391-1', 181_900)).toBe(false)
    expect(weigh(ledger, 't391-1', 183_000)).toBe(true)
    expect(ledger.tasks.find(one => one.id === 't391-1')?.contextTokens).toBe(183_000)
    expect(weigh(ledger, 't390-1', 50_000), 'a finished task').toBe(false)
  })

  test('a worker is asked to hand back only past a limit the run itself sets', () => {
    const ledger = raw()
    expect(overweight(ledger, 't391-1', 900_000), 'no limit: nobody is asked').toBeUndefined()
    Object.assign(ledger.run as object, { workerHandbackTokens: 400_000 })
    expect(overweight(ledger, 't391-1', 399_000)).toBeUndefined()
    expect(overweight(ledger, 't391-1', 412_000)).toEqual({
      taskId: 't391-1',
      text: "Run board: your context holds about 412 thousand tokens, past this run's limit for a worker. At your next green step, commit and push, write in your task's note where you stopped, and hand back by ending your turn. A fresh worker goes on from your branch.",
    })
    expect(overweight(ledger, 't393-1', 900_000), 'a worker that is not building').toBeUndefined()
  })

  test('the board says how full the orchestrator is and how often it was compacted', () => {
    expect(orchestratorLine(undefined)).toBeUndefined()
    expect(orchestratorLine({ contextPercent: 43 })).toBe('Orchestrator 43% full')
    expect(orchestratorLine({ contextPercent: 12, rotations: 1 })).toBe('Orchestrator 12% full · compacted once')
    expect(orchestratorLine({ contextPercent: 30, rotations: 4 })).toBe('Orchestrator 30% full · compacted 4 times')
    const ledger = raw()
    weigh(ledger, 't391-1', 181_400)
    expect(detail(boardView(parsed(ledger), NOW).building[0]!)).toBe('sonnet · w391 · 12 min · 181k tokens · ticket 391 · writing the middleware test')
  })
})

describe('a compaction that is due and held up', () => {
  const LATER = '2026-10-09T10:45:00.000Z'

  test('the reason is kept with the moment it was first given, and written again only when it changes', () => {
    const ledger = raw()
    expect(heldUp(ledger, AT, 'session.compact: a turn is running')).toBe(true)
    expect(parsed(ledger).orchestrator?.held).toEqual({ since: AT, reason: 'session.compact: a turn is running' })
    expect(heldUp(ledger, LATER, 'session.compact: a turn is running'), 'the same reason again').toBe(false)
    expect(parsed(ledger).orchestrator?.held?.since).toBe(AT)
    expect(heldUp(ledger, LATER, 'an agent is at work'), 'another reason is news').toBe(true)
    expect(parsed(ledger).orchestrator?.held).toEqual({ since: LATER, reason: 'an agent is at work' })
  })

  test('a reason is one line of bounded length, and none is said as none', () => {
    const ledger = raw()
    heldUp(ledger, AT, `refused\n${'x'.repeat(400)}`)
    expect(parsed(ledger).orchestrator?.held?.reason).toHaveLength(240)
    expect(parsed(ledger).orchestrator?.held?.reason.startsWith('refused x')).toBe(true)
    heldUp(ledger, AT, '   ')
    expect(parsed(ledger).orchestrator?.held?.reason).toBe('no reason given')
  })

  test('it is over when the session was compacted, by the mod or by anyone', () => {
    const byMod = raw()
    heldUp(byMod, AT, 'a turn is running')
    rotated(byMod, LATER)
    expect(parsed(byMod).orchestrator).toEqual({ rotations: 1, rotatedAt: LATER })

    const byEngine = raw()
    gauge(byEngine, AT, 72)
    heldUp(byEngine, AT, 'a turn is running')
    gauge(byEngine, LATER, 74)
    expect(parsed(byEngine).orchestrator?.held, 'a fuller context is still held up').toBeDefined()
    gauge(byEngine, LATER, 15)
    expect(parsed(byEngine).orchestrator?.held).toBeUndefined()
  })

  test('the board says that it waits, and the handover says why', () => {
    const ledger = raw()
    gauge(ledger, AT, 71)
    heldUp(ledger, AT, 'a turn is running')
    expect(orchestratorLine(parsed(ledger).orchestrator)).toBe('Orchestrator 71% full · compaction waits')
    expect(handover(parsed(ledger), { at: LATER })).toContain(
      `This session is due for a compaction that has not gone through since ${AT}. The engine's reason: a turn is running. The mod tries again, and the owner can type /compact; until it is through, put what matters on the board.`,
    )
    expect(handover(parsed(raw()), { at: LATER })).not.toContain('due for a compaction')
  })

  test('a ledger whose held-up compaction has no time does not read', () => {
    const broken = { ...LEDGER, orchestrator: { held: { reason: 'x' } } }
    expect(parseLedger(JSON.stringify(broken)).error).toContain('orchestrator.held.since')
  })
})
