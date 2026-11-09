import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Ledger } from '../types'
import { BRANCH_INFO_MAIN_UNSYNCED, BRANCH_INFO_PUSHED, REV_ON_MAIN } from './lore-output'
import { BASE, DF, RUN, RUN_BRANCH, answers, lored, ok, program, ranIn, stored } from './lore-world'

const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const PROPOSED: Ledger = { ...RUN, run: { ...RUN.run, plan: 'proposed' } }
const RUN_WS = `${BASE}/ABC-12/_run`
const inOrder = (ran: readonly string[], wanted: readonly string[]): boolean => {
  let at = 0
  for (const one of ran) if (one === wanted[at]) at += 1

  return at === wanted.length
}

/** Lore answers the base branch, and the run branch once it is pushed. */
function approvable(engine: Awaited<ReturnType<typeof lored>>['engine']): void {
  let isPushed = false
  engine.lore.unshift(
    answers(['branch', 'info', 'main'], ok(BRANCH_INFO_MAIN_UNSYNCED)),
    { match: (argv, cwd) => cwd === RUN_WS && argv.at(-1) === 'push', answer: () => ((isPushed = true), { exitCode: 0, stdout: `Pushed revision 1 -> ${REV_ON_MAIN} to branch ${RUN_BRANCH}\n` }) },
    {
      match: argv => argv.slice(1).filter(one => one !== '--non-interactive').join(' ') === `branch info ${RUN_BRANCH}`,
      answer: () => ({ exitCode: 0, stdout: `Branch ${RUN_BRANCH}\n  ID: 01a1b056f6bb701783e7a1beb2aa49a0\n  Latest: ${REV_ON_MAIN}\n  Remote Latest: ${isPushed ? REV_ON_MAIN : '0'.repeat(64)}\n` }),
    },
  )
}

test('approve makes the run branch from the base, protects the base, and keeps where the base stood', async ($, on) => {
  const { files, engine } = await lored($, on, PROPOSED)
  approvable(engine)

  const said = await command($, 'approve')
  expect(said.text).toContain('Plan approved')
  const ran = ranIn(engine, RUN_WS)
  expect(inOrder(ran, ['branch switch main --reset', `branch create ${RUN_BRANCH}`, 'push', 'branch protect main', 'branch info main']), ran.join('\n')).toBe(true)
  const { run } = stored(files)
  expect(run.plan).toBe('approved')
  expect(run.lore).toMatchObject({ workspace: RUN_WS, baseAt: REV_ON_MAIN })
  expect(engine.toasts).toContain('Run board: making the run\'s Lore workspace. A large workspace takes a minute or two.')
})

/** The disk answers with this many GB free. */
const freeGb = (gb: number) => program('df', ok(DF.replace('92000000', String(gb * 1024 * 1024))))

test('a disk without room for every worker the run may start at once keeps the plan proposed, before anything is copied', async ($, on) => {
  const { files, engine } = await lored($, on, PROPOSED)
  approvable(engine)
  engine.programs.unshift(freeGb(40))

  const said = await command($, 'approve')
  expect(said.text).toContain('No plan was approved')
  expect(said.text).toContain('40 GB')
  expect(said.text).toContain('3 workers at once need 60 GB (20 GB each, lore.minFreeGB in .claude/conductor/config.json)')
  expect(engine.calls.some(one => one.argv[0] === 'cp'), 'no workspace made').toBe(false)
  expect(stored(files).run.plan).toBe('proposed')
})

test('fewer workers at once fit the same disk', async ($, on) => {
  const { engine } = await lored($, on, { ...PROPOSED, run: { ...PROPOSED.run, maxParallel: 2 } })
  approvable(engine)
  engine.programs.unshift(freeGb(40))
  expect((await command($, 'approve')).text).toContain('Plan approved')
})

test('less disk each fits the same disk', async ($, on) => {
  const config = { ...PROPOSED.run.config, lore: { ...PROPOSED.run.config?.lore, minFreeGB: 10 } }
  const { engine } = await lored($, on, { ...PROPOSED, run: { ...PROPOSED.run, config } as Ledger['run'] })
  approvable(engine)
  engine.programs.unshift(freeGb(40))
  expect((await command($, 'approve')).text).toContain('Plan approved')
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

test('approving again reuses a pushed run branch, and refuses one that holds work nobody judged', async ($, on) => {
  const { engine } = await lored($, on, PROPOSED)
  engine.lore.unshift(answers(['branch', 'info', RUN_BRANCH], ok(BRANCH_INFO_PUSHED)), answers(['branch', 'info', 'main'], ok(BRANCH_INFO_MAIN_UNSYNCED)))

  const said = await command($, 'approve')
  const ran = ranIn(engine, RUN_WS)
  expect(ran).toContain(`branch switch ${RUN_BRANCH} --reset`)
  expect(ran.some(one => one.startsWith('branch create'))).toBe(false)
  expect(said.text, 'it stands at a revision of a task, not at the base').toContain('holds work nobody judged')
})

test('a git run is approved as before: nothing of Lore runs', async ($, on) => {
  const { engine } = await lored($, on, { ...PROPOSED, run: { ...PROPOSED.run, lore: undefined } })
  const before = engine.loreCalls.length

  expect((await command($, 'approve')).text).toContain('Plan approved')
  expect(engine.loreCalls.length).toBe(before)
})
