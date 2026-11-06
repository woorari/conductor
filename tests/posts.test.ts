import { describe, expect, test } from 'claude-code/testing'

import { parseLedger } from '../hooks/ledger'
import { briefing, digest, post, relative, rule, touch, waiting } from '../hooks/posts'
import { addTask, markRead, normalise, overlap } from '../hooks/signals'
import type { Caller, Raw } from '../hooks/signals'
import type { Ledger } from '../types'
import { LEDGER } from './fixture'

const AT = '2026-10-09T10:30:00.000Z'
const ORCHESTRATOR: Caller = { kind: 'orchestrator' }
const worker = (taskId: string): Caller => ({ kind: 'worker', taskId })

/** The fixture with its two building workers known by agent id, and what each is expected to change. */
function raw(): Raw {
  const ledger = JSON.parse(JSON.stringify(LEDGER)) as Raw
  const set = (id: string, more: Record<string, unknown>) => Object.assign(ledger.tasks.find(one => one.id === id)!, more)
  set('t391-1', { agentId: 'a391', files: ['api/overload.py', 'api/main.py'] })
  set('t394-1', { agentId: 'a394', files: ['api/ai_budget.py', 'api/tests'] })
  set('t393-1', { agentId: 'a393', files: ['api/routers'] })
  set('t396-1', { agentId: 'a396' })

  return ledger
}
const parsed = (ledger: Raw): Ledger => parseLedger(JSON.stringify(ledger)).ledger!
const task = (ledger: Raw, id: string) => ledger.tasks.find(one => one.id === id)!

describe('paths as the board compares them', () => {
  test('a path is relative to the repository, whichever worktree it was edited in', () => {
    expect(relative('/repo/api/overload.py', '/repo')).toBe('api/overload.py')
    expect(relative('/repo/.claude/worktrees/agent-7f/api/overload.py', '/repo')).toBe('api/overload.py')
    expect(relative('/elsewhere/.claude/worktrees/w1/api/overload.py', '/repo')).toBe('api/overload.py')
    expect(normalise('./api//tests/')).toBe('api/tests')
  })

  test('a file overlaps itself and any folder it lies in, and nothing else', () => {
    expect(overlap('api/tests/test_x.py', 'api/tests')).toBe(true)
    expect(overlap('api', 'api/overload.py')).toBe(true)
    expect(overlap('api/overload.py', 'api/overload.py')).toBe(true)
    expect(overlap('api/overload.py', 'api/overload_test.py')).toBe(false)
    expect(overlap('api/tests', 'api/tests_old')).toBe(false)
  })
})

