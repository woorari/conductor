import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { parseLedger } from '../hooks/ledger'
import { handover } from '../hooks/handover'
import { APPROVED, CONDUCT_USAGE, PLANNING, conducting, newRun, planning } from '../hooks/plan'
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
    expect(approvePlan(ledger).text).toBe('Plan approved: 9 tasks may start.')
    expect((ledger.run as Record<string, unknown>).plan).toBe('approved')
    expect(approvePlan(ledger).isError).toBe(true)
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

  expect((await command($, 'approve')).text).toBe('Plan approved: 1 task may start.')
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
