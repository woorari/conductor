import { describe, expect, test } from 'claude-code/testing'

import { boardView, detail, elapsed, summary } from '../hooks/board'
import { parseLedger } from '../hooks/ledger'
import { LEDGER, NOW, withTask } from './fixture'

const ids = (rows: readonly { id: string }[]): string[] => rows.map(row => row.id)
const refused = (ledger: unknown): string => parseLedger(JSON.stringify(ledger)).error ?? 'accepted'

describe('parseLedger', () => {
  test('reads a valid ledger back as it was written', () => {
    expect(parseLedger(JSON.stringify(LEDGER)).ledger).toEqual(LEDGER)
  })

  test('leaves out fields it does not know, without refusing the file', () => {
    const parsed = parseLedger(JSON.stringify({ ...LEDGER, extras: [{ id: 'X1' }] }))
    expect(parsed.ledger).toEqual(LEDGER)
  })

  test('says a half-written file is not JSON', () => {
    expect(parseLedger('{"version": 1, "run": {').error).toContain('not valid JSON')
  })

  test('names the field and the allowed values for an unknown tier', () => {
    expect(refused(withTask('t392-1', { tier: 'gpt' as never }))).toBe(
      'tasks[4].tier: expected opus, sonnet or haiku, got "gpt"',
    )
  })

  test('refuses another version', () => {
    expect(refused({ ...LEDGER, version: 2 })).toBe('version: expected 1, got 2')
  })

  test('refuses a task id used twice', () => {
    expect(refused(withTask('t392-1', { id: 't390-1' }))).toContain('"t390-1" is used twice')
  })

  test('refuses a dependency on a task the run does not have', () => {
    expect(refused(withTask('t392-1', { dependsOn: ['t999'] }))).toBe(
      'task t392-1: dependsOn names "t999", which is no task of this run',
    )
  })

  test('refuses tasks that wait on each other', () => {
    expect(refused(withTask('t392-1', { dependsOn: ['t392-2'] }))).toContain('t392-1 -> t392-2 -> t392-1')
  })

  test('refuses a start time that is no time', () => {
    expect(refused(withTask('t391-1', { startedAt: 'this morning' }))).toContain('tasks[2].startedAt')
  })

  test('refuses a run id that could leave the runs folder', () => {
    expect(refused({ ...LEDGER, run: { ...LEDGER.run, id: '../x' } })).toContain('run.id')
  })
})

describe('boardView', () => {
  const view = boardView(LEDGER, NOW)

  test('sorts every task into exactly one section', () => {
    expect(ids(view.building)).toEqual(['t391-1', 't394-1'])
    expect(ids(view.attention)).toEqual(['t396-1'])
    expect(ids(view.next)).toEqual(['t392-1'])
    expect(ids(view.waiting)).toEqual(['t392-2'])
    const shown = [view.building, view.attention, view.review, view.next, view.waiting, view.done]
    expect(shown.flat().length).toBe(LEDGER.tasks.length)
  })

  test('puts a task ready to merge ahead of one in review', () => {
    expect(ids(view.review)).toEqual(['t395-1', 't393-1'])
  })

  test('lists finished tasks newest first', () => {
    expect(ids(view.done)).toEqual(['t390-2', 't390-1'])
  })

  test('says which unfinished tasks a queued one waits for', () => {
    expect(view.waiting[0]?.waitsFor).toEqual(['t391-1', 't392-1'])
  })

  test('moves a task to next once everything it waits for is done', () => {
    const later = boardView(
      { ...LEDGER, tasks: LEDGER.tasks.map(one => (one.id === 't392-2' ? one : { ...one, status: 'done' as const })) },
      NOW,
    )
    expect(ids(later.next)).toEqual(['t392-2'])
    expect(later.waiting).toEqual([])
  })

  test('shows open problems, blockers first, and counts the resolved', () => {
    expect(ids(view.problems)).toEqual(['P2', 'P1'])
    expect(view.resolved).toBe(1)
  })

  test('counts whole minutes since a building task started', () => {
    expect(view.building.map(row => row.minutes)).toEqual([12, 65])
  })

  test('shows no elapsed time before the clock has ticked', () => {
    expect(boardView(LEDGER, 0).building.map(row => row.minutes)).toEqual([undefined, undefined])
  })
})

describe('the lines the pane draws', () => {
  const view = boardView(LEDGER, NOW)

  test('the summary names every section that has something in it', () => {
    expect(summary(view)).toBe(
      '2 problems open (2 without a task) · 1 waiting for a decision · 2 building · 1 to merge · 1 in review · 1 next · 2 of 9 done',
    )
  })

  test('a building task says its tier, worker, time, ticket and what it is doing', () => {
    expect(detail(view.building[0]!)).toBe('sonnet · w391 · 12 min · ticket 391 · writing the middleware test')
  })

  test('a waiting task says what it waits for', () => {
    expect(detail(view.waiting[0]!)).toBe('sonnet · ticket 392 · after t391-1, t392-1')
  })

  test('a blocked task says so and why', () => {
    expect(detail(view.attention[0]!)).toBe('blocked · opus · w396 · ticket 396 · needs the second box')
  })

  test('elapsed time reads in minutes, then hours and minutes', () => {
    expect([0, 12, 60, 65].map(elapsed)).toEqual(['under 1 min', '12 min', '1 h 00 min', '1 h 05 min'])
  })
})

describe("parseLedger: a run's workspace in a home that is not a repository", () => {
  const WORKSPACE = { kind: 'lore', root: '/work/game/code/Big Game 5.8', place: 'game/code', base: 'main' } as const
  const CANDIDATES = [
    { kind: 'lore', root: '/work/game/code/Big Game 5.8', place: 'game/code', about: 'engine and game code' },
    { kind: 'git', root: '/work/game/code/tools', place: 'game/code', about: 'engine and game code' },
  ] as const
  const with_ = (run: Record<string, unknown>) => ({ ...LEDGER, run: { ...LEDGER.run, ...run } })

  test("ledger: a run's workspace and candidates are read and kept", () => {
    const ledger = with_({ workspace: { ...WORKSPACE, remote: 'git@github.com:acme/widgets.git' }, candidates: CANDIDATES })
    expect(parseLedger(JSON.stringify(ledger)).ledger).toEqual(ledger)
  })

  test("ledger: a workspace of another kind, or one not given by its absolute path, is refused", () => {
    expect(refused(with_({ workspace: { ...WORKSPACE, kind: 'svn' } }))).not.toBe('accepted')
    expect(refused(with_({ workspace: { ...WORKSPACE, root: 'game/code' } }))).not.toBe('accepted')
    expect(refused(with_({ candidates: [{ ...CANDIDATES[0], root: 'rel' }] }))).not.toBe('accepted')
    expect(refused(with_({ candidates: [{ ...CANDIDATES[0], kind: 'none' }] }))).not.toBe('accepted')
  })
})
