import { describe, expect, test } from 'claude-code/testing'

import { parseLedger } from '../hooks/ledger'
import {
  acted,
  activityText,
  addTask,
  ownerSetsKind,
  ownerSetsTier,
  reportProblem,
  resolveProblem,
  spawned,
  turnEnded,
  updateTask,
} from '../hooks/signals'
import type { Caller, Raw } from '../hooks/signals'
import { prepare } from '../hooks/store'
import { LEDGER } from './fixture'

const AT = '2026-10-09T10:30:00.000Z'
const LATER = '2026-10-09T10:45:00.000Z'
const ORCHESTRATOR: Caller = { kind: 'orchestrator' }
const worker = (taskId: string): Caller => ({ kind: 'worker', taskId })
const raw = (): Raw => JSON.parse(JSON.stringify(LEDGER)) as Raw
const task = (ledger: Raw, id: string) => ledger.tasks.find(one => one.id === id)!

describe('what a tool call is called on the board', () => {
  test('names the tool and the file, never the path above it', () => {
    expect(activityText({ tool: 'Edit', file_path: '/repo/api/overload.py' })).toBe('Edit overload.py')
    expect(activityText({ tool: 'Read', file_path: 'docs/DEPLOY.md' })).toBe('Read DEPLOY.md')
  })

  test('takes a command from its description and never from its text', () => {
    const call = { tool: 'Bash', command: 'curl -H "Authorization: token s3cr3t" https://x', description: 'Read the PR status' }
    expect(activityText(call)).toBe('Bash: Read the PR status')
    expect(activityText({ tool: 'Bash', command: 'export TOKEN=s3cr3t' })).toBe('Bash')
  })

  test('keeps a search pattern and a message out', () => {
    expect(activityText({ tool: 'Grep', pattern: 'API_KEY=abc' })).toBe('Grep')
    expect(activityText({ tool: 'SendMessage', to: 'main', message: 'the password is hunter2' })).toBe('SendMessage')
  })

  test('says what a subagent was started for, and shortens a connector tool to its own words', () => {
    expect(activityText({ tool: 'Agent', description: 'Find the callers', prompt: 'long' })).toBe('Subagent: Find the callers')
    expect(activityText({ tool: 'mcp__github__create_pull_request' })).toBe('github create_pull_request')
  })

  test('is one line of at most 60 characters', () => {
    const text = activityText({ tool: 'Bash', description: `Run the\nwhole ${'very '.repeat(20)}long suite` })
    expect(text.length).toBe(60)
    expect(text).not.toContain('\n')
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('a worker starts', () => {
  test('an agent named after a task makes that task building, with who and what runs it', () => {
    const ledger = raw()
    expect(spawned(ledger, AT, { name: 't392-1', agentId: 'a1', model: 'claude-haiku-5-5' })).toBe('t392-1')
    expect(task(ledger, 't392-1')).toMatchObject({
      status: 'building',
      worker: 't392-1',
      agentId: 'a1',
      model: 'claude-haiku-5-5',
      startedAt: AT,
      activity: { at: AT, text: 'started' },
    })
  })

  test('an agent named as the task lists its worker is that task\'s too', () => {
    const ledger = raw()
    expect(spawned(ledger, AT, { name: 'w396', agentId: 'a2', model: 'claude-opus-5-5' })).toBe('t396-1')
    expect(task(ledger, 't396-1').status).toBe('building')
  })

  test('a second start keeps when the task first started and reopens its bar', () => {
    const ledger = raw()
    spawned(ledger, LATER, { name: 'w396', agentId: 'a2', model: 'claude-opus-5-5' })
    expect(task(ledger, 't396-1').startedAt).toBe('2026-10-09T08:30:00Z')
    expect(task(ledger, 't396-1').finishedAt).toBeUndefined()
  })

  test('an agent of any other name, or for a finished task, changes nothing', () => {
    const ledger = raw()
    expect(spawned(ledger, AT, { name: 'explorer', agentId: 'a3', model: 'm' })).toBeUndefined()
    expect(spawned(ledger, AT, { name: 't390-1', agentId: 'a4', model: 'm' })).toBeUndefined()
    expect(ledger).toEqual(raw())
  })
})

describe('a worker is seen acting, and its turn ends', () => {
  test('a turn that ends hands a building task back and stops its bar', () => {
    const ledger = raw()
    spawned(ledger, AT, { name: 't392-1', agentId: 'a1', model: 'm' })
    expect(turnEnded(ledger, LATER, 'a1', 'answer')).toBe('t392-1')
    expect(task(ledger, 't392-1')).toMatchObject({
      status: 'returned',
      finishedAt: LATER,
      activity: { at: LATER, text: 'handed back' },
    })
  })

  test('a turn that was cut short says so', () => {
    const ledger = raw()
    spawned(ledger, AT, { name: 't392-1', agentId: 'a1', model: 'm' })
    turnEnded(ledger, LATER, 'a1', 'aborted')
    expect(task(ledger, 't392-1').activity).toEqual({ at: LATER, text: 'stopped: interrupted' })
  })

  test('a task its worker already put in review stays in review when the turn ends', () => {
    const ledger = raw()
    spawned(ledger, AT, { name: 't392-1', agentId: 'a1', model: 'm' })
    updateTask(ledger, AT, worker('t392-1'), { task: 't392-1', status: 'review', pr: 551 })
    turnEnded(ledger, LATER, 'a1', 'answer')
    expect(task(ledger, 't392-1').status).toBe('review')
    expect(task(ledger, 't392-1').finishedAt).toBe(LATER)
  })

  test('a worker acting after its turn ended was resumed: its task is building again', () => {
    const ledger = raw()
    spawned(ledger, AT, { name: 't392-1', agentId: 'a1', model: 'm' })
    turnEnded(ledger, AT, 'a1', 'answer')
    expect(acted(ledger, 't392-1', { at: LATER, text: 'Edit deck.ts' })).toBe(true)
    expect(task(ledger, 't392-1')).toMatchObject({ status: 'building', activity: { at: LATER, text: 'Edit deck.ts' } })
    expect(task(ledger, 't392-1').finishedAt).toBeUndefined()
  })

  test('a worker that says it is blocked and goes on in the same turn stays blocked', () => {
    const ledger = raw()
    spawned(ledger, AT, { name: 't392-1', agentId: 'a1', model: 'm' })
    updateTask(ledger, AT, worker('t392-1'), { task: 't392-1', status: 'blocked', note: 'needs a ruling' })
    acted(ledger, 't392-1', { at: LATER, text: 'Bash: git status' })
    expect(task(ledger, 't392-1').status).toBe('blocked')
  })

  test('an agent that is no task\'s worker, or a finished task, changes nothing', () => {
    const ledger = raw()
    expect(turnEnded(ledger, AT, 'nobody', 'answer')).toBeUndefined()
    expect(acted(ledger, 't390-1', { at: AT, text: 'Read x' })).toBe(false)
    expect(acted(ledger, 't999', { at: AT, text: 'Read x' })).toBe(false)
    expect(ledger).toEqual(raw())
  })
})

describe('task_update', () => {
  test('the orchestrator sets a status, and a finished task gets its end time', () => {
    const ledger = raw()
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't395-1', status: 'blocked' })).toEqual({
      isChanged: true,
      isError: false,
      text: 't395-1: status blocked.',
    })
    const queued = raw()
    updateTask(queued, AT, ORCHESTRATOR, { task: 't392-1', status: 'done' })
    expect(task(queued, 't392-1').finishedAt).toBe(AT)
  })

  test('a worker says its own task is in review, with its pull request and branch', () => {
    const ledger = raw()
    const said = updateTask(ledger, AT, worker('t391-1'), { task: 't391-1', status: 'review', pr: 550, branch: 'fix/391-pool' })
    expect(said.text).toBe('t391-1: status review, PR 550, branch fix/391-pool.')
    expect(task(ledger, 't391-1')).toMatchObject({ status: 'review', pr: 550, branch: 'fix/391-pool' })
  })

  test('a worker may not touch another task, nor finish or ready its own', () => {
    const ledger = raw()
    expect(updateTask(ledger, AT, worker('t391-1'), { task: 't394-1', note: 'mine now' })).toMatchObject({ isError: true, isChanged: false })
    for (const status of ['done', 'green', 'queued', 'building', 'returned']) {
      const said = updateTask(ledger, AT, worker('t391-1'), { task: 't391-1', status })
      expect(said.isError, status).toBe(true)
      expect(said.text, status).toContain("is the orchestrator's to set")
    }
    expect(ledger).toEqual(raw())
  })

  test('an agent that is no task\'s worker is refused', () => {
    expect(updateTask(raw(), AT, { kind: 'stranger' }, { task: 't391-1', note: 'x' }).isError).toBe(true)
  })

  test('an unknown task is refused with the ids that exist', () => {
    const said = updateTask(raw(), AT, ORCHESTRATOR, { task: 't999', status: 'done' })
    expect(said.isError).toBe(true)
    expect(said.text).toContain('t390-1, t390-2, t391-1')
  })

  test('a note is one tidy line, and an empty one clears it', () => {
    const ledger = raw()
    updateTask(ledger, AT, ORCHESTRATOR, { task: 't391-1', note: '  waiting on\nCI  ' })
    expect(task(ledger, 't391-1').note).toBe('waiting on CI')
    updateTask(ledger, AT, ORCHESTRATOR, { task: 't391-1', note: '' })
    expect(task(ledger, 't391-1').note).toBeUndefined()
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't391-1', note: 'x'.repeat(201) }).isError).toBe(true)
  })

  test('a call that changes nothing, or gives a value of the wrong kind, is refused', () => {
    expect(updateTask(raw(), AT, ORCHESTRATOR, { task: 't391-1' }).text).toContain('Nothing to change')
    expect(updateTask(raw(), AT, ORCHESTRATOR, { task: 't391-1', pr: 'five' }).isError).toBe(true)
    expect(updateTask(raw(), AT, ORCHESTRATOR, { task: 't391-1', status: 'merged' }).isError).toBe(true)
    expect(updateTask(raw(), AT, ORCHESTRATOR, {}).isError).toBe(true)
  })

  test('setting a task back to building reopens its bar', () => {
    const ledger = raw()
    updateTask(ledger, LATER, ORCHESTRATOR, { task: 't396-1', status: 'building' })
    expect(task(ledger, 't396-1').finishedAt).toBeUndefined()
    expect(task(ledger, 't396-1').startedAt).toBe('2026-10-09T08:30:00Z')
  })
})

