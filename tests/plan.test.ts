import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { parseLedger } from '../hooks/ledger'
import { handover } from '../hooks/handover'
import { APPROVED, CONDUCT_USAGE, PLANNING, canonicalPlan, conducting, decisionLines, factsLines, newRun, planGate, planning, planningOf } from '../hooks/plan'
import { boardView } from '../hooks/board'
import { briefing } from '../hooks/posts'
import { preflight, route } from '../hooks/router'
import { addTask, approvePlan, proposePlan, spawned, updateTask } from '../hooks/signals'
import type { Raw } from '../hooks/signals'
import type { Ledger } from '../types'
import { LEDGER, NOW, withTask } from './fixture'
import { ROOT, board, ledgerPath, picture$, spawn, start, world } from './world'
import type { Files } from './world'

const AT = '2026-10-09T10:30:00.000Z'
const worker = { subagentType: 'general-purpose' }
const raw = (ledger: Ledger = LEDGER): Raw => JSON.parse(JSON.stringify(ledger)) as Raw
const planned = (plan: 'draft' | 'proposed' | 'approved'): Ledger => ({ ...LEDGER, run: { ...LEDGER.run, plan } })

describe('a run starts with a plan', () => {
  test('a new run is an empty ledger whose plan is a draft', () => {
    const fresh = newRun('capacity', '#334', AT)
    expect(parseLedger(JSON.stringify(fresh)).ledger).toEqual(fresh)
    expect(fresh.run).toEqual({ id: 'capacity', title: 'Run capacity', source: '#334', startedAt: AT, plan: 'draft' })
    expect(planning('capacity', '#334')).toBe('Run board: the owner started run `capacity` from #334. Plan it; start no worker yet.')
    expect(PLANNING, 'how a run is planned is a standing instruction').toContain('at most 12 files or folders')
  })

  test('the plan asks for what the run offers, and for nothing when it offers nothing', () => {
    expect(planningOf(undefined)).toBe(PLANNING)
    expect(planningOf({})).toBe(PLANNING)
    const staffed = planningOf({
      efforts: { opus: ['high'], sonnet: ['low', 'high'] },
      agents: [{ id: 'builder', about: 'Writes the change.' }, { id: 'reviewer', about: 'Reads it.' }],
    })
    expect(staffed.startsWith(PLANNING.split('\n  3.')[0]!)).toBe(true)
    for (const piece of ['builder (Writes the change.)', 'reviewer (Reads it.)', 'opus: high', 'sonnet: low, high', 'an agent', 'an effort where its tier has one', 'one reason']) expect(staffed).toContain(piece)
    expect(staffed.split('\n').slice(3)).toEqual(PLANNING.split('\n').slice(3))
    expect(planningOf({ efforts: { opus: ['high'] } })).not.toContain('an agent')
    expect(planningOf({ agents: [{ id: 'builder', about: 'x' }] })).not.toContain('an effort')
  })

  test('no worker starts while the plan is a draft or waits for the owner', () => {
    for (const plan of ['draft', 'proposed'] as const) {
      const decided = route(planned(plan), { ...worker, name: 't392-1' })
      expect(decided.kind, plan).toBe('deny')
      expect(decided.kind === 'deny' ? decided.text : '', plan).toContain('/approve')
    }
    expect(route(planned('approved'), { ...worker, name: 't392-1' }).kind).toBe('worker')
    expect(route(LEDGER, { ...worker, name: 't392-1' }).kind, 'a ledger from before plans had a state').toBe('worker')
    expect(route(planned('draft'), { subagentType: 'Explore' }), 'reading for the plan is allowed').toEqual({ kind: 'pass' })
  })

  test('the orchestrator proposes a plan that has tasks, and names the run', () => {
    const ledger = raw(planned('draft'))
    expect(proposePlan(ledger, { kind: 'worker', taskId: 't391-1' }, {}).isError).toBe(true)
    const said = proposePlan(ledger, { kind: 'orchestrator' }, { title: '  Nightly import speed ' })
    expect(said.text).toContain('The plan is proposed: 9 tasks. No worker starts before the owner approves it with /approve.')
    expect(ledger.run).toMatchObject({ plan: 'proposed', title: 'Nightly import speed' })
    expect(proposePlan(raw(newRun('x', '#1', AT)), { kind: 'orchestrator' }, {}).text).toContain('A plan needs tasks')
    expect(proposePlan(raw(planned('approved')), { kind: 'orchestrator' }, {}).text).toBe('The plan of this run is approved already.')
  })

  test('only a proposed plan can be approved, once', () => {
    expect(approvePlan(raw(planned('draft'))).text).toContain('has not proposed a plan yet')
    const ledger = raw(planned('proposed'))
    expect(approvePlan(ledger).text).toContain('Complete delivery includes reviewed PR merges into main')
    expect((ledger.run as Record<string, unknown>).plan).toBe('approved')
    expect(approvePlan(ledger).isChanged).toBe(false)
    expect(ledger.run).toMatchObject({ delivery: 'complete', deliveryBase: 'main' })
  })

  test('a ticket filed after the approval is recorded on its task, by the orchestrator alone', () => {
    const ledger = raw()
    expect(updateTask(ledger, AT, { kind: 'worker', taskId: 't392-1' }, { task: 't392-1', ticket: 601 }).text).toContain('Only the orchestrator sets a task’s ticket.')
    expect(updateTask(ledger, AT, { kind: 'orchestrator' }, { task: 't392-1', ticket: 0 }).isError).toBe(true)
    expect(updateTask(ledger, AT, { kind: 'orchestrator' }, { task: 't392-1', ticket: 601 }).text).toContain('ticket 601')
    expect(ledger.tasks.find(one => one.id === 't392-1')?.ticket).toBe(601)
  })

  test('a compaction during planning carries the plan state and what the plan check still finds', () => {
    const overlapping: Ledger = {
      ...planned('draft'),
      tasks: [
        { id: 'a', title: 'A', tier: 'sonnet', status: 'queued', files: ['api/main.py'] },
        { id: 'b', title: 'B', tier: 'sonnet', status: 'queued', files: ['api'] },
      ],
    }
    const draft = handover(overlapping, { at: AT })
    expect(draft).toContain('The plan is a draft: no worker starts before it is proposed with mcp__conductor__run_plan and the owner approves it.')
    expect(draft).toContain('## Plan check\n- a and b could run at once and both change api/main.py: order them with dependsOn, or split the files.')
    const proposed = handover({ ...overlapping, run: { ...overlapping.run, plan: 'proposed' } }, { at: AT })
    expect(proposed).toContain("The plan waits for the owner's approval (/approve): no worker starts before that.")
    const approved = handover({ ...overlapping, run: { ...overlapping.run, plan: 'approved' } }, { at: AT })
    expect(approved).not.toContain('Plan check')
    expect(approved).not.toContain('The plan ')
  })
})