describe('a finding', () => {
  test('is for the workers building on the files it names, and for nobody else', () => {
    const ledger = raw()
    const said = post(ledger, AT, worker('t394-1'), {
      kind: 'finding',
      text: 'The pool middleware must stay outside CORS.',
      files: ['api/main.py'],
    })
    const source = { list: 'posts' as const, id: 'F1' }
    expect(said.text).toBe('F1 posted; for t391-1, who reads it at the next step.')
    expect(said.deliveries).toEqual([
      { taskId: 't391-1', text: 'Run board, finding F1 from t394-1: The pool middleware must stay outside CORS. (files: api/main.py)', source },
    ])
    expect(ledger.posts).toEqual([
      { id: 'F1', kind: 'finding', text: 'The pool middleware must stay outside CORS.', from: 't394-1', at: AT, files: ['api/main.py'], for: ['t391-1'] },
    ])
    expect(parseLedger(JSON.stringify(ledger)).error).toBeUndefined()
  })

  test('waits for its reader until it was handed over, as the ledger alone says', () => {
    const ledger = raw()
    const said = post(ledger, AT, worker('t394-1'), { kind: 'finding', text: 'Stay outside CORS.', files: ['api/main.py'] })
    rule(ledger, AT, { kind: 'orchestrator' }, { text: 'One merge at a time.' })
    expect(waiting(parsed(ledger)).map(one => [one.taskId, one.source?.id])).toEqual([
      ['t391-1', 'F1'],
      ['t391-1', 'R1'],
      ['t394-1', 'R1'],
    ])
    expect(waiting(parsed(ledger))[0]?.text, 'the same words after a reload').toBe(said.deliveries?.[0]?.text)

    const read = [{ source: { list: 'posts' as const, id: 'F1' }, taskId: 't391-1' }]
    expect(markRead(ledger, read)).toBe(true)
    expect(ledger.posts?.[0]?.deliveredTo).toEqual(['t391-1'])
    expect(markRead(ledger, read), 'once').toBe(false)
    const closed = parsed(ledger)
    closed.tasks.find(one => one.id === 't394-1')!.status = 'done'
    expect(waiting(closed).map(one => one.taskId), 'nothing waits for a finished task').toEqual(['t391-1'])
    expect(waiting(parsed(ledger)).map(one => [one.taskId, one.source?.id])).toEqual([
      ['t391-1', 'R1'],
      ['t394-1', 'R1'],
    ])
  })

  test('reaches a worker through a folder it declared, or a file it has changed', () => {
    const ledger = raw()
    expect(post(ledger, AT, ORCHESTRATOR, { kind: 'finding', text: 'x', files: ['api/tests/test_pool.py'] }).deliveries?.map(one => one.taskId)).toEqual(['t394-1'])
    task(ledger, 't391-1').touched = ['frontend/src/api/client.ts']
    expect(post(ledger, AT, ORCHESTRATOR, { kind: 'finding', text: 'y', files: ['frontend/src/api'] }).deliveries?.map(one => one.taskId)).toEqual(['t391-1'])
  })

  test('is never sent to its own poster, to a stopped worker, or without files', () => {
    const ledger = raw()
    expect(post(ledger, AT, worker('t391-1'), { kind: 'finding', text: 'mine', files: ['api/overload.py'] }).deliveries).toEqual([])
    const stopped = post(ledger, AT, ORCHESTRATOR, { kind: 'finding', text: 'routers', files: ['api/routers/coach.py'] })
    expect(stopped.deliveries, 't393-1 is in review, not building').toEqual([])
    expect(stopped.text).toContain('no worker is on those files now')
    const loose = post(ledger, AT, ORCHESTRATOR, { kind: 'finding', text: 'general' })
    expect(loose.deliveries).toEqual([])
    expect(loose.text).toBe('F3 posted; it names no files, so it is on the board and goes to nobody.')
  })

  test('needs a kind, words and a real list of files, from someone of the run', () => {
    expect(post(raw(), AT, ORCHESTRATOR, { kind: 'rumour', text: 'x' }).isError).toBe(true)
    expect(post(raw(), AT, ORCHESTRATOR, { kind: 'finding', text: ' ' }).isError).toBe(true)
    expect(post(raw(), AT, ORCHESTRATOR, { kind: 'finding', text: 'x', files: 'api' }).isError).toBe(true)
    expect(post(raw(), AT, ORCHESTRATOR, { kind: 'finding', text: 'x'.repeat(601) }).isError).toBe(true)
    expect(post(raw(), AT, { kind: 'stranger' }, { kind: 'finding', text: 'x' }).isError).toBe(true)
  })
})