describe('problems', () => {
  test('a report is numbered after the last problem, resolved ones included', () => {
    const ledger = raw()
    const said = reportProblem(ledger, AT, ORCHESTRATOR, { text: 'CI runner is out of disk', severity: 'blocker' })
    expect(said.text).toBe('P4 recorded (blocker).')
    expect(ledger.problems?.at(-1)).toEqual({ id: 'P4', text: 'CI runner is out of disk', severity: 'blocker', status: 'open', foundAt: AT })
  })

  test('a worker\'s report is filed under its own task', () => {
    const ledger = raw()
    expect(reportProblem(ledger, AT, worker('t394-1'), { text: 'The budget has no index', severity: 'warning' }).text).toBe(
      'P4 recorded (warning, t394-1).',
    )
    expect(ledger.problems?.at(-1)?.taskId).toBe('t394-1')
  })

  test('a report needs words, a known severity and a real task', () => {
    expect(reportProblem(raw(), AT, ORCHESTRATOR, { text: ' ', severity: 'note' }).isError).toBe(true)
    expect(reportProblem(raw(), AT, ORCHESTRATOR, { text: 'x', severity: 'urgent' }).text).toContain('blocker, warning, note')
    expect(reportProblem(raw(), AT, ORCHESTRATOR, { text: 'x', severity: 'note', task: 't999' }).isError).toBe(true)
    expect(reportProblem(raw(), AT, { kind: 'stranger' }, { text: 'x', severity: 'note' }).isError).toBe(true)
  })

  test('only the orchestrator resolves a problem, once, and says how', () => {
    const ledger = raw()
    expect(resolveProblem(ledger, worker('t391-1'), { problem: 'P2', resolution: 'fixed' }).isError).toBe(true)
    expect(resolveProblem(ledger, ORCHESTRATOR, { problem: 'P2', resolution: '' }).isError).toBe(true)
    expect(resolveProblem(ledger, ORCHESTRATOR, { problem: 'P9', resolution: 'x' }).isError).toBe(true)
    expect(resolveProblem(ledger, ORCHESTRATOR, { problem: 'P2', resolution: 'runs one job at a time' }).text).toBe('P2 resolved.')
    expect(ledger.problems?.find(one => one.id === 'P2')).toMatchObject({ status: 'resolved', resolution: 'runs one job at a time' })
    expect(resolveProblem(ledger, ORCHESTRATOR, { problem: 'P2', resolution: 'again' }).text).toBe('P2 is already resolved.')
  })
})