describe('slicing', () => {
  test('a task that names more files than one worker should take on is refused', () => {
    const files = Array.from({ length: 13 }, (_, at) => `api/file_${at}.py`)
    const said = addTask(raw(), { kind: 'orchestrator' }, { id: 't400-1', title: 'Too much', tier: 'sonnet', tierReason: 'big', files })
    expect(said.text).toBe('13 files is more than one worker should take on (12): slice this into smaller tasks, ordered with dependsOn.')
    expect(addTask(raw(), { kind: 'orchestrator' }, { id: 't400-1', title: 'Fine', tier: 'sonnet', tierReason: 'ok', files: files.slice(0, 12) }).isError).toBe(false)
  })

  test('the plan check names tasks that could run at once on one file, and tasks that name no files', () => {
    const ledger: Ledger = {
      ...LEDGER,
      tasks: [
        { id: 'a', title: 'A', tier: 'sonnet', status: 'queued', files: ['api/main.py', 'api/overload.py'] },
        { id: 'b', title: 'B', tier: 'sonnet', status: 'queued', files: ['api'] },
        { id: 'c', title: 'C', tier: 'haiku', status: 'queued', files: ['api/main.py'], dependsOn: ['b'] },
        { id: 'd', title: 'D', tier: 'haiku', status: 'queued' },
        { id: 'e', title: 'E', tier: 'haiku', status: 'done', files: ['api'] },
      ],
    }
    expect(preflight(ledger)).toEqual([
      'a and b could run at once and both change api/main.py, api/overload.py: order them with dependsOn, or split the files.',
      'a and c could run at once and both change api/main.py: order them with dependsOn, or split the files.',
      'd names no files: say what it is expected to change.',
    ])
    const ordered: Ledger = { ...ledger, tasks: ledger.tasks.map(one => (one.id === 'b' ? { ...one, dependsOn: ['a'] } : one)) }
    expect(preflight(ordered), 'c waits for b, which waits for a').toEqual(['d names no files: say what it is expected to change.'])
  })

  test('two workers never build on one file at once', () => {
    const ledger = withTask('t392-1', { files: ['api/overload.py'] })
    const building: Ledger = { ...ledger, tasks: ledger.tasks.map(one => (one.id === 't391-1' ? { ...one, files: ['api'] } : one)) }
    const decided = route(building, { ...worker, name: 't392-1' })
    expect(decided.kind === 'deny' ? decided.text : '').toBe(
      'conductor: t392-1 and t391-1, which is building, both change api/overload.py. Start t392-1 after t391-1 is done, or split the files.',
    )
  })

  test('each worker building gets the lowest number that is free, and keeps it', () => {
    const taken: Ledger = { ...LEDGER, tasks: LEDGER.tasks.map(one => (one.id === 't391-1' ? { ...one, slot: 1 } : one.id === 't394-1' ? { ...one, slot: 3 } : one)) }
    expect(route(taken, { ...worker, name: 't392-1' })).toMatchObject({ kind: 'worker', slot: 2 })
    const ledger = raw(taken)
    spawned(ledger, AT, { name: 't392-1', agentId: 'a1', model: 'claude-haiku-5-5', slot: 2 })
    expect(ledger.tasks.find(one => one.id === 't392-1')?.slot).toBe(2)
  })

  test('the project\'s own rules for a worker follow its briefing, with its own names filled in', () => {
    const brief = 'Project rules.\n- Your database: app_{task}_ci. Redis database {slot}. Scratch: scratchpad/{task}/. Run {run}.'
    const text = briefing(LEDGER, LEDGER.tasks.find(one => one.id === 't392-1')!, { brief, slot: 2 })
    expect(text.endsWith('Project rules.\n- Your database: app_t392_1_ci. Redis database 2. Scratch: scratchpad/t392_1/. Run demo.')).toBe(true)
    expect(briefing(LEDGER, LEDGER.tasks[0]!, { brief: '  ', slot: 1 })).not.toContain('Project rules')
  })
})

