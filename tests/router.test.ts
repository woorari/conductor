import { describe, expect, test } from 'claude-code/testing'

import { familyOf, readiness, route, routeCodex, unlocked } from '../hooks/router'
import type { Ledger, Merge, TaskStatus } from '../types'
import { LEDGER, withTask } from './fixture'

const worker = { subagentType: 'general-purpose' }

describe('which tier a model belongs to', () => {
  test('reads the family out of an alias or a full id', () => {
    expect(['haiku', 'claude-sonnet-5-5', 'us.anthropic.claude-opus-5-5-v1:0', 'Opus'].map(familyOf)).toEqual([
      'haiku',
      'sonnet',
      'opus',
      'opus',
    ])
  })

  test('does not guess for a model it does not know, or for none', () => {
    expect(familyOf('claude-fable-5-1')).toBeUndefined()
    expect(familyOf(undefined)).toBeUndefined()
  })
})

describe('route', () => {
  test('a task\'s worker runs on the task\'s tier, whatever the call asked for', () => {
    expect(route(LEDGER, { ...worker, name: 't392-1', model: 'opus' })).toMatchObject({ kind: 'worker', taskId: 't392-1', model: 'haiku' })
    expect(route(LEDGER, { ...worker, name: 't392-1' })).toMatchObject({ kind: 'worker', taskId: 't392-1', model: 'haiku' })
  })

  test('an agent named as the task lists its worker is that task\'s worker', () => {
    expect(route(LEDGER, { ...worker, name: 'w396' })).toMatchObject({ kind: 'worker', taskId: 't396-1', model: 'opus' })
  })

  test('an agent that is no task\'s worker is refused, with what to do instead', () => {
    for (const name of [undefined, 'explorer']) {
      const decided = route(LEDGER, { ...worker, name })
      expect(decided.kind).toBe('deny')
      expect(decided.kind === 'deny' ? decided.text : '').toContain('mcp__conductor__task_add')
    }
  })

  test('a read-only helper starts without a task, as asked', () => {
    for (const subagentType of ['Explore', 'Plan', 'claude-code-guide']) {
      expect(route(LEDGER, { subagentType, model: 'opus' })).toEqual({ kind: 'pass' })
    }
  })

  test('a finished task, and one already building, get no second worker', () => {
    const done = route(LEDGER, { ...worker, name: 't390-1' })
    expect(done).toMatchObject({ kind: 'deny' })
    expect(done.kind === 'deny' ? done.text : '').toContain('t390-1 is done')
    const building = route(LEDGER, { ...worker, name: 't391-1' })
    expect(building.kind === 'deny' ? building.text : '').toContain('already being built by w391')
  })

  test('a task that waits on unfinished tasks does not start', () => {
    const decided = route(LEDGER, { ...worker, name: 't392-2' })
    expect(decided.kind === 'deny' ? decided.text : '').toBe(
      'conductor: t392-2 waits for t391-1 (building), t392-1 (queued). A task starts once what it waits for is green (reviewed, its checks green) or done.',
    )
  })

  test('no more workers build at once than the run allows: three unless it says otherwise', () => {
    const full = withTask('t392-1', { status: 'building' })
    const refused = route(full, { ...worker, name: 'w396' })
    expect(refused.kind === 'deny' ? refused.text : '').toContain('3 workers are building')
    const roomy: Ledger = { ...full, run: { ...full.run, maxParallel: 4 } }
    expect(route(roomy, { ...worker, name: 'w396' }).kind).toBe('worker')
    const tight: Ledger = { ...LEDGER, run: { ...LEDGER.run, maxParallel: 2 } }
    expect(route(tight, { ...worker, name: 't392-1' }).kind).toBe('deny')
  })

  test('a worker\'s own subagent never runs on a dearer tier than the worker', () => {
    const child = (parent: string, model?: string) => route(LEDGER, { subagentType: 'Explore', parentTaskId: parent, model })
    expect(child('t391-1', 'opus'), 'dearer is brought down').toEqual({ kind: 'child', taskId: 't391-1', model: 'sonnet' })
    expect(child('t391-1', 'haiku'), 'cheaper stands').toEqual({ kind: 'child', taskId: 't391-1', model: 'haiku' })
    expect(child('t391-1'), 'none asked: the worker\'s tier, named').toEqual({ kind: 'child', taskId: 't391-1', model: 'sonnet' })
    expect(child('t391-1', 'claude-fable-5-1'), 'an unknown family is the worker\'s tier').toEqual({ kind: 'child', taskId: 't391-1', model: 'sonnet' })
    expect(child('t394-1', 'opus'), 'an opus worker may use opus').toEqual({ kind: 'child', taskId: 't394-1', model: 'opus' })
  })

  test('a subagent of a task the run does not have is left alone', () => {
    expect(route(LEDGER, { subagentType: 'general-purpose', parentTaskId: 't999', model: 'opus' })).toEqual({ kind: 'pass' })
  })
})

