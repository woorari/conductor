import { expect, test } from 'claude-code/testing'
import { approveMerge, mergeApproved } from '../hooks/delivery'
import { parseLedger } from '../hooks/ledger'
import { LEDGER } from './fixture'
import type { Raw } from '../hooks/signals'

const HEAD = 'a'.repeat(40)
test('main approval is pinned to the reviewed task, PR, head and base', () => {
  const raw = JSON.parse(JSON.stringify(LEDGER)) as Raw
  expect(approveMerge(raw, 't395-1', HEAD, 'main').isError).toBe(false)
  const ledger = parseLedger(JSON.stringify(raw)).ledger!
  expect(mergeApproved(ledger, 't395-1', HEAD, 'main')).toBe(true)
  expect(mergeApproved(ledger, 't395-1', 'b'.repeat(40), 'main')).toBe(false)
  expect(mergeApproved(ledger, 't395-1', HEAD, 'other')).toBe(false)
  ledger.tasks.find(one => one.id === 't395-1')!.pr = 999
  expect(mergeApproved(ledger, 't395-1', HEAD, 'main')).toBe(false)
  expect(approveMerge(raw, 't392-1', HEAD, 'main').isError).toBe(true)
})

test('malformed approval records never become a merge permission', () => {
  const raw = JSON.parse(JSON.stringify(LEDGER))
  for (const value of [null, { pr: 548, head: 'short', base: 'main' }, { pr: '548', head: HEAD, base: 'main' }]) {
    raw.run.mergeApprovals = { 't395-1': value }
    expect(parseLedger(JSON.stringify(raw)).error).not.toBeUndefined()
  }
})

import { mock } from 'claude-code/testing'
import { board, file, ledgerPath, spawn, start, world } from './world'
import { NOW } from './fixture'
import { approvePlan, updateTask } from '../hooks/signals'

test('complete-delivery approval covers reviewed heads only in the approved base and respects pause', () => {
  const raw = JSON.parse(JSON.stringify(LEDGER)) as Raw
  raw.run.plan = 'proposed'; delete raw.run.mergeApprovals
  expect(approvePlan(raw, 'complete', 'main').isError).toBe(false)
  let ledger = parseLedger(JSON.stringify(raw)).ledger!
  expect(mergeApproved(ledger, 't395-1', HEAD, 'main')).toBe(true)
  expect(mergeApproved(ledger, 't395-1', 'b'.repeat(40), 'main')).toBe(true)
  expect(mergeApproved(ledger, 't395-1', HEAD, 'other')).toBe(false)
  expect(mergeApproved(ledger, 't392-1', HEAD, 'main')).toBe(false)
  raw.run.pausedAt = new Date(NOW).toISOString(); ledger = parseLedger(JSON.stringify(raw)).ledger!
  expect(mergeApproved(ledger, 't395-1', HEAD, 'main')).toBe(false)
})

test('necessary file and dependency adjustments retain plan approval and refuse conflicts or cycles', () => {
  const raw = JSON.parse(JSON.stringify(LEDGER)) as Raw
  raw.run.plan = 'proposed'; approvePlan(raw)
  const input = { task: 't392-1', files: ['src/api.ts', 'src/wake.ts'], scopeReason: 'Required validation within the approved outcome' }
  expect(updateTask(raw, new Date(NOW).toISOString(), { kind: 'worker', taskId: 't392-1' }, input).isError).toBe(true)
  expect(updateTask(raw, new Date(NOW).toISOString(), { kind: 'orchestrator' }, input).isError).toBe(false)
  expect(raw.run.plan).toBe('approved')
  expect(raw.tasks.find(one => one.id === 't392-1')?.files).toEqual(input.files)
  for (const file of ['../private', ' ../private', ' /private/file', 'src/../private', 'C:\\private', '.git/config']) expect(updateTask(raw, new Date(NOW).toISOString(), { kind: 'orchestrator' }, { ...input, files: [file] }).isError).toBe(true)
  expect(updateTask(raw, new Date(NOW).toISOString(), { kind: 'orchestrator' }, { task: 't392-1', dependsOn: ['t392-1'], scopeReason: 'Invalid cycle' }).isError).toBe(true)
})

test('the main session cannot edit implementation files while a task worker can', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = world(on, { [ledgerPath('demo')]: file(LEDGER, 1) })
  await start($); await board($, 'demo')
  const call = (agentId?: string) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ deny?: string }> )({ tool: 'Edit', tool_use_id: 'policy-edit', file_path: '/repo/source.txt', old_string: 'before', new_string: 'after', ...(agentId ? { agentId } : {}) })
  expect((await call()).deny).toContain('orchestrator never edits')
  engine.agentIds.push('policy-worker'); await spawn($, 't392-1')
  expect((await call('policy-worker')).deny).toBeUndefined()
})
