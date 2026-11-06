import { changed, refused } from './signals'
import type { Outcome, Raw } from './signals'

/**
 * The owner's hold on a run. While a run is paused no worker starts and
 * nothing is merged: the router and the merge refuse, whatever the
 * orchestrator is told or remembers. Work that is under way is not cut off:
 * workers that are building finish and hand back, and a merge in flight is
 * still verified. The pause is written in the ledger, so it outlives a
 * restart of the app.
 *
 * `/resume` would be the word for ending it, but that is the app's own
 * command for resuming a conversation and a mod may not take it: `/unpause`.
 */

/** Under which name the orchestrator's notice of a pause, or of its end, waits to be read. */
export const PAUSE_NOTICE = 'pause'
export const UNPAUSE_NOTICE = 'unpause'

// What the orchestrator does about either is in its standing instructions (the
// mod's section of the system prompt): the owner reads these lines in the
// conversation too, so they say what happened and nothing else.
export const PAUSED = 'Run board: the owner paused the run.'

export const UNPAUSED = 'Run board: the owner ended the pause.'

const runOf = (raw: Raw): Record<string, unknown> => raw.run as Record<string, unknown>

/** When the run was paused, or undefined while it is not. */
export const pausedAt = (raw: Raw): string | undefined => {
  const at = runOf(raw).pausedAt

  return typeof at === 'string' ? at : undefined
}

/** `/pause`: the owner holds the run. */
export function pauseRun(raw: Raw, at: string): Outcome {
  const run = runOf(raw)
  const since = pausedAt(raw)
  if (since !== undefined) return refused(`Run ${String(run.id)} is paused already, since ${since}. /unpause lets it go on.`)
  run.pausedAt = at
  const building = raw.tasks.filter(one => one.status === 'building').map(one => one.id)
  const flight = raw.merge as { task?: unknown } | undefined
  const still = [
    building.length === 0 ? 'Nobody is building.' : `Still finishing: ${building.join(', ')}.`,
    flight === undefined ? '' : `The merge of ${String(flight.task)} is still being settled with GitHub.`,
  ].filter(one => one !== '')

  return {
    ...changed(`Run ${String(run.id)} is paused until /unpause. ${still.join(' ')}`),
    wake: PAUSED,
    asks: PAUSE_NOTICE,
    answered: UNPAUSE_NOTICE,
  }
}

/** `/unpause`: the owner lets the run go on. */
export function unpauseRun(raw: Raw): Outcome {
  const run = runOf(raw)
  if (pausedAt(raw) === undefined) return refused(`Run ${String(run.id)} is not paused.`)
  delete run.pausedAt

  return { ...changed(`Run ${String(run.id)} goes on.`), wake: UNPAUSED, asks: UNPAUSE_NOTICE, answered: PAUSE_NOTICE }
}