describe('when a task may start', () => {
  /** `c` waits for `a`; `d` waits for `a` and `b`. */
  const run = (a: TaskStatus, b: TaskStatus, merge?: Pick<Merge, 'task' | 'state'>): Ledger => ({
    ...LEDGER,
    problems: [],
    tasks: [
      { id: 'a', title: 'A', tier: 'sonnet', status: a, files: ['api/a.py'], branch: 'feat/a', pr: 11 },
      { id: 'b', title: 'B', tier: 'sonnet', status: b, files: ['api/b.py'], pr: 12 },
      { id: 'c', title: 'C', tier: 'sonnet', status: 'queued', files: ['api/c.py'], dependsOn: ['a'] },
      { id: 'd', title: 'D', tier: 'sonnet', status: 'queued', files: ['api/d.py'], dependsOn: ['a', 'b'] },
    ],
    ...(merge === undefined ? {} : { merge: { ...merge, pr: 11, head: 'h', startedAt: '2026-10-09T10:00:00Z' } }),
  })
  const start = (ledger: Ledger, name: string) => route(ledger, { ...worker, name })
  const A = { taskId: 'a', branch: 'feat/a', pr: 11 }

  test('once what it waits for is green: it builds on that task\'s branch, and need not wait for the merge', () => {
    expect(start(run('green', 'queued'), 'c')).toEqual({ kind: 'worker', taskId: 'c', model: 'sonnet', slot: 1, base: A })
    expect(readiness(run('green', 'queued'), run('green', 'queued').tasks[2]!)).toEqual({ waitsFor: [], base: A })
  })

  test('once it is done there is no branch to build on: the change is on main', () => {
    expect(start(run('done', 'queued'), 'c')).toEqual({ kind: 'worker', taskId: 'c', model: 'sonnet', slot: 1 })
  })

  test('not before: handed back, in review, building, blocked or failed is not green', () => {
    for (const status of ['queued', 'building', 'returned', 'review', 'blocked', 'failed'] as const) {
      const decided = start(run(status, 'done'), 'c')
      expect(decided.kind === 'deny' ? decided.text : 'started', status).toBe(
        `conductor: c waits for a (${status}). A task starts once what it waits for is green (reviewed, its checks green) or done.`,
      )
    }
  })

  test('a worker builds on one unmerged branch only', () => {
    const both = start(run('green', 'green'), 'd')
    expect(both.kind === 'deny' ? both.text : 'started').toBe(
      'conductor: d waits for a, b, which are green but not merged: a worker builds on one unmerged branch only. Start it once all but one of them are done.',
    )
    expect(start(run('done', 'green'), 'd')).toMatchObject({ kind: 'worker', base: { taskId: 'b', pr: 12 } })
    expect((start(run('done', 'green'), 'd') as { base: object }).base, 'a branch nobody recorded is found by its pull request').toEqual({ taskId: 'b', branch: undefined, pr: 12 })
    expect(start(run('green', 'done'), 'd')).toMatchObject({ kind: 'worker', base: A })
    expect(start(run('done', 'done'), 'd')).toEqual({ kind: 'worker', taskId: 'd', model: 'sonnet', slot: 1 })
    expect(start(run('green', 'review'), 'd').kind, 'one of them not green yet').toBe('deny')
  })

  test('while the merge call is out a green task is not on the base branch yet, and is still the branch to build on', () => {
    expect(start(run('green', 'queued', { task: 'a', state: 'merging' }), 'c')).toMatchObject({ base: A })
  })

  test('what a green task lets start', () => {
    expect(unlocked(run('green', 'queued'), 'a')).toEqual([{ id: 'c', base: A }])
    expect(unlocked(run('green', 'done'), 'a')).toEqual([{ id: 'c', base: A }, { id: 'd', base: A }])
    expect(unlocked(run('green', 'green'), 'a'), 'd would need two branches').toEqual([{ id: 'c', base: A }])
    expect(unlocked(run('done', 'green'), 'b')).toEqual([{ id: 'd', base: { taskId: 'b', branch: undefined, pr: 12 } }])
    expect(unlocked(run('review', 'queued'), 'a')).toEqual([])
    const started: Ledger = { ...run('green', 'queued'), tasks: run('green', 'queued').tasks.map(one => (one.id === 'c' ? { ...one, status: 'building' as const } : one)) }
    expect(unlocked(started, 'a'), 'one that started already is not listed').toEqual([])
  })
})