describe('writing the file', () => {
  const source = JSON.stringify({ ...LEDGER, extras: [{ id: 'X1', text: 'kept' }], tasks: LEDGER.tasks.map(one => ({ ...one, owner: 'someone' })) })

  test('a change keeps every field this version does not know', () => {
    const prepared = prepare(source, ledger => ({ value: 1, isChanged: acted(ledger, 't391-1', { at: AT, text: 'Edit x.py' }) }))
    const written = JSON.parse(prepared.write ?? '{}') as Raw
    expect(written.extras).toEqual([{ id: 'X1', text: 'kept' }])
    expect(written.tasks.every(one => one.owner === 'someone')).toBe(true)
    expect(parseLedger(prepared.write ?? '').error).toBeUndefined()
  })

  test('nothing is written when nothing changed', () => {
    expect(prepare(source, () => ({ value: 'same', isChanged: false }))).toEqual({ value: 'same' })
  })

  test('a file caught half written is said to be torn, so the writer tries again', () => {
    expect(prepare('{"version": 1, "run": {', () => ({ value: 1, isChanged: true }))).toMatchObject({ isTorn: true })
  })

  test('a change that would leave a ledger that does not read back is never written', () => {
    const prepared = prepare(source, ledger => {
      task(ledger, 't391-1').status = 'merged' as never

      return { value: 1, isChanged: true }
    })
    expect(prepared).toMatchObject({ isTorn: false })
    expect(prepared.error).toContain('nothing was written')
    expect(prepared.write).toBeUndefined()
  })
})

