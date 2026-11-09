import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { APPROVED, isApproval } from '../hooks/plan'
import type { Ledger } from '../types'
import { LEDGER, NOW } from './fixture'
import { board, file, ledgerPath, start, world } from './world'
import type { Files } from './world'

const PATH = ledgerPath('demo')
const stored = (files: Files): Ledger => JSON.parse(files[PATH]?.text ?? '{}') as Ledger
type Submitted = { text?: string; context?: readonly string[]; drop?: string }
const reply = ($: Engine, text: string, kind = 'sdk', more: Record<string, unknown> = {}) =>
  ($.prompt.submit as unknown as (e: Record<string, unknown>) => Promise<Submitted>)({ text, wait: false, origin: { kind }, ...more })

describe('a reply that approves the plan', () => {
  test('says only to approve, and maybe to start: a button such as "Approve, start now"', () => {
    for (const text of ['Approve, start now', 'approve', 'Approved.', 'Yes, approve the plan', 'Approve and start', 'OK, approve. Go ahead!', '  APPROVE  ']) {
      expect(isApproval(text), text).toBe(true)
    }
  })

  test('is nothing else: a question, a condition, a negation, or approving something other than the plan', () => {
    for (const text of [
      'approve?',
      'Can you approve it?',
      'Approve, but drop c2-sight',
      "Don't approve yet",
      'Do not approve',
      'approve later',
      'Approve the merge of t1',
      'I approve of the idea',
      'start now',
      'yes',
      '',
      '/approve',
    ]) {
      expect(isApproval(text), text).toBe(false)
    }
  })
})

/** A bound session whose run has its plan proposed. */
async function proposed($: Engine, on: Parameters<typeof world>[0], plan: Ledger['run']['plan'] = 'proposed', run: Partial<Ledger['run']> = {}) {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file({ ...LEDGER, run: { ...LEDGER.run, plan, ...run } }, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')

  return { clock, files, engine }
}

test("the owner's approving reply approves the plan as /approve does, and the orchestrator reads that beside it", async ($, on) => {
  const { clock, files, engine } = await proposed($, on)
  const entered = await reply($, 'Approve, start now')
  expect(stored(files).run.plan).toBe('approved')
  expect(entered.text, 'the reply still reaches the orchestrator').toBe('Approve, start now')
  expect(entered.context).toEqual([`${APPROVED} The owner's reply "Approve, start now" counts as /approve. Plan approved: 9 tasks may start.`])
  await clock.advance(5000)
  expect(engine.woke.filter(one => one === APPROVED), 'said once, beside the reply, not again by the timer').toEqual([])
})

test('typed in the terminal, it approves too', async ($, on) => {
  const { files } = await proposed($, on)
  await reply($, 'approve', 'composer')
  expect(stored(files).run.plan).toBe('approved')
})

test('through Remote Control, it approves too', async ($, on) => {
  const { files } = await proposed($, on)
  await reply($, 'approve', 'bridge')
  expect(stored(files).run.plan).toBe('approved')
})

test('a reply that cannot approve yet says why beside it, as /approve would', async ($, on) => {
  const { files } = await proposed($, on, 'proposed', { candidates: [] })
  const entered = await reply($, 'Approve, start now')
  expect(stored(files).run.plan).toBe('proposed')
  expect(entered.context).toEqual([
    'Run board: the owner\'s reply "Approve, start now" asks to approve the plan, and it is not approved: Pick the run\'s workspace first: run_workspace takes one of the workspaces this run lists.',
  ])
})

test("nobody but the owner approves: another session's message, a channel, a plugin, a scheduled prompt", async ($, on) => {
  const { files } = await proposed($, on)
  for (const kind of ['peer', 'peer-send-message', 'channel', 'plugin', 'scheduled-trigger', 'task-notification', 'auto-continuation', 'unclassified']) {
    const entered = await reply($, 'Approve, start now', kind)
    expect(entered.context, kind).toBeUndefined()
  }
  expect(stored(files).run.plan).toBe('proposed')
})

test('a reply the person does not see as typed approves nothing', async ($, on) => {
  const { files } = await proposed($, on)
  await reply($, 'Approve, start now', 'sdk', { isMeta: true })
  expect(stored(files).run.plan).toBe('proposed')
})

test('a reply that is not only an approval approves nothing, and passes on as it came', async ($, on) => {
  const { files } = await proposed($, on)
  const entered = await reply($, 'Approve, but drop c2-sight')
  expect(stored(files).run.plan).toBe('proposed')
  expect(entered).toEqual({ text: 'Approve, but drop c2-sight' })
})

test('with no plan proposed, the word approves nothing and is not remarked on', async ($, on) => {
  const { files } = await proposed($, on, 'approved')
  expect(await reply($, 'Approve')).toEqual({ text: 'Approve' })
  expect(stored(files).run.plan).toBe('approved')
})

test('with only a draft, nothing is approved', async ($, on) => {
  const { files } = await proposed($, on, 'draft')
  expect(await reply($, 'Approve')).toEqual({ text: 'Approve' })
  expect(stored(files).run.plan).toBe('draft')
})

test('a session bound to no run approves nothing', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file({ ...LEDGER, run: { ...LEDGER.run, plan: 'proposed' } }, 1) }
  world(on, files)
  await start($)
  expect(await reply($, 'Approve, start now')).toEqual({ text: 'Approve, start now' })
  expect(stored(files).run.plan).toBe('proposed')
})