describe('Codex worker routing', () => {
  const ready: Ledger = {
    ...LEDGER,
    run: { ...LEDGER.run, plan: 'approved', codex: { ready: true } },
    tasks: [
      { id: 't1', title: 'Build one', tier: 'sonnet', kind: 'codex', status: 'queued', files: ['src/one.ts'] },
      { id: 't2', title: 'Build two', tier: 'haiku', status: 'queued', files: ['src/two.ts'] },
    ],
  }
  const claudeRoute = (ledger: Ledger) => route({
    ...ledger,
    tasks: ledger.tasks.map(task => task.id === 't1' ? { ...task, kind: 'claude' } : task),
  }, { ...worker, name: 't1' })
  const sameRefusal = (ledger: Ledger, contains: string) => {
    const claude = claudeRoute(ledger)
    expect(claude).toMatchObject({ kind: 'deny' })
    expect(claude.kind === 'deny' ? claude.text : '').toContain(contains)
    expect(routeCodex(ledger, 't1')).toEqual({ is: 'deny', text: claude.kind === 'deny' ? claude.text : '' })
  }

  test('each kind names its own start tool, including an agent named as the recorded worker', () => {
    for (const name of ['t1', 'codex-one']) {
      const ledger = { ...ready, tasks: ready.tasks.map(task => task.id === 't1' ? { ...task, worker: 'codex-one' } : task) }
      const decided = route(ledger, { ...worker, name })
      expect(decided).toMatchObject({ kind: 'deny' })
      expect(decided.kind === 'deny' ? decided.text : '').toContain('worker_start')
    }
    for (const kind of [undefined, 'claude'] as const) {
      const ledger = { ...ready, tasks: ready.tasks.map(task => task.id === 't2' ? { ...task, kind } : task) }
      expect(routeCodex(ledger, 't2')).toEqual({ is: 'deny', text: 'conductor: `t2` is built by Claude: start its worker with the Agent tool.' })
      expect(route(ledger, { ...worker, name: 't2' })).toMatchObject({ kind: 'worker' })
    }
  })

  test('an unknown task is refused instead of starting a helper', () => {
    expect(routeCodex(ready, 'missing')).toMatchObject({ is: 'deny', text: expect.stringContaining('missing') })
  })

  test('Codex readiness is required, including a recorded reason it is off', () => {
    for (const codex of [undefined, { ready: false, why: 'not installed' }]) {
      const decided = routeCodex({ ...ready, run: { ...ready.run, codex } }, 't1')
      expect(decided).toMatchObject({ is: 'deny', text: expect.stringContaining('off for this run') })
      if (codex !== undefined) expect(decided.is === 'deny' ? decided.text : '').toContain('not installed')
    }
  })

  test('draft and proposed plans and owner pause use the Claude refusals verbatim', () => {
    for (const plan of ['draft', 'proposed'] as const) sameRefusal({ ...ready, run: { ...ready.run, plan } }, plan === 'draft' ? 'draft' : 'approval')
    sameRefusal({ ...ready, run: { ...ready.run, pausedAt: '2026-11-12T12:00:00Z' } }, 'paused')
  })

  test('done or already building never starts another worker', () => {
    for (const status of ['done', 'building'] as const) {
      sameRefusal({ ...ready, tasks: ready.tasks.map(task => task.id === 't1' ? { ...task, status, worker: 'codex-one' } : task) }, status === 'done' ? 'is done' : 'already being built')
    }
  })

  test('unfinished dependencies and two unmerged green branches use the Claude refusals', () => {
    const dependent: Ledger = { ...ready, tasks: ready.tasks.map(task => task.id === 't1' ? { ...task, dependsOn: ['t2'] } : task) }
    for (const status of ['queued', 'building', 'returned', 'review', 'blocked', 'failed'] as const) {
      sameRefusal({ ...dependent, tasks: dependent.tasks.map(task => task.id === 't2' ? { ...task, status } : task) }, `t2 (${status})`)
    }
    sameRefusal({ ...dependent, tasks: [
      { ...dependent.tasks[0]!, dependsOn: ['t2', 't3'] },
      { ...dependent.tasks[1]!, status: 'green' },
      { id: 't3', title: 'Three', tier: 'haiku', status: 'green' },
    ] }, 'one unmerged branch only')
  })

  test('Claude and Codex workers both count towards the default and configured capacity', () => {
    const building: Ledger = { ...ready, tasks: [ready.tasks[0]!, ...['claude', 'codex', 'claude'].map((kind, i) => ({
      id: `building-${i}`, title: 'Busy', tier: 'sonnet' as const, kind: kind as 'claude' | 'codex', status: 'building' as const, slot: i + 1,
    }))] }
    sameRefusal(building, '3 workers are building')
    sameRefusal({ ...building, run: { ...building.run, maxParallel: 1 }, tasks: building.tasks.slice(0, 2) }, '1 workers are building')
    expect(routeCodex({ ...building, run: { ...building.run, maxParallel: 4 } }, 't1')).toEqual({ is: 'start', slot: 4 })
  })

  test('a building worker blocks overlapping files and folders, regardless of kind', () => {
    for (const kind of ['claude', 'codex'] as const) {
      sameRefusal({ ...ready, tasks: [ready.tasks[0]!, { ...ready.tasks[1]!, status: 'building', kind, files: ['src'] }] }, 'both change src/one.ts')
    }
  })

  test('a free slot and the single green base are identical to Claude routing', () => {
    const ledger: Ledger = { ...ready, tasks: [
      { ...ready.tasks[0]!, dependsOn: ['t2'] },
      { ...ready.tasks[1]!, status: 'green', branch: 'feat/t2', pr: 7 },
      { id: 't3', title: 'Three', tier: 'haiku', kind: 'claude', status: 'building', slot: 1 },
      { id: 't4', title: 'Four', tier: 'sonnet', kind: 'codex', status: 'building', slot: 3 },
    ] }
    expect(routeCodex(ledger, 't1')).toEqual({ is: 'start', slot: 2, base: { taskId: 't2', branch: 'feat/t2', pr: 7 } })
    expect(claudeRoute(ledger)).toMatchObject({ kind: 'worker', slot: 2, base: { taskId: 't2', branch: 'feat/t2', pr: 7 } })
    expect(routeCodex({ ...ledger, tasks: ledger.tasks.map(task => task.id === 't2' ? { ...task, status: 'done' } : task) }, 't1')).toEqual({ is: 'start', slot: 2 })
  })
})
