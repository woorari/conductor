import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { issueOf, issueText, linearKeyOf, stateFor } from '../hooks/linear'
import type { Ledger, Task } from '../types'
import { LEDGER, NOW, withTask } from './fixture'
import { LINEAR_TOKEN, ROOT, board, ci, file, ledgerPath, mergeCommit, pull, spawn, start, world } from './world'
import type { Files, LinearIssue, LinearState, World } from './world'

type Ran = { text?: string; isError?: true; deny?: string }
const raise = ($: Engine, input: Record<string, unknown>) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const call = ($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) =>
  raise($, { tool: `mcp__conductor__${tool}`, tool_use_id: `call-${tool}`, ...input, ...(agentId === undefined ? {} : { agentId }) })
const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const STATES: LinearState[] = [
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 's-review', name: 'In Review', type: 'started', position: 2 },
  { id: 's-progress', name: 'In Progress', type: 'started', position: 1 },
  { id: 's-done', name: 'Done', type: 'completed', position: 3 },
]
const TEAM = { id: 'team-abc', key: 'ABC', states: { nodes: STATES } }
const issue = (identifier: string, more: Partial<LinearIssue> = {}): LinearIssue => ({
  id: `issue-${identifier}`,
  identifier,
  title: `Title of ${identifier}`,
  description: `About ${identifier}.`,
  url: `https://linear.app/acme/issue/${identifier}`,
  state: { name: 'Todo', type: 'unstarted' },
  parent: null,
  children: { nodes: [] },
  comments: { nodes: [] },
  team: TEAM,
  ...more,
})

const CONFIG = `${ROOT}/.claude/conductor/config.json`
const PATH = ledgerPath('ABC-12')
const T1: Task = { id: 't1', title: 'One', tier: 'sonnet', tierReason: 'a change', status: 'queued', ticket: 'ABC-13', files: ['src/a.ts'] }
const RUN: Ledger = {
  version: 1,
  run: { id: 'ABC-12', title: 'Retry the flaky upload', source: 'ABC-12', plan: 'proposed', tickets: 'linear', startedAt: '2026-10-09T10:00:00.000Z' },
  tasks: [T1],
  problems: [],
  posts: [],
  rulings: [],
}
const stored = (files: Files, path = PATH): Ledger => JSON.parse(files[path]?.text ?? '{}') as Ledger

/** A session bound to a Linear run whose issue ABC-12 has one sub-issue, ABC-13. */
async function linearRun($: Engine, on: Parameters<typeof world>[0], ledger: Ledger = RUN, run = 'ABC-12') {
  mock.clock(on, { now: NOW })
  const files: Files = { [ledgerPath(run)]: file(ledger, 1), [CONFIG]: { text: '{"tickets": "linear", "linear": {"team": "ABC"}}', mtimeMs: 1 } }
  const engine = world(on, files)
  engine.env.LINEAR_API_KEY = LINEAR_TOKEN
  engine.linear.teams.ABC = TEAM
  engine.linear.issues['ABC-12'] = issue('ABC-12', {
    children: { nodes: [{ identifier: 'ABC-13', title: 'Title of ABC-13', state: { name: 'Todo', type: 'unstarted' } }] },
    comments: { nodes: [{ body: 'Please keep the old retry count.', createdAt: '2026-10-08T09:00:00.000Z', user: { displayName: 'Owner' } }] },
  })
  engine.linear.issues['ABC-13'] = issue('ABC-13', { parent: { identifier: 'ABC-12' } })
  await start($)
  await board($, run)

  return { files, engine }
}
const noKeyAnywhere = (engine: World, files: Files, said: readonly unknown[]) => {
  expect(JSON.stringify(files), 'the key is written nowhere').not.toContain(LINEAR_TOKEN)
  expect(JSON.stringify([...said, engine.toasts, engine.woke]), 'and said nowhere').not.toContain(LINEAR_TOKEN)
}

describe('Linear answers, read', () => {
  test('a key or a linear.app link names an issue', () => {
    expect(linearKeyOf('ABC-12')).toBe('ABC-12')
    expect(linearKeyOf('https://linear.app/acme/issue/ABC-12/retry')).toBe('ABC-12')
    expect(linearKeyOf('abc-12')).toBeUndefined()
  })

  test('the first state of a type is the one with the lowest position', () => {
    expect(stateFor(STATES, 'started')).toBe('s-progress')
    expect(stateFor(STATES, 'completed')).toBe('s-done')
    expect(stateFor([], 'started')).toBeUndefined()
  })

  test('an issue reads into a view and a text', () => {
    const view = issueOf({ issue: issue('ABC-12', { children: { nodes: [{ identifier: 'ABC-13', title: 'Sub', state: { name: 'Done', type: 'completed' } }] } }) })
    expect(view).toMatchObject({ id: 'issue-ABC-12', key: 'ABC-12', team: { id: 'team-abc', key: 'ABC' } })
    const text = issueText(view!)
    expect(text).toContain('ABC-12: Title of ABC-12 (Todo)')
    expect(text).toContain('- ABC-13 Sub (Done)')
    expect(issueOf({ issue: null })).toBeUndefined()
  })
})