const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const call = ($: Engine, tool: string, input: Record<string, unknown>) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ text?: string }>)({ tool: `mcp__conductor__${tool}`, tool_use_id: `call-${tool}`, ...input })

describe('what was typed after /conduct', () => {
  const ISSUE = { id: '12', source: '#12', kind: 'issue' }
  const TITLED = { ...ISSUE, title: 'Retry the flaky upload' }
  const error = (args: string): string => {
    const read = conducting(args)

    return 'error' in read ? read.error : `accepted as ${read.id}`
  }

  test('an issue number is enough: the run is named by it', () => {
    expect(conducting('#12')).toEqual(ISSUE)
    expect(conducting('  #12  ')).toEqual(ISSUE)
    expect(conducting('12'), 'a bare number in first place').toEqual(ISSUE)
    expect(conducting('https://github.com/acme/widgets/issues/12')).toEqual(ISSUE)
    expect(conducting('https://github.com/acme/widgets/issues/12#issuecomment-5837')).toEqual(ISSUE)
  })

  test('every other word is the title, before the issue or after it, quoted or not', () => {
    for (const typed of [
      '#12 Retry the flaky upload',
      'Retry the flaky upload #12',
      '"Retry the flaky upload" #12',
      "#12 'Retry the flaky upload'",
      'Retry the #12 flaky upload',
      '12 Retry   the flaky upload',
    ]) {
      expect(conducting(typed), typed).toEqual(TITLED)
    }
    expect(conducting('#12 Phase 2'), 'a number in the title is no issue').toEqual({ ...ISSUE, title: 'Phase 2' })
    expect(conducting('#12 "half open'), 'a quote left open is dropped').toEqual({ ...ISSUE, title: 'half open' })
    expect((conducting(`#12 ${'long '.repeat(40)}`) as { title: string }).title).toHaveLength(120)
  })

  test('a spec document names the run by its file', () => {
    expect(conducting('docs/superpowers/specs/2026-10-09-billing-screens.md')).toEqual({
      id: '2026-10-09-billing-screens',
      source: 'docs/superpowers/specs/2026-10-09-billing-screens.md',
      kind: 'spec',
    })
    expect(conducting('spec.md Billing screens')).toEqual({ id: 'spec', source: 'spec.md', kind: 'spec', title: 'Billing screens' })
    expect(conducting('"docs/my spec (v2).md"')).toMatchObject({ id: 'my-spec-v2', source: 'docs/my spec (v2).md' })
    expect(conducting('#12 docs/spec.md'), 'an issue comes before a path').toEqual({ ...ISSUE, title: 'docs/spec.md' })
  })

  test('id= names the run when its own name would not do', () => {
    expect(conducting('#12 id=retry-2 Second try')).toEqual({ id: 'retry-2', source: '#12', kind: 'issue', title: 'Second try' })
    expect(conducting('ID=retry-2 #12')).toMatchObject({ id: 'retry-2' })
    expect(error('#12 id=../x')).toBe('"../x" is no run id: letters, digits, _ and -, at most 64, a letter or digit first.')
    expect(error('#12 id=')).toContain('is no run id')
    expect(error('docs/---.md')).toBe('The name of docs/---.md gives no run id. Name the run yourself: /conduct docs/---.md id=<run id> (letters, digits, _ and -).')
    expect(conducting('docs/---.md id=dashes')).toMatchObject({ id: 'dashes', kind: 'spec' })
  })

  test('with nothing to start from it says what it takes', () => {
    for (const typed of ['', '   ', 'Retry the flaky upload', 'Phase 2', '#0', '#abc', 'id=x']) {
      expect(error(typed), JSON.stringify(typed)).toBe(CONDUCT_USAGE)
    }
  })
})

