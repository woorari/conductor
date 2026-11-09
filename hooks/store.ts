import { RUN_ID, parseLedger } from './ledger'
import type { Raw } from './signals'

/**
 * Where the mod's own store keeps the run a session is bound to. The host
 * holds a session's state only while its process lives, so a binding kept
 * there alone is gone after a restart of the app.
 */
export const boundKey = (sessionId: string): string => `bound:${sessionId}`

/** After this many days a kept binding is dropped the next time any session binds. */
export const BOUND_KEPT_DAYS = 30

/**
 * A kept binding as the store hands it back: the run, when it was bound, and
 * the root of the home it was bound in (absent in a binding kept before roots
 * were). Undefined for anything else found there; a root that is no absolute
 * path is left out.
 */
export function kept(value: unknown): { run: string; at?: string; root?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { run, at, root } = value as Record<string, unknown>
  if (typeof run !== 'string' || !RUN_ID.test(run)) return undefined

  return { run, ...(typeof at === 'string' ? { at } : {}), ...(typeof root === 'string' && root.startsWith('/') && !root.includes('\n') ? { root } : {}) }
}

/** True for a kept binding old enough to drop: one with no readable time counts as old. */
export function isStale(value: unknown, nowMs: number): boolean {
  const at = Date.parse(kept(value)?.at ?? '')

  return Number.isNaN(at) || nowMs - at > BOUND_KEPT_DAYS * 24 * 60 * 60_000
}

/** Under the repository's root, which for a worktree is the main checkout's. */
export const RUNS_DIR = '.claude/conductor/runs'

export const ledgerPath = (root: string, runId: string): string => `${root}/${RUNS_DIR}/${runId}/ledger.json`

/**
 * What one change to a ledger file comes to: the text to write (absent when
 * nothing changed), or why there is nothing to write. `isTorn` says the file
 * itself did not read, which a moment later it may.
 */
export type Prepared<T> =
  | { value: T; write?: string; error?: undefined }
  | { error: string; isTorn: boolean; value?: undefined; write?: undefined }

/**
 * Applies `change` to a ledger file's text. Pure: the caller reads and
 * writes. A change is never turned into a file that would not read back.
 */
export function prepare<T>(source: string, change: (raw: Raw) => { value: T; isChanged: boolean }): Prepared<T> {
  const read = parseLedger(source)
  if (read.error !== undefined) return { error: read.error, isTorn: true }
  const raw = JSON.parse(source) as Raw
  const { value, isChanged } = change(raw)
  if (!isChanged) return { value }
  const write = `${JSON.stringify(raw, null, 2)}\n`
  const checked = parseLedger(write)
  if (checked.error !== undefined) {
    return { error: `The change would break the ledger (${checked.error}); nothing was written.`, isTorn: false }
  }

  return { value, write }
}
