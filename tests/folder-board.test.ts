import { expect, test } from 'claude-code/testing'

import { boardView, summary } from '../hooks/board'
import { LEDGER, NOW } from './fixture'

test("the board names a folder-home run's workspace, relative to the home", () => {
  const ledger = { ...LEDGER, run: { ...LEDGER.run, workspace: { kind: 'lore' as const, root: '/home/owner/work/game/code/Big Game 5.8', place: 'game/code', base: 'main' } } }
  const view = boardView(ledger, Date.parse(NOW))
  expect(view.workspace).toBe('game/code/Big Game 5.8')
  expect(summary(view).startsWith('in game/code/Big Game 5.8 · '), summary(view)).toBe(true)
  const studio = { ...LEDGER, run: { ...LEDGER.run, workspace: { kind: 'git' as const, root: '/home/owner/work/studio', place: 'studio', base: 'main' } } }
  expect(boardView(studio, Date.parse(NOW)).workspace).toBe('studio')
  expect(boardView(LEDGER, Date.parse(NOW)).workspace, 'a repository home names none').toBeUndefined()
})