describe('tiers and new tasks', () => {
  const OWNER: Caller = { kind: 'owner' }

  test('the orchestrator adds a task with its tier and why, queued', () => {
    const ledger = raw()
    const said = addTask(ledger, ORCHESTRATOR, {
      id: 't397-1',
      title: 'Review the write semantics of PR 565',
      tier: 'sonnet',
      tierReason: 'independent review of a risky change',
      ticket: 397,
      dependsOn: ['t391-1'],
    })
    expect(said.text).toBe('t397-1 added: sonnet, queued, after t391-1.')
    expect(task(ledger, 't397-1')).toEqual({
      id: 't397-1',
      title: 'Review the write semantics of PR 565',
      tier: 'sonnet',
      tierReason: 'independent review of a risky change',
      status: 'queued',
      ticket: 397,
      dependsOn: ['t391-1'],
    })
    expect(parseLedger(JSON.stringify(ledger)).error).toBeUndefined()
  })

  test('a task needs an id of its own, a title, a tier and a reason, and real dependencies', () => {
    const base = { id: 't397-1', title: 'A title', tier: 'haiku', tierReason: 'a one-file change' }
    for (const [bad, says] of [
      [{ ...base, id: 't391-1' }, 'already a task'],
      [{ ...base, id: 'w391' }, 'already a task or a worker'],
      [{ ...base, id: '../x' }, 'short name'],
      [{ ...base, title: ' ' }, 'title says'],
      [{ ...base, tier: 'gpt' }, 'tier is one of'],
      [{ ...base, tierReason: '' }, 'why the task has this tier'],
      [{ ...base, dependsOn: ['t999'] }, 'no task of this run'],
      [{ ...base, ticket: 0 }, 'ticket is'],
    ] as const) {
      const ledger = raw()
      const said = addTask(ledger, ORCHESTRATOR, bad)
      expect(said.isError, says).toBe(true)
      expect(said.text, says).toContain(says)
      expect(ledger, says).toEqual(raw())
    }
  })

  test('only the orchestrator adds a task', () => {
    const base = { id: 't397-1', title: 'A title', tier: 'haiku', tierReason: 'small' }
    expect(addTask(raw(), worker('t391-1'), base).isError).toBe(true)
    expect(addTask(raw(), { kind: 'stranger' }, base).isError).toBe(true)
  })

  test('the orchestrator re-tiers a task that has not started, and must say why', () => {
    const ledger = raw()
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't392-1', tier: 'sonnet' }).text).toContain('why the task has this tier')
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't392-1', tier: 'sonnet', tierReason: 'touches two clients' }).text).toBe('t392-1: tier sonnet.')
    expect(task(ledger, 't392-1')).toMatchObject({ tier: 'sonnet', tierReason: 'touches two clients' })
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't391-1', tier: 'haiku', tierReason: 'x' }).text).toBe(
      't391-1 is building; a tier is set before a task starts.',
    )
    expect(updateTask(ledger, AT, worker('t392-1'), { task: 't392-1', tier: 'opus', tierReason: 'x' }).isError).toBe(true)
  })

  test('the owner\'s tier stands: the orchestrator cannot change it back', () => {
    const ledger = raw()
    expect(ownerSetsTier(ledger, 't392-1', 'opus').text).toBe('t392-1: haiku to opus.')
    expect(task(ledger, 't392-1')).toMatchObject({ tier: 'opus', tierBy: 'owner' })
    const back = updateTask(ledger, AT, ORCHESTRATOR, { task: 't392-1', tier: 'haiku', tierReason: 'it is a copy change' })
    expect(back.text).toBe('The owner set t392-1 to opus; only they change it.')
    expect(task(ledger, 't392-1').tier).toBe('opus')
    expect(ownerSetsTier(ledger, 't392-1', 'sonnet').text, 'they may change their mind').toBe('t392-1: opus to sonnet.')
  })

  test('the owner too sets a tier only before the task starts, and only of a task that exists', () => {
    expect(ownerSetsTier(raw(), 't391-1', 'haiku')).toMatchObject({ isError: true, text: 't391-1 is building; a tier is set before a task starts.' })
    expect(ownerSetsTier(raw(), 't999', 'haiku').isError).toBe(true)
    expect(OWNER.kind).toBe('owner')
  })
})

