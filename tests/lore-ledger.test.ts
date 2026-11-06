import { describe, expect, mock, test } from 'claude-code/testing'

import { parseLedger } from '../hooks/ledger'
import { addTask, assignProblem, updateTask } from '../hooks/signals'
import type { Caller, Raw } from '../hooks/signals'
import { LEDGER, NOW, withTask } from './fixture'
import { REV_RUN, REV_T1 } from './lore-output'
import { file, ledgerPath, start, world } from './world'

const ORCHESTRATOR: Caller = { kind: 'orchestrator' }
const AT = '2026-10-09T10:30:00.000Z'
const raw = (): Raw => JSON.parse(JSON.stringify(LEDGER)) as Raw
const refused = (ledger: unknown): string => parseLedger(JSON.stringify(ledger)).error ?? 'accepted'
const KEY_PATTERN = '^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$'

describe('the ledger, for Lore and Linear', () => {
  test('a ledger from before this change still reads', () => {
    expect(parseLedger(JSON.stringify(LEDGER)).ledger).toEqual(LEDGER)
  })

  test('a Linear key is a ticket, a lowercase or malformed key is not', () => {
    expect(refused(withTask('t392-1', { ticket: 'ABC-12' }))).toBe('accepted')
    for (const bad of ['abc-12', 'ABC-0', 'ABC', 'ABC-12x']) {
      expect(refused(withTask('t392-1', { ticket: bad as never }))).toBe(
        `tasks[4].ticket: expected a whole number from 1 or an issue key like ABC-12, got ${JSON.stringify(bad)}`,
      )
    }
  })

  test('a task id is a plain name: it becomes part of a folder\'s path', () => {
    for (const bad of ['../x', 'a/b', '.hidden', '']) {
      expect(refused(withTask('t392-1', { id: bad }))).toContain('tasks[4].id: expected letters, digits, _ and - (at most 64)')
    }
  })

  test('a revision is 64 hex', () => {
    expect(refused(withTask('t392-1', { revision: REV_T1 }))).toBe('accepted')
    expect(refused(withTask('t392-1', { revision: REV_T1.slice(0, 40) }))).toContain('tasks[4].revision: expected a Lore revision (64 hex)')
  })

  test('a Lore merge claim needs revision and target; a GitHub one still reads', () => {
    const claim = { task: 't395-1', revision: REV_T1, target: 'run', state: 'merging', startedAt: AT }
    expect(refused({ ...LEDGER, merge: claim })).toBe('accepted')
    expect(refused({ ...LEDGER, merge: { ...claim, target: undefined } })).toContain('merge.target')
    expect(refused({ ...LEDGER, merge: { task: 't395-1', state: 'merging', startedAt: AT } })).toContain('merge.pr')
    expect(refused({ ...LEDGER, merge: { task: 't395-1', pr: 548, head: 'b'.repeat(40), state: 'merging', startedAt: AT } })).toBe('accepted')
  })

  test('a run keeps its Lore branch, approval, frozen config and Linear issue', () => {
    const run = {
      ...LEDGER.run,
      tickets: 'linear',
      issue: 'ABC-12',
      config: { tickets: 'linear', lore: { branchPrefix: 'eng/' } },
      lore: { remote: 'lores://lore.example.test:41337', repository: 'game', base: 'main', branch: 'eng/ABC-12-x', baseAt: REV_RUN },
      approval: { revision: REV_T1, base: REV_RUN, at: AT },
      merged: { revision: REV_RUN, at: AT },
      check: { revision: REV_T1, verdict: 'passed', at: AT },
    }
    const read = parseLedger(JSON.stringify({ ...LEDGER, run })).ledger
    expect(read?.run).toMatchObject(run)
    expect(refused({ ...LEDGER, run: { ...run, tickets: 'jira' } })).toContain('run.tickets')
    expect(refused({ ...LEDGER, run: { ...run, approval: { ...run.approval, revision: 'x' } } })).toContain('run.approval.revision')
    expect(refused({ ...LEDGER, run: { ...run, issue: 'abc' } })).toContain('run.issue')
  })

  test('a task keeps its workspace and its check', () => {
    expect(refused(withTask('t392-1', { workspace: '/work/Big Game 5.8.conductor/demo/t392-1', check: { revision: REV_T1, verdict: 'running', at: AT } }))).toBe('accepted')
    expect(refused(withTask('t392-1', { check: { revision: REV_T1, verdict: 'maybe', at: AT } as never }))).toContain('tasks[4].check.verdict')
  })
})

describe('tickets that are Linear keys', () => {
  test('task_add and task_update take a Linear key', () => {
    const ledger = raw()
    expect(addTask(ledger, ORCHESTRATOR, { id: 't9', title: 'Nine', tier: 'haiku', tierReason: 'small', ticket: 'ABC-12' }).isError).toBe(false)
    expect(ledger.tasks.find(one => one.id === 't9')?.ticket).toBe('ABC-12')
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't9', ticket: 'ABC-13' }).isError).toBe(false)
    expect(ledger.tasks.find(one => one.id === 't9')?.ticket).toBe('ABC-13')
    expect(addTask(ledger, ORCHESTRATOR, { id: 't10', title: 'Ten', tier: 'haiku', tierReason: 'small', ticket: 'abc-1' }).text).toBe(
      'ticket is the issue’s number, a whole number from 1, or its Linear key, like ABC-12.',
    )
  })

  test('problem_assign finds the task carrying a key, and names it without #', () => {
    const ledger = raw()
    addTask(ledger, ORCHESTRATOR, { id: 't9', title: 'Nine', tier: 'haiku', tierReason: 'small', ticket: 'ABC-12' })
    const said = assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', ticket: 'ABC-12' })
    expect(said.isError).toBe(false)
    expect(said.text).toBe('P2 is addressed by t9 (queued, ticket ABC-12).')
  })

  test('a number is still a ticket, said with #', () => {
    const ledger = raw()
    expect(assignProblem(ledger, ORCHESTRATOR, { problem: 'P2', task: 't391-1' }).text).toBe('P2 is addressed by t391-1 (building, ticket #391).')
  })

  test('the schemas take an integer or a key', async ($, on) => {
    mock.clock(on, { now: NOW })
    const engine = world(on, { [ledgerPath('demo')]: file(LEDGER, 1) })
    await start($)
    const ticketOf = (tool: string) => (engine.schemas[tool] as { properties: Record<string, unknown> }).properties.ticket
    const either = { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: KEY_PATTERN }] }
    expect(ticketOf('task_add')).toMatchObject(either)
    expect(ticketOf('task_update')).toMatchObject(either)
    expect(ticketOf('problem_assign')).toMatchObject(either)
  })
})
