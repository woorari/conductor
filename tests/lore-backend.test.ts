import { expect, mock, test } from 'claude-code/testing'

import { NOW } from './fixture'
import { REPOSITORY_INFO } from './lore-output'
import { LORE_ROOT, answers, loreRan, loreWorld, startIn } from './lore-world'
import { HOME, start, world } from './world'

const conduct = (...[$, args]: [Parameters<typeof startIn>[0], string]) =>
  $.command.run({ command: 'conduct', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

test('the mod switches on in a Lore workspace with .claude/conductor', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = loreWorld(on, {}, { cwd: `${LORE_ROOT}/Source` })
  await startIn($, `${LORE_ROOT}/Source`)

  expect(engine.registered).toContain('/board')
  expect(engine.registered).toContain('/conduct')
  expect(loreRan(engine)).toContainEqual({ args: ['repository', 'info'], cwd: LORE_ROOT })
  expect(engine.loreCalls.find(call => call.argv.includes('info'))?.argv, 'lore is asked without a prompt').toEqual(['lore', '--non-interactive', 'repository', 'info'])
})

test('a Lore workspace without .claude/conductor stays off', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = loreWorld(on, {})
  engine.isHome = false
  await startIn($)

  expect(engine.registered).toEqual([])
})

test('lore is found in HOME/.local/bin when PATH lacks it', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = loreWorld(on, {})
  const local = `${HOME}/.local/bin/lore`
  engine.lore.length = 0
  engine.lore.push(
    { match: argv => argv[0] === local && argv[1] === '--version', answer: { exitCode: 0, stdout: 'lore 0.12.0' } },
    answers(['repository', 'info'], { exitCode: 0, stdout: REPOSITORY_INFO }),
  )
  await startIn($)

  const info = engine.loreCalls.find(call => call.argv.includes('info'))
  expect(info?.argv[0], 'the later calls use the binary that ran').toBe(local)
  expect(engine.processes.some(argv => argv[0] === 'lore' && argv[1] === '--version'), 'lore on the PATH was tried first').toBe(true)
})

test('with lore not running at all, /conduct says to set lore.bin', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = {}
  const engine = loreWorld(on, files)
  engine.lore.length = 0
  await startIn($)

  const said = await conduct($, 'ABC-12 Retry the flaky upload')
  expect(said.text).toContain('lore.bin')
  expect(said.text).toContain('.claude/conductor/config.json')
  expect(Object.keys(files), 'no run was started').toEqual([])
})

test('a git repository is unchanged: lore is never run', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = world(on, {})
  await start($)

  expect(engine.loreCalls).toEqual([])
  expect(engine.registered).toContain('/conduct')
})
