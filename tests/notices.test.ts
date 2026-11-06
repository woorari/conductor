import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { abandoned } from '../hooks/merge'
import { PAUSED, UNPAUSED, pauseRun, unpauseRun } from '../hooks/pause'
import { APPROVED, PLANNING, planning } from '../hooks/plan'
import { post } from '../hooks/posts'
import type { Raw } from '../hooks/signals'
import type { Ledger, Merge } from '../types'
import { LEDGER, NOW } from './fixture'
import { board, file, ledgerPath, start, world } from './world'
import type { Files } from './world'

/**
 * The mod must not say too much. A notice the mod
 * wakes the orchestrator with is shown in the conversation, where the owner
 * reads it, so it says what happened and nothing else; what the orchestrator
 * does about it is a standing instruction the owner never sees. And what the
 * orchestrator writes to the owner is an executive summary, with detail only
 * where the owner has something to decide.
 */

const AT = '2026-10-09T10:30:00.000Z'
/** The longest a notice may be, in characters, for these fixtures: one line of the conversation, about two on a narrow pane. */
const NOTICE_MAX = 200
const raw = (ledger: Ledger = LEDGER): Raw => JSON.parse(JSON.stringify(ledger)) as Raw
const FLIGHT: Merge = { task: 't395-1', pr: 548, head: 'b'.repeat(40), state: 'merging', startedAt: AT }

describe('what the owner reads in the conversation', () => {
  const notices: Record<string, string | undefined> = {
    'the run is paused': pauseRun(raw(), AT).wake,
    'the pause ended': unpauseRun(raw({ ...LEDGER, run: { ...LEDGER.run, pausedAt: AT } })).wake,
    'a run was started': planning('12', '#12', 'Retry the flaky upload'),
    'the plan was approved': APPROVED,
    'a merge claim was let go': abandoned(raw({ ...LEDGER, merge: FLIGHT }), 'the merge call did not go through').tell,
    'a worker asks': post(raw(), AT, { kind: 'worker', taskId: 't391-1' }, { kind: 'question', text: 'May the 503 carry a Retry-After of 2?' }).wake,
  }

  for (const [what, text] of Object.entries(notices)) {
    test(`${what}: one short line that says what happened`, () => {
      expect(text, 'the orchestrator is told').toBeDefined()
      expect(text).toMatch(/^Run board: /)
      expect(text, 'one line').not.toContain('\n')
      expect(text?.length, `at most ${NOTICE_MAX} characters`).toBeLessThanOrEqual(NOTICE_MAX)
      expect(text, 'no tool is named: how to act on it is a standing instruction').not.toContain('mcp__')
    })
  }

  test('the two the owner sees most are a sentence each', () => {
    expect([PAUSED, UNPAUSED, APPROVED]).toEqual([
      'Run board: the owner paused the run.',
      'Run board: the owner ended the pause.',
      'Run board: the owner approved the plan.',
    ])
  })
})

const compose = ($: Engine) =>
  $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })

async function bound($: Engine, on: Parameters<typeof world>[0]) {
  mock.clock(on, { now: NOW })
  const files: Files = { [ledgerPath('demo')]: file(LEDGER, 1) }
  world(on, files)
  await start($)
  await board($, 'demo')
}

test('the orchestrator of a bound run is told to report to the owner in an executive summary, with detail only for a decision', async ($, on) => {
  await bound($, on)
  const text = (await compose($)).sections[1]?.text ?? ''
  expect(text).toContain(
    '- What you write to the owner is an executive summary. The board shows where every task stands, so do not repeat it: say what changed since you last wrote and what happens next, in a few lines at most, with no list of tasks, checks, files or commands. Go into detail only where the owner has something to decide: then say what is to decide, the options, and which one you recommend and why, as fully as the decision needs. The notices the board sends you show in the conversation too: never quote or restate one, and when one changes nothing for the owner, answer it in one line.',
  )
  expect(text.indexOf('- What you write to the owner'), 'the first thing it is told').toBeLessThan(text.indexOf('- The mod writes the ledger.'))
})

test('what the notices no longer say, the orchestrator is told once, out of the owner\'s sight', async ($, on) => {
  await bound($, on)
  const text = (await compose($)).sections[1]?.text ?? ''
  const kept = {
    'how a run is planned': PLANNING,
    'what follows the approval': 'Once they have, start the tasks that can start.',
    'how a pause ends': 'When the pause ends, read the board and go on: judge what was handed back, start what can start, and merge what is green, in order.',
    'a worker that stopped with the session': 'gets its worker started again with a message to the agent id the board lists: tell it first to run git status and git diff, and to commit and push what is its own.',
    'what follows a done task': 'When the board tells you a task is done, go on at once: start what can start and merge the next green task.',
    'a red base branch': "After each merge the board watches the checks on main: when they fail, find the merge that broke them and repair it before anything else merges; the repair's own merge takes onRedMain: true.",
    'how a question is answered': "A worker's question wakes you: answer it with mcp__conductor__board_rule, naming the question in answers.",
  }
  for (const [what, line] of Object.entries(kept)) expect(text, what).toContain(line)
  expect(PLANNING).toContain('4. Call mcp__conductor__run_plan with a title for the run. Then tell the owner the plan in a few lines and stop.')
})

test('a session bound to no run is told none of it', async ($, on) => {
  mock.clock(on, { now: NOW })
  world(on, { [ledgerPath('demo')]: file(LEDGER, 1) })
  await start($)
  expect((await compose($)).sections.map(one => one.id)).not.toContain('conductor:run')
})