describe('a task\'s kind of worker', () => {
  const OWNER: Caller = { kind: 'owner' }
  const ready = (): Raw => {
    const ledger = raw()
    ledger.run = { ...(ledger.run as object), codex: { ready: true }, config: { workers: { codex: true, notes: [{ kind: 'codex', for: 'small refactors', proven: false }, { kind: 'codex', for: 'tests', proven: true }, { kind: 'claude', for: 'design', proven: true }] } } } as never
    return ledger
  }
  const base = { id: 'a', title: 't', tier: 'sonnet', tierReason: 'r' }
  const added = (ledger: Raw, input: object) => {
    const said = addTask(ledger, ORCHESTRATOR, { ...base, ...input })
    return { said, task: ledger.tasks.find(one => one.id === 'a') }
  }

  test('the orchestrator needs a reason, the owner does not', () => {
    expect(added(ready(), { kind: 'codex' }).said).toMatchObject({ isError: true, text: expect.stringContaining('kindReason') })
    const ledger = ready()
    expect(ownerSetsKind(ledger, 't392-1', 'codex')).toMatchObject({ isError: false })
    expect(task(ledger, 't392-1')).toMatchObject({ kind: 'codex', kindWhy: 'owner' })
  })

  test('why a task has its kind is recorded', () => {
    const why = (input: object) => added(ready(), { kindReason: 'k', ...input }).task?.kindWhy
    expect(why({ kind: 'codex' })).toBe('spread')
    expect(why({ kind: 'codex', note: 1 })).toBe('trial')
    expect(why({ kind: 'codex', note: 2 })).toBe('note')
    expect(why({ kind: 'claude', tier: 'opus' })).toBe('design')
    expect(why({ kind: 'claude' })).toBe('spread')
    expect(added(ready(), { kind: 'codex', kindReason: 'k' }).task).toMatchObject({ kind: 'codex', kindReason: 'k' })
  })

  test('a note must exist and be of the same kind', () => {
    expect(added(ready(), { kind: 'codex', kindReason: 'k', note: 3 }).said.text).toContain('note')
    expect(added(ready(), { kind: 'codex', kindReason: 'k', note: 9 }).said.text).toContain('note')
  })

  test('an opus task goes to Codex only on a note', () => {
    expect(added(ready(), { tier: 'opus', kind: 'codex', kindReason: 'k' }).said.text).toContain('stay on Claude')
    expect(added(ready(), { tier: 'opus', kind: 'codex', kindReason: 'k', note: 2 }).said.isError).toBe(false)
  })

  test('a task of a ready run says its kind', () => {
    const ledger = ready()
    expect(added(ledger, {}).said.text).toContain('which kind of worker')
    expect(ledger).toEqual(ready())
  })

  test('without Codex, a task without a kind is added as today, and Codex is refused', () => {
    expect(added(raw(), {}).task).toEqual({ id: 'a', title: 't', tier: 'sonnet', tierReason: 'r', status: 'queued' })
    expect(added(raw(), { kind: 'codex', kindReason: 'k' }).said.text).toContain('off for this run')
    const off = raw()
    off.run = { ...(off.run as object), codex: { ready: false, why: 'not logged in' } } as never
    expect(added(off, { kind: 'codex', kindReason: 'k' }).said.text).toContain('not logged in')
  })

  test('the kind is fixed once the task started, and the owner\'s choice stands', () => {
    const ledger = ready()
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't391-1', kind: 'codex', kindReason: 'k' }).text).toContain('has started')
    expect(ownerSetsKind(ledger, 't391-1', 'codex').text).toContain('has started')
    expect(ownerSetsKind(ledger, 't392-1', 'codex').isError).toBe(false)
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't392-1', kind: 'claude', kindReason: 'k' }).text).toContain('owner chose')
    expect(task(ledger, 't392-1').kind).toBe('codex')
    expect(ownerSetsKind(ledger, 't392-1', 'claude').isError).toBe(false)
    expect(ownerSetsKind(ledger, 't392-1', 'gemini').isError).toBe(true)
  })

  test('task_update sets the kind of a queued task, and a worker cannot', () => {
    const ledger = ready()
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 't392-1', kind: 'codex', kindReason: 'k', note: 2 }).text).toBe('t392-1: kind codex.')
    expect(task(ledger, 't392-1')).toMatchObject({ kind: 'codex', kindWhy: 'note' })
    expect(updateTask(ledger, AT, worker('t392-1'), { task: 't392-1', kind: 'claude', kindReason: 'k' }).isError).toBe(true)
    expect(OWNER.kind).toBe('owner')
  })

  test('a task spread to Codex cannot be re-tiered to opus', () => {
    const ledger = ready()
    expect(added(ledger, { kind: 'codex', kindReason: 'k' }).said.isError).toBe(false)
    expect(updateTask(ledger, AT, ORCHESTRATOR, { task: 'a', tier: 'opus', tierReason: 'x' }).text).toContain('stay on Claude')
    expect(task(ledger, 'a').tier).toBe('sonnet')
  })
})
