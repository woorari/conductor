import { expect, test } from 'claude-code/testing'
import { selectModel, complexityOf } from '../hooks/models'
import { TIERS } from '../hooks/ledger'

test('Codex resolves every portable tier to its current session model without a foreign model pin', () => {
  for (const tier of TIERS) expect(selectModel('codex', tier)).toEqual({ kind: 'inherit', label: 'current Codex model' })
  expect(TIERS.map(complexityOf)).toEqual(['architecture', 'implementation', 'simple'])
})

test('Claude resolves its own aliases even when the previous host had explicit Codex assignments', () => {
  for (const tier of TIERS) expect(selectModel('claude', tier, { [tier]: 'gpt-prior-session' })).toEqual({ kind: 'explicit', model: tier, label: tier })
})

test('an explicit Codex mapping applies only to its tier and cannot carry Claude aliases', () => {
  expect(selectModel('codex', 'sonnet', { sonnet: 'gpt-owner-choice' })).toEqual({ kind: 'explicit', model: 'gpt-owner-choice', label: 'gpt-owner-choice' })
  expect(selectModel('codex', 'opus', { sonnet: 'gpt-owner-choice' }).kind).toBe('inherit')
  for (const foreign of ['sonnet', 'claude-opus-example', 'haiku']) expect(() => selectModel('codex', 'sonnet', { sonnet: foreign })).toThrow()
})