describe('a question and its ruling', () => {
  test('a worker\'s question wakes the orchestrator and goes to no worker', () => {
    const ledger = raw()
    const said = post(ledger, AT, worker('t391-1'), { kind: 'question', text: 'May the 503 carry a Retry-After of 2?' })
    expect(said.text).toContain('Q1 asked; the orchestrator is told.')
    expect(said.wake).toBe(
      'Run board: t391-1 asks Q1: May the 503 carry a Retry-After of 2?',
    )
    expect(said.deliveries).toBeUndefined()
    expect(post(raw(), AT, ORCHESTRATOR, { kind: 'question', text: 'x' }).text).toContain('Ask the owner in the conversation')
  })

  test('a ruling that answers a question is numbered, closes it and is for the asker', () => {
    const ledger = raw()
    post(ledger, AT, worker('t391-1'), { kind: 'question', text: 'May the 503 carry a Retry-After of 2?' })
    const said = rule(ledger, AT, ORCHESTRATOR, { text: 'Yes, 2 seconds.', answers: 'Q1' })
    expect(said.text).toBe('R1 recorded (answers Q1); for t391-1, who reads it at the next step.')
    expect(said.deliveries).toEqual([
      { taskId: 't391-1', text: 'Run board, ruling R1 (answers Q1): Yes, 2 seconds.', source: { list: 'rulings', id: 'R1' } },
    ])
    expect(ledger.posts?.[0]).toMatchObject({ id: 'Q1', answeredBy: 'R1' })
    expect(ledger.rulings).toEqual([{ id: 'R1', text: 'Yes, 2 seconds.', at: AT, answers: 'Q1', for: ['t391-1'] }])
    expect(rule(ledger, AT, ORCHESTRATOR, { text: 'Again.', answers: 'Q1' }).text).toBe('Q1 was answered by R1.')
    expect(parseLedger(JSON.stringify(ledger)).error).toBeUndefined()
  })

  test('a ruling for a stopped worker waits for it, and says that starting it is the orchestrator\'s to do', () => {
    const ledger = raw()
    const said = rule(ledger, AT, ORCHESTRATOR, { text: 'Use the second box from Monday.', tasks: ['t396-1', 't393-1', 't391-1'] })
    expect(said.text).toBe(
      'R1 recorded; for t391-1, who reads it at the next step; t393-1, t396-1 have stopped and read it on running again: send each a message to start them.',
    )
    expect(said.deliveries?.map(one => one.taskId)).toEqual(['t391-1', 't393-1', 't396-1'])
    expect(ledger.rulings?.[0]).toMatchObject({ tasks: ['t396-1', 't393-1', 't391-1'], for: ['t391-1', 't393-1', 't396-1'] })
    expect(rule(raw(), AT, ORCHESTRATOR, { text: 'x', tasks: ['t396-1'] }).text).toBe(
      'R1 recorded; t396-1 has stopped and reads it on running again: send it a message to start it.',
    )
  })

  test('a ruling that names nobody goes to the workers building now, and never to a finished task', () => {
    const ledger = raw()
    task(ledger, 't390-1').agentId = 'a390'
    expect(rule(ledger, AT, ORCHESTRATOR, { text: 'One merge at a time.' }).deliveries?.map(one => one.taskId)).toEqual(['t391-1', 't394-1'])
    expect(rule(ledger, AT, ORCHESTRATOR, { text: 'For the record.', tasks: ['t390-1'] }).text).toBe('R2 recorded; no worker to read it now.')
  })

  test('only the orchestrator rules, on real tasks and open questions', () => {
    expect(rule(raw(), AT, worker('t391-1'), { text: 'x' }).isError).toBe(true)
    expect(rule(raw(), AT, ORCHESTRATOR, { text: '' }).isError).toBe(true)
    expect(rule(raw(), AT, ORCHESTRATOR, { text: 'x', tasks: ['t999'] }).text).toBe('There is no task t999 in this run.')
    expect(rule(raw(), AT, ORCHESTRATOR, { text: 'x', answers: 'Q9' }).text).toBe('There is no question Q9 on the board.')
  })
})