test('/conduct starts a run, the orchestrator plans, and no worker starts before /approve', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const path = ledgerPath('334')
  const files: Files = { [`${ROOT}/.claude/conductor/brief.md`]: { text: 'Project rules. Database app_{task}_ci, Redis {slot}.', mtimeMs: 1 } }
  const engine = world(on, files)
  await start($)
  const stored = (): Ledger => JSON.parse(files[path]?.text ?? '{}') as Ledger

  expect((await command($, 'conduct', 'capacity')).text, 'nothing to start from').toBe(CONDUCT_USAGE)
  expect(files[path], 'and nothing was started').toBeUndefined()
  const started = await command($, 'conduct', '#334')
  expect(started.text).toBe(
    'Run 334 is started from #334. The plan comes next; nothing starts before you /approve it.',
  )
  expect(stored().run).toEqual({ id: '334', title: 'Run 334', source: '#334', startedAt: new Date(NOW).toISOString(), plan: 'draft' })
  expect((await command($, 'conduct', 'Nightly #334')).text).toBe(
    'Run 334 exists already: /board 334 binds this session to it. For another run from the same issue, give it a name of its own: /conduct #334 id=<run id>.',
  )
  await clock.advance(5000)
  expect(engine.woke).toEqual([planning('334', '#334')])
  expect(engine.woke[0]).toContain('the owner started run `334` from #334. Plan it; start no worker yet.')
  expect((await picture$($, 'desktop')).source).toContain('>The orchestrator is drafting the plan.<')

  await call($, 'task_add', { id: 't391-1', title: 'Pool exhaustion answers 503', tier: 'sonnet', tierReason: 'middleware and tests', files: ['api/overload.py'], ticket: 391 })
  engine.agentIds.push('a1')
  expect((await spawn($, 't391-1')).deny, 'a draft').toContain('still a draft')
  expect((await command($, 'approve')).text, 'nothing proposed yet').toContain('has not proposed a plan yet')

  expect((await call($, 'run_plan', { title: 'Nightly import speed' })).text).toContain('The plan is proposed: 1 task.')
  expect((await spawn($, 't391-1')).deny, 'proposed').toContain("waits for the owner's approval")
  await clock.advance(2000)
  const waiting = await picture$($, 'desktop')
  expect(waiting.source).toContain('>The plan waits for you<')
  expect(waiting.alt).toContain('Nightly import speed: plan waits for your approval')
  expect((await call($, 'board_read', {})).text).toContain("The plan waits for the owner's approval (/approve)")

  expect((await command($, 'approve')).text).toContain('Plan approved: 1 task may start.')
  await clock.advance(5000)
  expect(engine.woke.at(-1)).toBe(APPROVED)
  expect((await spawn($, 't391-1')).agentId).toBe('a1')
  expect(stored().tasks[0]).toMatchObject({ status: 'building', slot: 1 })
  expect(engine.briefs.at(-1)?.endsWith('Project rules. Database app_t391_1_ci, Redis 1.')).toBe(true)
})

