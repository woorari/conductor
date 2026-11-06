import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Ledger } from '../types'
import { BRANCH_INFO_MAIN_UNSYNCED, BRANCH_INFO_PUSHED, REV_ON_MAIN } from './lore-output'
import { BASE, RUN, RUN_BRANCH, answers, lored, ok, program, ranIn, stored } from './lore-world'

const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const PROPOSED: Ledger = { ...RUN, run: { ...RUN.run, plan: 'proposed' } }
const RUN_WS = `${BASE}/ABC-12/_run`
const inOrder = (ran: readonly string[], wanted: readonly string[]): boolean => {
  let at = 0
  for (const one of ran) if (one === wanted[at]) at += 1

  return at === wanted.length
}

test('approve makes the run branch from the base, protects the base, and keeps where the base stood', async ($, on) => {
  const { files, engine } = await lored($, on, PROPOSED)
  engine.lore.unshift(answers(['branch', 'info', 'main'], ok(BRANCH_INFO_MAIN_UNSYNCED)))

  const said = await command($, 'approve')
  expect(said.text).toContain('Plan approved')
  const ran = ranIn(engine, RUN_WS)
  expect(inOrder(ran, ['branch switch main --reset', `branch create ${RUN_BRANCH}`, 'push', 'branch protect main', 'branch info main']), ran.join('\n')).toBe(true)
  const { run } = stored(files)
  expect(run.plan).toBe('approved')
  expect(run.lore).toMatchObject({ workspace: RUN_WS, baseAt: REV_ON_MAIN })
  expect(engine.toasts).toContain('Run board: making the run\'s Lore workspace. A large workspace takes a minute or two.')
})

test('a failed run workspace keeps the plan proposed', async ($, on) => {
  const { files, engine } = await lored($, on, PROPOSED)
  engine.programs.unshift(program('cp', { exitCode: 1, stdout: '', stderr: 'cp: Operation not permitted' }))

  const said = await command($, 'approve')
  expect(said.text).toContain('No plan was approved')
  expect(said.text).toContain('Operation not permitted')
  expect(stored(files).run.plan).toBe('proposed')
  expect(stored(files).run.lore?.workspace).toBeUndefined()
})

test('a base that cannot be protected keeps the plan proposed', async ($, on) => {
  const { files, engine } = await lored($, on, PROPOSED)
  engine.lore.unshift(answers(['branch', 'protect'], { exitCode: 17, stdout: '[Error] Not authorized to access repository' }))

  const said = await command($, 'approve')
  expect(said.text).toContain('No plan was approved')
  expect(said.text).toContain('Not authorized')
  expect(stored(files).run.plan).toBe('proposed')
})

test('approving again after a failure reuses a pushed run branch', async ($, on) => {
  const { engine } = await lored($, on, PROPOSED)
  engine.lore.unshift(answers(['branch', 'info', RUN_BRANCH], ok(BRANCH_INFO_PUSHED)), answers(['branch', 'info', 'main'], ok(BRANCH_INFO_MAIN_UNSYNCED)))

  await command($, 'approve')
  const ran = ranIn(engine, RUN_WS)
  expect(ran).toContain(`branch switch ${RUN_BRANCH} --reset`)
  expect(ran.some(one => one.startsWith('branch create'))).toBe(false)
})

test('a git run is approved as before: nothing of Lore runs', async ($, on) => {
  const { engine } = await lored($, on, { ...PROPOSED, run: { ...PROPOSED.run, lore: undefined } })
  const before = engine.loreCalls.length

  expect((await command($, 'approve')).text).toContain('Plan approved')
  expect(engine.loreCalls.length).toBe(before)
})
