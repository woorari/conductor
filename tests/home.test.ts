import { expect, mock, test } from 'claude-code/testing'

import { LEDGER, NOW } from './fixture'
import { board, file, ledgerPath, picture$, start, world } from './world'

test('in a repository with a .claude/conductor folder the mod registers its commands and tools', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = world(on, { [ledgerPath('demo')]: file(LEDGER, 1) })
  await start($)
  expect([...engine.registered].sort()).toEqual([
    '/approve',
    '/board',
    '/cleanup',
    '/conduct',
    '/merged',
    '/pause',
    '/rotate',
    '/tier',
    '/unpause',
    'board_post',
    'board_read',
    'board_rule',
    'merge',
    'merge_check',
    'problem_assign',
    'problem_report',
    'problem_resolve',
    'run_plan',
    'task_add',
    'task_update',
  ])
})

test('a name the engine keeps for itself is said once and holds up nothing else of the mod', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = { [ledgerPath('demo')]: file(LEDGER, 1) }
  const engine = world(on, files)
  engine.builtins.add('approve')
  await start($)

  expect(engine.registered, 'the refused one is missing, and only that one').not.toContain('/approve')
  expect(engine.registered).toHaveLength(19)
  expect(engine.registered, 'what comes after it is registered all the same').toContain('problem_resolve')
  expect(engine.toasts).toEqual(['Run board: the engine did not take /approve (conductor: $.command.register: "/approve" refused: it is the built-in /approve). Everything else of the mod works.'])

  // The timers run: a change to the ledger reaches the pane.
  await board($, 'demo')
  files[ledgerPath('demo')] = file({ ...LEDGER, run: { ...LEDGER.run, title: 'Renamed' } }, 2)
  await clock.advance(2000)
  expect((await picture$($, 'desktop')).alt).toContain('Renamed: ')
})

test('no command of the mod has a name the engine keeps for itself', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = world(on, {})
  await start($)
  expect(engine.toasts, 'nothing was refused').toEqual([])
  expect(engine.registered.filter(one => one.startsWith('/')).map(one => one.slice(1)).filter(one => engine.builtins.has(one))).toEqual([])
})

test('anywhere else it registers nothing: no command, and no tool in any agent list', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = world(on, {})
  engine.isHome = false
  await start($)
  expect(engine.registered).toEqual([])
})