describe('two tasks on one file', () => {
  test('the files a worker changes are remembered as its task\'s', () => {
    const ledger = raw()
    expect(touch(ledger, AT, 't391-1', ['api/overload.py', 'api/tests/test_pool.py']).isChanged).toBe(true)
    expect(task(ledger, 't391-1').touched).toEqual(['api/overload.py', 'api/tests/test_pool.py'])
    expect(touch(ledger, AT, 't391-1', ['api/overload.py']).isChanged, 'a file already known changes nothing').toBe(false)
  })

  test('changing a file another open task is expected to change is recorded once and told to both and the orchestrator', () => {
    const ledger = raw()
    const said = touch(ledger, AT, 't391-1', ['api/tests/test_pool.py'])
    expect(ledger.problems?.at(-1)).toEqual({
      id: 'P4',
      text: 't391-1 and t394-1 both change api/tests/test_pool.py.',
      severity: 'warning',
      status: 'open',
      taskId: 't391-1',
      foundAt: AT,
    })
    expect(said.deliveries?.map(one => [one.taskId, one.text.slice(0, 60)])).toEqual([
      ['t391-1', 'Run board: t394-1 also changes api/tests/test_pool.py (P4). '],
      ['t394-1', 'Run board: t391-1 also changes api/tests/test_pool.py (P4). '],
    ])
    expect(said.tell).toBe('Run board: two tasks change the same file. P4: t391-1 and t394-1 both change api/tests/test_pool.py. Decide their order, or rule who yields.')

    const again = touch(ledger, AT, 't394-1', ['api/tests/test_pool.py'])
    expect(again.tell, 'the same pair on the same file is not reported twice').toBeUndefined()
    expect(ledger.problems).toHaveLength(4)
  })

  test('two workers changing the same undeclared file are caught by what each has changed', () => {
    const ledger = raw()
    touch(ledger, AT, 't391-1', ['contracts/openapi.json'])
    const said = touch(ledger, AT, 't394-1', ['contracts/openapi.json'])
    expect(said.tell).toContain('t391-1 and t394-1 both change contracts/openapi.json.')
  })

  test('a finished task is no conflict, and a stopped worker is not messaged', () => {
    const ledger = raw()
    task(ledger, 't390-1').touched = ['api/settings.py']
    expect(touch(ledger, AT, 't391-1', ['api/settings.py']).tell).toBeUndefined()
    const said = touch(ledger, AT, 't391-1', ['api/routers/coach.py'])
    expect(said.tell).toContain('t391-1 and t393-1 both change api/routers/coach.py.')
    expect(said.deliveries?.map(one => one.taskId), 't393-1 is in review').toEqual(['t391-1'])
  })

  test('two tasks of which one waits for the other are in order: changing the same file is no news', () => {
    const ledger = raw()
    // t392-2 waits for t391-1; a third task waits for t392-2, and so for t391-1 through it.
    task(ledger, 't392-2').files = ['api/overload.py', 'frontend/src/api']
    ledger.tasks.push({ id: 't392-3', title: 'Third in line', tier: 'haiku', status: 'queued', dependsOn: ['t392-2'], files: ['docs/overload'] })

    const first = touch(ledger, AT, 't391-1', ['api/overload.py', 'docs/overload/notes.md'])
    expect(first.isChanged, 'the files are remembered all the same').toBe(true)
    expect(task(ledger, 't391-1').touched).toEqual(['api/overload.py', 'docs/overload/notes.md'])
    expect([first.tell, first.deliveries], 'the one that waits, and the one that waits through it').toEqual([undefined, []])
    expect(ledger.problems).toHaveLength(3)

    // The other way round: the later task changes what the earlier one changed, once that one has handed back.
    Object.assign(task(ledger, 't391-1'), { status: 'review', finishedAt: AT })
    Object.assign(task(ledger, 't392-1'), { status: 'done' })
    Object.assign(task(ledger, 't392-2'), { status: 'building', agentId: 'a9', startedAt: AT })
    const later = touch(ledger, AT, 't392-2', ['api/overload.py'])
    expect([later.tell, later.deliveries]).toEqual([undefined, []])
    expect(ledger.problems).toHaveLength(3)
  })

  test('unless both are at work at once: the earlier task was sent back while the later one is built on it', () => {
    const ledger = raw()
    task(ledger, 't392-2').files = ['api/overload.py']
    Object.assign(task(ledger, 't392-1'), { status: 'done' })
    Object.assign(task(ledger, 't392-2'), { status: 'building', agentId: 'a9', startedAt: AT })
    // t391-1 is building in the fixture: its worker is at work too.
    const said = touch(ledger, AT, 't392-2', ['api/overload.py'])
    expect(said.tell).toBe('Run board: two tasks change the same file. P4: t391-1 and t392-2 both change api/overload.py. Decide their order, or rule who yields.')
    expect(said.deliveries?.map(one => one.taskId)).toEqual(['t392-2', 't391-1'])
  })

  test('two tasks that are in no order are still told, whoever of them is at work', () => {
    const ledger = raw()
    task(ledger, 't396-1').files = ['api/overload.py']
    expect(touch(ledger, AT, 't391-1', ['api/overload.py']).tell, 't396-1 is blocked and waits for nobody').toContain('t391-1 and t396-1 both change api/overload.py.')
  })

  test('adding a task says which open tasks its files are shared with', () => {
    const ledger = raw()
    const said = addTask(ledger, ORCHESTRATOR, { id: 't397-1', title: 'Busy line', tier: 'haiku', tierReason: 'copy only', files: ['api/main.py', 'frontend/src/copy'] })
    expect(said.text).toBe('t397-1 added: haiku, queued. It shares files with t391-1 on api/main.py: order them with dependsOn, or split the files.')
    expect(task(ledger, 't397-1').files).toEqual(['api/main.py', 'frontend/src/copy'])
  })
})