test('/conduct takes a title, a name of its own and a spec document; /board takes the issue number with its #', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [`${ROOT}/docs/specs/billing-screens.md`]: { text: '# Billing screens', mtimeMs: 1 } }
  const engine = world(on, files)
  await start($)
  const run = (id: string): Ledger['run'] => (JSON.parse(files[ledgerPath(id)]?.text ?? '{}') as Ledger).run

  // What the owner typed on 2026-10-09: the title first, then the issue.
  expect((await command($, 'conduct', 'Retry the flaky upload #12')).text).toContain('Run 12 is started from #12, called "Retry the flaky upload". The plan comes next')
  expect(run('12')).toMatchObject({ id: '12', title: 'Retry the flaky upload', source: '#12', plan: 'draft' })
  await clock.advance(5000)
  expect(engine.woke.at(-1)).toContain('the owner started run `12` from #12, and calls it "Retry the flaky upload". Plan it; start no worker yet.')

  expect((await command($, 'conduct', '#12 id=retry-2')).text).toContain('Run retry-2 is started from #12')
  expect(run('retry-2')).toMatchObject({ id: 'retry-2', title: 'Run retry-2', source: '#12' })
  expect((await command($, 'conduct', '#12 id=none')).text).toContain('no run can have that name')

  expect((await command($, 'conduct', 'docs/specs/billing-screens.md')).text).toContain('Run billing-screens is started from docs/specs/billing-screens.md')
  expect((await command($, 'conduct', 'docs/specs/billing-screens.md')).text).toContain('For another run from the same spec, give it a name of its own: /conduct docs/specs/billing-screens.md id=<run id>.')
  expect((await command($, 'conduct', 'docs/specs/nope.md')).text).toBe(
    'There is no file docs/specs/nope.md here, so there is nothing to start a run from. For an issue, give its number: /conduct #12.',
  )
  expect(files[ledgerPath('nope')]).toBeUndefined()

  expect((await board($, '#12')).text).toContain('This session is bound to run 12.')
  expect(engine.store['bound:session-1']).toMatchObject({ run: '12' })
  expect((await board($, '#x')).text).toBe('"#x" is not a run id: letters, digits, _ and -, at most 64.')
})

