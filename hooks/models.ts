import type { ModelTier } from '../types'

/** The portable meaning of a tier; its historical Claude alias stays in the ledger. */
export const complexityOf = (tier: ModelTier): string => ({ opus: 'architecture', sonnet: 'implementation', haiku: 'simple' })[tier]

export type ModelSelection =
  | { kind: 'inherit'; label: string }
  | { kind: 'explicit'; model: string; label: string }

/** Resolve at the receiving host, never from a previous worker's recorded model. */
export function selectModel(host: 'claude', tier: ModelTier, mapping?: Partial<Record<ModelTier, string>>): { kind: 'explicit'; model: ModelTier; label: string }
export function selectModel(host: 'codex', tier: ModelTier, mapping?: Partial<Record<ModelTier, string>>): ModelSelection
export function selectModel(host: 'claude' | 'codex', tier: ModelTier, mapping: Partial<Record<ModelTier, string>> = {}): ModelSelection {
  if (host === 'claude') return { kind: 'explicit', model: tier, label: tier }
  const model = mapping[tier]
  if (model === undefined) return { kind: 'inherit', label: 'current Codex model' }
  if (typeof model !== 'string' || model.trim() === '' || /claude|opus|sonnet|haiku/i.test(model)) {
    throw new Error('Codex model mappings must name available Codex models, not Claude aliases. Reset model_policy on takeover.')
  }
  return { kind: 'explicit', model, label: model }
}

/** What was picked for a task, for a line on the board: tier, then effort, then agent, the absent ones left out. */
export function staffLabel(task: { tier: ModelTier; effort?: string; agent?: string }): string {
  return [task.tier, task.effort, task.agent].filter(part => part !== undefined).join(' · ')
}