describe('what the board says to whom', () => {
  function busy(): Ledger {
    const ledger = raw()
    post(ledger, AT, worker('t394-1'), { kind: 'finding', text: 'The pool middleware must stay outside CORS.', files: ['api/main.py'] })
    post(ledger, AT, worker('t394-1'), { kind: 'finding', text: 'The budget read needs its own session.', files: ['api/ai_budget.py'] })
    post(ledger, AT, worker('t391-1'), { kind: 'question', text: 'May the 503 carry a Retry-After of 2?' })
    post(ledger, AT, worker('t394-1'), { kind: 'question', text: 'Is zero a valid budget?' })
    rule(ledger, AT, ORCHESTRATOR, { text: 'Zero switches AI off for that window.', answers: 'Q2' })
    rule(ledger, AT, ORCHESTRATOR, { text: 'One merge at a time.' })
    rule(ledger, AT, ORCHESTRATOR, { text: 'Use the second box.', tasks: ['t396-1'] })

    return parsed(ledger)
  }

  test('a worker reads the rulings that bind it, the findings on its files and its open questions', () => {
    const text = digest(busy(), worker('t391-1'))
    expect(text.split('\n')).toEqual([
      'The board, for t391-1:',
      '- Ruling R2: One merge at a time.',
      '- Finding F1 from t394-1 (api/main.py): The pool middleware must stay outside CORS.',
      '- Your question Q1 is not answered yet: May the 503 carry a Retry-After of 2?',
    ])
    expect(digest(busy(), worker('t394-1'))).toContain('- Ruling R1 (answers Q2): Zero switches AI off for that window.')
    expect(digest(parsed(raw()), worker('t391-1'))).toBe('Nothing on the board concerns t391-1 yet.')
  })

  test('a worker starts knowing its task, how it reports and what the board already holds for it', () => {
    const ledger = busy()
    const text = briefing(ledger, ledger.tasks.find(one => one.id === 't391-1')!)
    expect(text).toContain('You are the worker for task `t391-1` ("Pool exhaustion answers 503") of run `demo`, on the sonnet tier.')
    expect(text).toContain('mcp__conductor__task_update')
    expect(text).toContain('You cannot mark your task done')
    expect(text).toContain('Your task is expected to change: api/overload.py, api/main.py.')
    expect(text).toContain('  - Ruling R2: One merge at a time.')
    expect(text).toContain('  - Finding F1 from t394-1 (api/main.py)')
    expect(text).not.toContain('Use the second box')
    const bare = briefing(ledger, ledger.tasks.find(one => one.id === 't392-1')!)
    expect(bare).not.toContain('Your task is expected to change')
    expect(bare).toContain('- Ruling R2: One merge at a time.')
  })

  test('a worker that takes over a task is told it goes on from the one before', () => {
    const ledger = busy()
    const before = { ...ledger.tasks.find(one => one.id === 't393-1')!, branch: 'fix/393-loop', note: 'tests green, PR not opened' }
    expect(briefing(ledger, before)).toContain(
      '- A worker was on this task before you, on the branch fix/393-loop; its last note: tests green, PR not opened. Go on from where it stopped',
    )
    expect(briefing(ledger, ledger.tasks.find(one => one.id === 't392-1')!)).not.toContain('before you')
  })
})