describe('the plan hash', () => {
  const copy = (ledger: Ledger = LEDGER): Ledger => JSON.parse(JSON.stringify(ledger)) as Ledger
  const one = (ledger: Ledger, id: string) => ledger.tasks.find(each => each.id === id)!
  const ON = 'a'.repeat(64)

  test('the plan hash ignores status and notes', () => {
    const plain = canonicalPlan(LEDGER)
    const moved = copy()
    one(moved, 't392-1').status = 'green'
    one(moved, 't392-1').note = 'Halfway through the router.'
    one(moved, 't392-1').worker = 'someone-else'
    one(moved, 't392-1').revision = 'b'.repeat(64)
    moved.problems = []
    moved.run.pausedAt = '2026-10-09T10:00:00Z'
    expect(canonicalPlan(moved)).toBe(plain)

    const edits: Array<[string, (ledger: Ledger) => void]> = [
      ['title', l => (one(l, 't392-1').title = 'Another title')],
      ['tier', l => (one(l, 't392-1').tier = 'opus')],
      ['agent', l => (one(l, 't392-1').agent = 'builder')],
      ['effort', l => (one(l, 't392-1').effort = 'high')],
      ['dependency', l => (one(l, 't392-1').dependsOn = ['t390-1'])],
      ['file', l => (one(l, 't392-1').files = [...(one(l, 't392-1').files ?? []), 'extra.ts'])],
      ['run title', l => (l.run.title = 'Another run')],
      ['task', l => l.tasks.pop()],
    ]
    for (const [name, edit] of edits) {
      const changed = copy()
      edit(changed)
      expect(canonicalPlan(changed), name).not.toBe(plain)
    }
  })

  test('the plan is the same whatever order its tasks, files and dependencies come in', () => {
    const shuffled = copy()
    shuffled.tasks.reverse()
    for (const each of shuffled.tasks) {
      each.files = [...(each.files ?? [])].reverse()
      each.dependsOn = [...(each.dependsOn ?? [])].reverse()
    }
    expect(canonicalPlan(shuffled)).toBe(canonicalPlan(LEDGER))
    const parsed = JSON.parse(canonicalPlan(LEDGER)) as { run: Record<string, string>; tasks: { id: string }[] }
    expect(Object.keys(parsed.run)).toEqual(['base', 'id', 'title'])
    expect(parsed.tasks.map(each => each.id)).toEqual([...parsed.tasks.map(each => each.id)].sort())
  })

  test('the base is the run branch base, the workspace base or main, and a given base wins', () => {
    expect(JSON.parse(canonicalPlan(LEDGER)).run.base).toBe('main')
    const lore = copy()
    lore.run.lore = { remote: 'r', repository: 'x', base: 'develop', branch: 'run/demo' }
    expect(JSON.parse(canonicalPlan(lore)).run.base).toBe('develop')
    expect(JSON.parse(canonicalPlan(lore, 'release')).run.base).toBe('release')
  })

  test('a stale plan hash is refused, naming both hashes', () => {
    const gate = planGate(ON, { planSha256: 'b'.repeat(64), decision: { by: 'decider:engineering', ref: 'D1' } }, AT)
    expect(gate).toEqual({ error: expect.stringContaining('b'.repeat(64)) })
    expect('error' in gate && gate.error).toContain(ON)
  })

  test('a decision names the plan hash, and what it names is what is recorded', () => {
    expect(planGate(ON, { decision: { by: 'decider:engineering', ref: 'D1' } }, AT)).toEqual({ error: expect.stringContaining('planSha256') })
    expect(planGate(ON, { planSha256: ON, decision: { by: 'decider:engineering', agent: 'lead-a', ref: 'D1', at: 'forged' } }, AT)).toEqual({
      decision: { by: 'decider:engineering', agent: 'lead-a', ref: 'D1', at: AT, sha256: ON },
    })
    expect(planGate(ON, {}, AT)).toEqual({})
    expect(planGate(ON, { planSha256: ON }, AT)).toEqual({})
    for (const decision of ['x', { by: 'decider:engineering' }, { ref: 'D1' }, { by: 7, ref: 'D1' }, { by: 'decider:engineering', ref: 'D1', agent: 4 }]) {
      expect('error' in planGate(ON, { planSha256: ON, decision }, AT), JSON.stringify(decision)).toBe(true)
    }
    expect('error' in planGate(ON, { planSha256: 'nope', decision: { by: 'decider:engineering', ref: 'D1' } }, AT)).toBe(true)
  })

  test('the board, the digest and the handover say who decided each gate, with the ref and the hash or revision', () => {
    const decided = copy()
    decided.run.decisions = {
      plan: { by: 'decider:engineering', agent: 'lead-a', ref: 'D1', at: AT, sha256: ON, delivery: 'complete' },
      main: { by: 'person:p1', ref: 'D2', at: AT, revision: 'c'.repeat(64), base: 'd'.repeat(64) },
    }
    const lines = decisionLines(decided)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('decider:engineering')
    for (const piece of ['lead-a', 'D1', ON, 'complete']) expect(lines[0], piece).toContain(piece)
    for (const piece of ['person:p1', 'D2', 'c'.repeat(64)]) expect(lines[1], piece).toContain(piece)
    expect(decisionLines(LEDGER)).toEqual([])
    expect(boardView(decided, NOW).decisions).toEqual(lines)
    expect(boardView(LEDGER, NOW).decisions).toBeUndefined()
    expect(handover(decided, { at: AT })).toContain(lines[0]!)
    expect(handover(LEDGER, { at: AT })).not.toContain('approved by')
    const facts = factsLines(decided, ON)
    expect(facts.join('\n')).toContain(`Plan sha256: ${ON}`)
    expect(facts.join('\n')).toContain(lines[1]!)
  })

  test('the facts a decider reads: department, place, delivery, the Lore head and base, the check', () => {
    const run = copy()
    run.run.callers = { department: 'engineering' }
    run.run.workspace = { kind: 'lore', root: '/h/game-code', place: 'game-code', base: 'main' }
    run.run.delivery = 'review-only'
    run.run.deliveryBase = 'main'
    run.run.lore = { remote: 'r', repository: 'x', base: 'main', branch: 'run/demo', head: 'c'.repeat(64), baseAt: 'd'.repeat(64) }
    run.run.check = { revision: 'c'.repeat(64), verdict: 'passed', at: AT }
    const text = factsLines(run, ON).join('\n')
    for (const piece of ['Department: engineering', 'Place: game-code', 'Delivery: review-only', `Lore head: ${'c'.repeat(64)}`, `Lore base at: ${'d'.repeat(64)}`, 'Check: passed', ON]) {
      expect(text, piece).toContain(piece)
    }
  })
})