describe('the ticket tools', () => {
  test('ticket_read reads an issue with its sub-issues and comments', async ($, on) => {
    const { engine, files } = await linearRun($, on)

    const said = await call($, 'ticket_read', { key: 'ABC-12' })
    expect(said.text).toContain('ABC-12: Title of ABC-12 (Todo)')
    expect(said.text).toContain('- ABC-13 Title of ABC-13 (Todo)')
    expect(said.text).toContain('Owner, 2026-10-08T09:00:00.000Z: Please keep the old retry count.')
    noKeyAnywhere(engine, files, [said])
  })

  test('ticket_file is refused before approval, and files a sub-issue after it', async ($, on) => {
    const { engine, files } = await linearRun($, on)

    const early = await call($, 'ticket_file', { title: 'Two', description: 'The second part.' })
    expect(early.text).toContain('Not done.')
    expect(early.text).toContain('approve')
    expect(engine.linear.created).toEqual([])

    await command($, 'approve')
    const filed = await call($, 'ticket_file', { title: 'Two', description: 'The second part.', task: 't1' })
    expect(filed.text).toContain('Filed ABC-101 under ABC-12')
    expect(engine.linear.created).toEqual([{ teamId: 'team-abc', title: 'Two', description: 'The second part.', parentId: 'issue-ABC-12' }])
    expect(stored(files).tasks[0]?.ticket, 'the task carries the new key').toBe('ABC-101')
    noKeyAnywhere(engine, files, [early, filed])
  })

  test('no key: the Linear tools say where to set it', async ($, on) => {
    const { engine } = await linearRun($, on)
    delete engine.env.LINEAR_API_KEY

    const said = await call($, 'ticket_read', { key: 'ABC-12' })
    expect(said.text).toContain('Linear API key')
    expect(said.text).toContain('LINEAR_API_KEY')
    expect(engine.linear.asked).toEqual([])
  })

  test('the key option comes before LINEAR_API_KEY', { options: { linearApiKey: 'the-options-key' } }, async ($, on) => {
    const { engine } = await linearRun($, on)
    engine.linear.accepts = 'the-options-key'

    expect((await call($, 'ticket_read', { key: 'ABC-12' })).text).toContain('ABC-12: Title of ABC-12')
  })

  test('a git session with no Linear config registers no Linear tool, and one with it does', async ($, on) => {
    mock.clock(on, { now: NOW })
    const engine = world(on, {})
    await start($)
    expect(engine.registered).not.toContain('ticket_read')
    expect(engine.registered).not.toContain('ticket_file')
  })

  test('a Linear project registers the ticket tools', async ($, on) => {
    const { engine } = await linearRun($, on)
    expect(engine.registered).toContain('ticket_read')
    expect(engine.registered).toContain('ticket_file')
  })
})

describe('Linear states the mod moves itself', () => {
  test("/approve moves the run's issue to its team's first started state", async ($, on) => {
    const { engine } = await linearRun($, on)

    await command($, 'approve')
    expect(engine.linear.updated).toEqual([{ id: 'issue-ABC-12', input: { stateId: 's-progress' } }])
  })

  test("a worker start moves its task's issue to started", async ($, on) => {
    const { engine } = await linearRun($, on)
    await command($, 'approve')
    engine.agentIds.push('a1')

    await spawn($, 't1')
    expect(engine.linear.updated).toContainEqual({ id: 'issue-ABC-13', input: { stateId: 's-progress' } })
  })

  test('a spec run files its parent issue at /approve in linear.team', async ($, on) => {
    const spec: Ledger = { ...RUN, run: { ...RUN.run, id: 'x', source: 'docs/x.md', title: 'Billing screens', config: { tickets: 'linear', linear: { team: 'ABC' } } }, tasks: [{ ...T1, ticket: undefined }] }
    const { engine, files } = await linearRun($, on, spec, 'x')

    await command($, 'approve')
    expect(engine.linear.created[0]).toEqual({ teamId: 'team-abc', title: 'Billing screens', description: 'Spec: docs/x.md' })
    expect(stored(files, ledgerPath('x')).run.issue).toBe('ABC-101')
    expect(engine.linear.updated).toContainEqual({ id: 'issue-ABC-101', input: { stateId: 's-progress' } })
  })

  test('Linear down is one warning problem, never a stopped run', async ($, on) => {
    const { engine, files } = await linearRun($, on)
    engine.linear.isDown = true

    expect((await command($, 'approve')).text).toContain('Plan approved')
    engine.agentIds.push('a1')
    await spawn($, 't1')
    const { problems, run } = stored(files)
    expect(run.plan).toBe('approved')
    expect(problems.filter(one => one.severity === 'warning' && one.text.startsWith('Linear'))).toHaveLength(1)
    expect(problems[0]?.text).toContain('ENOTFOUND')
  })

  test('in git, a GitHub merge of a task with a Linear ticket moves it to completed', async ($, on) => {
    mock.clock(on, { now: NOW })
    const ledger = withTask('t395-1', { ticket: 'ABC-13' })
    const files: Files = { [ledgerPath('demo')]: file(ledger, 1) }
    const engine = world(on, files)
    engine.env.LINEAR_API_KEY = LINEAR_TOKEN
    engine.linear.issues['ABC-13'] = issue('ABC-13', { state: { name: 'In Progress', type: 'started' } })
    engine.forge.pulls[548] = pull('b'.repeat(40), { title: 'Daily cap thresholds', body: 'Two thresholds per UTC day.\n\nCloses #395' })
    engine.forge.checks['b'.repeat(40)] = ci('success')
    await start($)
    await board($, 'demo')

    const said = await call($, 'merge', { task: 't395-1', told: ['Triage issues'], closes: [395] })
    expect(said.text).toContain(`is on main as ${mergeCommit(548).slice(0, 7)}`)
    expect(engine.linear.updated).toEqual([{ id: 'issue-ABC-13', input: { stateId: 's-done' } }])
  })
})
