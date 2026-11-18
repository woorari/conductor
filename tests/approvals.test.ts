import { expect, test } from 'claude-code/testing'

import { OWNER_ORIGINS, approvalGate, approveMain, approveRun, loreRunOf } from '../hooks/approvals'
import type { ApprovalHost } from '../hooks/approvals'
import { canonicalPlan } from '../hooks/plan'
import type { Raw } from '../hooks/signals'
import type { Ledger } from '../types'

const AT = '2026-11-18T10:00:00.000Z'
/** Stands in for sha256: the gate takes the host's hash, and a test only needs 64 hex characters that follow the text. */
function sha256(text: string): string {
  let out = ''
  for (let round = 0; out.length < 64; round++) {
    let h = 2166136261 + round
    for (let at = 0; at < text.length; at++) h = Math.imul(h ^ text.charCodeAt(at), 16777619)
    out += (h >>> 0).toString(16).padStart(8, '0')
  }

  return out
}
const LEDGER: Ledger = {
  version: 1,
  run: { id: 'demo', title: 'Demo', source: '#1', startedAt: '2026-11-18T08:00:00Z', plan: 'proposed' },
  problems: [],
  posts: [],
  rulings: [],
  tasks: [
    { id: 'a', title: 'A', tier: 'sonnet', status: 'queued', files: ['x.ts'] },
    { id: 'b', title: 'B', tier: 'haiku', status: 'queued', files: ['y.ts'] },
  ],
}
const RAW = { ...LEDGER, codex: { base: 'main' } }
const HASH = sha256(canonicalPlan(LEDGER, 'main'))
const DECISION = { by: 'decider:engineering', ref: 'D1' }
const OWNER = { kind: 'owner' } as const

test('a stale plan hash is refused naming both hashes', () => {
  const gate = approvalGate(RAW, { planSha256: 'b'.repeat(64), decision: DECISION }, OWNER, AT, sha256)
  expect(gate).toEqual({ error: expect.stringContaining('b'.repeat(64)) })
  expect('error' in gate && gate.error).toContain(HASH)
})

test('an approval by a worker token is refused', () => {
  for (const caller of [{ kind: 'worker', taskId: 'a' }, { kind: 'orchestrator' }, { kind: 'stranger' }]) {
    expect(approvalGate(RAW, { planSha256: HASH }, caller, AT, sha256)).toEqual({ error: 'This action requires the owner’s explicit instruction in this chat.' })
  }
})

test('a plan whose tasks collide is refused with the preflight issues, before the hash is looked at', () => {
  const clash = { ...RAW, tasks: [{ ...LEDGER.tasks[0], files: ['x.ts'] }, { ...LEDGER.tasks[1], files: ['x.ts'] }] }
  const gate = approvalGate(clash, { planSha256: 'b'.repeat(64) }, OWNER, AT, sha256)
  expect('error' in gate && gate.error).toContain('could run at once and both change x.ts')
})

test('a ledger that does not read is refused with why', () => {
  expect(approvalGate({ nope: true }, {}, OWNER, AT, sha256)).toEqual({ error: expect.any(String) })
})

test('an approval with no hash and no decision passes and records no decision; a decision is stamped with the hash', () => {
  expect(approvalGate(RAW, {}, OWNER, AT, sha256)).toEqual({})
  expect(approvalGate(RAW, { planSha256: HASH, decision: DECISION }, OWNER, AT, sha256)).toEqual({ decision: { ...DECISION, at: AT, sha256: HASH } })
})

/** A fake mod host over one ledger file. */
function host(over: { notReady?: string; mutateError?: string; text?: string; bound?: string | null } = {}) {
  const said: string[] = []
  const calls: string[] = []
  const ledger: Raw = JSON.parse(JSON.stringify(LEDGER)) as Raw
  const fake: ApprovalHost = {
    boundLedger: async () => (over.bound === null ? undefined : (over.bound ?? '/runs/demo/ledger.json')),
    unbound: async () => 'This session is bound to no run.',
    read: async () => over.text ?? JSON.stringify(LEDGER),
    loreApprove: async () => over.notReady,
    base: async () => 'main',
    mutate: async (_path, change) => {
      if (over.mutateError !== undefined) return { error: over.mutateError }
      const out = change(ledger)

      return { value: out.value }
    },
    linearApproved: async () => void calls.push('linear'),
    issueDone: async () => void calls.push('issue'),
    refresh: async () => void calls.push('refresh'),
    mergeMain: async (fromPlan: boolean) => {
      said.push(`merge:${fromPlan}`)

      return 'merged'
    },
  }

  return { fake, said, calls, ledger }
}

