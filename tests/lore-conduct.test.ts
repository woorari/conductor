import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { PLACEHOLDER_SNIPPET } from '../hooks/project'
import type { Ledger } from '../types'
import { NOW } from './fixture'
import { LORE_ROOT, loreLedgerPath, loreWorld, startIn } from './lore-world'
import type { Files } from './world'

const conduct = ($: Engine, args: string) =>
  $.command.run({ command: 'conduct', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const IGNORE = `${LORE_ROOT}/.loreignore`
const SETTINGS = `${LORE_ROOT}/.claude/settings.local.json`
const CONFIG = `${LORE_ROOT}/.claude/conductor/config.json`
const ready = (more: Files = {}): Files => ({
  [IGNORE]: { text: '/Saved/\n.claude/conductor/runs/\n', mtimeMs: 1 },
  [SETTINGS]: { text: PLACEHOLDER_SNIPPET, mtimeMs: 1 },
  ...more,
})
const stored = (files: Files, run: string): Ledger => JSON.parse(files[loreLedgerPath(run)]?.text ?? '{}') as Ledger

test('/conduct refuses until the runs folder is ignored', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = ready()
  delete files[IGNORE]
  loreWorld(on, files)
  await startIn($)

  const said = await conduct($, 'ABC-12')
  expect(said.text).toContain('.claude/conductor/runs/')
  expect(said.text).toContain('.loreignore')
  expect(files[loreLedgerPath('ABC-12')]).toBeUndefined()
})

test('/conduct refuses until the WorktreeCreate placeholder is configured', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = ready()
  delete files[SETTINGS]
  loreWorld(on, files)
  await startIn($)

  const said = await conduct($, 'ABC-12')
  expect(said.text).toContain(PLACEHOLDER_SNIPPET)
  expect(said.text).toContain('.claude/settings.local.json')
  expect(files[loreLedgerPath('ABC-12')]).toBeUndefined()
})

test('/conduct ABC-12 starts a Linear run with the config frozen and the run branch named', async ($, on) => {
  mock.clock(on, { now: NOW })
  const config = { lore: { carry: ['Intermediate'] }, check: { argv: ['./check.sh'], timeoutMin: 20 } }
  const files = ready({ [CONFIG]: { text: JSON.stringify(config), mtimeMs: 1 } })
  loreWorld(on, files)
  await startIn($)

  const said = await conduct($, 'ABC-12 Retry the flaky upload')
  expect(said.text).toContain('Run ABC-12 is started from ABC-12')
  expect(said.text, 'the owner sees the program the mod will run').toContain('Its check command, which the mod runs on each judged revision: ./check.sh')
  const { run } = stored(files, 'ABC-12')
  expect(run.source).toBe('ABC-12')
  expect(run.tickets).toBe('linear')
  expect(run.config).toEqual(config)
  expect(run.lore).toEqual({ remote: 'lores://lore.example.test:41337', repository: 'conductor-spike', base: 'main', branch: 'conductor/ABC-12-retry-the-flaky-upload' })
})

test('the project names its own branch prefix', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = ready({ [CONFIG]: { text: '{"lore": {"branchPrefix": "eng/"}}', mtimeMs: 1 } })
  loreWorld(on, files)
  await startIn($)

  await conduct($, 'ABC-7')
  expect(stored(files, 'ABC-7').run.lore?.branch).toBe('eng/ABC-7')
})

test('a spec run with Linear tickets needs linear.team', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = ready({
    [CONFIG]: { text: '{"tickets": "linear"}', mtimeMs: 1 },
    [`${LORE_ROOT}/docs/x.md`]: { text: '# x', mtimeMs: 1 },
  })
  loreWorld(on, files)
  await startIn($)

  const said = await conduct($, 'docs/x.md')
  expect(said.text).toContain('linear.team')
  expect(files[loreLedgerPath('x')]).toBeUndefined()

  files[CONFIG] = { text: '{"tickets": "linear", "linear": {"team": "ABC"}}', mtimeMs: 2 }
  await conduct($, 'docs/x.md')
  expect(stored(files, 'x').run.tickets).toBe('linear')
})

test('a malformed config.json refuses /conduct with the parse error', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = ready({ [CONFIG]: { text: '{"tickts": 1}', mtimeMs: 1 } })
  loreWorld(on, files)
  await startIn($)

  const said = await conduct($, 'ABC-12')
  expect(said.text).toContain('"tickts" is no setting here')
  expect(files[loreLedgerPath('ABC-12')]).toBeUndefined()
})

test('the Lore program option names the lore that runs', { options: { loreBin: '/opt/lore/bin/lore' } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = ready()
  const engine = loreWorld(on, files)
  engine.lore.unshift({ match: argv => argv[0] === '/opt/lore/bin/lore' && argv[1] === '--version', answer: { exitCode: 0, stdout: 'lore 0.12.0' } })
  await startIn($)

  expect(engine.loreCalls.find(call => call.argv.includes('info'))?.argv[0]).toBe('/opt/lore/bin/lore')
})

test('a project cannot name the program that runs: lore.bin in config.json is refused, and never run', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = ready({ [CONFIG]: { text: '{"lore": {"bin": "/tmp/evil"}}', mtimeMs: 1 } })
  const engine = loreWorld(on, files)
  await startIn($)

  expect(engine.processes.some(argv => argv[0] === '/tmp/evil'), 'not at the start').toBe(false)
  const said = await conduct($, 'ABC-12')
  expect(said.text).toContain('"lore.bin" is no setting here')
  expect(engine.processes.some(argv => argv[0] === '/tmp/evil'), 'not at /conduct').toBe(false)
})