test('approveRun stops when the Lore side is not ready and records nothing', async () => {
  const h = host({ notReady: 'only 1 GB is free' })
  const done = await approveRun(h.fake, '/runs/demo/ledger.json')
  expect(done).toEqual({ text: 'No plan was approved: only 1 GB is free Approve again once that is fixed.', isApproved: false })
  expect(h.calls).toEqual([])
  expect((h.ledger.run as { plan?: string }).plan).toBe('proposed')
})

test('approveRun approves the plan, then tells Linear and the issue, then refreshes', async () => {
  const h = host()
  const done = await approveRun(h.fake, '/runs/demo/ledger.json', 'review-only')
  expect(done.isApproved).toBe(true)
  expect((h.ledger.run as { plan?: string; delivery?: string }).plan).toBe('approved')
  expect((h.ledger.run as { delivery?: string }).delivery).toBe('review-only')
  expect(h.calls).toEqual(['linear', 'issue', 'refresh'])
})

test('approveRun says why a ledger write failed and does not tell Linear', async () => {
  const h = host({ mutateError: 'the ledger is locked' })
  expect(await approveRun(h.fake, '/runs/demo/ledger.json')).toEqual({ text: 'the ledger is locked', isApproved: false })
  expect(h.calls).toEqual([])
})

test('approveMain needs the owner’s own origin and merges nothing for any other', async () => {
  const h = host()
  for (const origin of ['channel', 'peer', 'plugin', 'schedule', 'worker']) {
    expect(await approveMain(h.fake, origin)).toContain('Nothing was merged.')
  }
  expect(h.said).toEqual([])
  for (const origin of OWNER_ORIGINS) expect(await approveMain(h.fake, origin)).toBe('merged')
  expect(h.said).toEqual(['merge:false', 'merge:false', 'merge:false'])
})

test('loreRunOf says why a run has no Lore side, and hands over the workspace when it has one', async () => {
  expect(await loreRunOf(host({ bound: null }).fake)).toEqual({ text: 'This session is bound to no run.' })
  expect(await loreRunOf(host({ text: 'not json' }).fake)).toEqual({ text: 'The ledger does not read.' })
  expect(await loreRunOf(host().fake)).toEqual({ text: expect.stringContaining('no Lore workspace yet') })
  const withLore = { ...LEDGER, run: { ...LEDGER.run, lore: { remote: 'r', repository: 'x', base: 'main', branch: 'run/demo', workspace: '/w/run' } } }
  const found = await loreRunOf(host({ text: JSON.stringify(withLore) }).fake)
  expect('run' in found && found.run).toBe('/w/run')
})

test('the same vectors give the same gate result in the mod host and the Codex host', async () => {
  const stale = 'b'.repeat(64)
  const vectors: { name: string; caller: { kind: string; taskId?: string }; input: { planSha256?: unknown; decision?: unknown } }[] = [
    { name: 'no hash, no decision', caller: OWNER, input: {} },
    { name: 'the current hash', caller: OWNER, input: { planSha256: HASH } },
    { name: 'a stale hash', caller: OWNER, input: { planSha256: stale, decision: DECISION } },
    { name: 'a malformed hash', caller: OWNER, input: { planSha256: 'nope' } },
    { name: 'a decision without a hash', caller: OWNER, input: { decision: DECISION } },
    { name: 'a decision with a bad by', caller: OWNER, input: { planSha256: HASH, decision: { by: 'owner', ref: 'D1' } } },
    { name: 'a decision with the hash', caller: OWNER, input: { planSha256: HASH, decision: { ...DECISION, agent: 'lead-a' } } },
    { name: 'a worker', caller: { kind: 'worker', taskId: 'a' }, input: { planSha256: HASH } },
  ]
  const h = host()
  for (const one of vectors) {
    // The Codex host hands the gate the ledger it loaded from its file.
    const codex = approvalGate(JSON.parse(JSON.stringify(RAW)), one.input, one.caller, AT, sha256)
    // The mod host hands it the ledger its `mutate` lent.
    let mod: unknown
    await h.fake.mutate('/runs/demo/ledger.json', raw => {
      mod = approvalGate({ ...raw, codex: { base: 'main' } }, one.input, one.caller, AT, sha256)

      return { value: undefined, isChanged: false }
    })
    expect(mod, one.name).toEqual(codex)
  }
})
