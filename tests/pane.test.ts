import { expect, mock, test } from 'claude-code/testing'

import type { Ledger } from '../types'
import { LEDGER, NOW, withTask } from './fixture'
import { PANE, SURFACES, board, file, ledgerPath, picture$, start, world } from './world'
import type { Files } from './world'

test('the pane shows what is building, next, done and which problems were found', async ($, on) => {
  mock.clock(on, { now: NOW })
  world(on, { [ledgerPath('demo')]: file(LEDGER, 1) })

  const ran = await board($)
  expect(ran.text).toContain('Nightly import speed: 2 problems open')
  expect(ran.text).toContain('2 building')

  const text = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const heading of ['PROBLEMS', 'NEEDS A DECISION', 'BUILDING', 'REVIEW', 'NEXT', 'WAITING', 'DONE']) {
    expect(await text.find({ type: 'Text', text: new RegExp(`^${heading} \\d+$`) }), heading).toBeDefined()
  }
  expect(await text.find({ text: /^t391-1 Pool exhaustion answers 503$/ })).toBeDefined()
  expect(await text.find({ text: /sonnet · w391 · 12 min · ticket 391/ })).toBeDefined()
  expect(await text.find({ text: /^P2 Pool timeout test fails on the CI runner$/ })).toBeDefined()
  expect(await text.find({ text: /^1 problem resolved$/ })).toBeDefined()
  expect(await text.find({ text: /^Updated \d\d:\d\d · view only$/ })).toBeDefined()
  expect(await text.find({ type: 'Svg' }), 'the terminal draws no picture').toBeUndefined()
  await text.unmount()

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const picture = await picture$($, surface)
    expect(picture.alt).toContain('Nightly import speed: 2 problems open')
    for (const piece of ['>Problems<', '>Needs a decision<', '>Now<', '>w391<', '>12 min<', '>Up next<', '>To merge<', '>Updated ']) {
      expect(picture.source, `${piece} on ${surface}`).toContain(piece)
    }
  }
})

test('a change to the ledger file reaches the open pane on the next poll', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [ledgerPath('demo')]: file(LEDGER, 1) }
  world(on, files)
  await start($)
  await board($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(2000)
  expect(await ui.find({ text: /^BUILDING 2$/ }), 'before the change').toBeDefined()
  expect((await picture$($, 'desktop')).source).toContain('>2 building<')

  files[ledgerPath('demo')] = file(withTask('t391-1', { status: 'review', pr: 550 }), 2)
  await clock.advance(2000)
  expect(await ui.find({ text: /^BUILDING 1$/ }), 'after the change').toBeDefined()
  expect(await ui.find({ text: /in review · sonnet · w391 · PR 550/ })).toBeDefined()
  const after = await picture$($, 'desktop')
  expect(after.source).toContain('>1 building<')
  expect(after.source).toContain('>550</tspan>')

  files[ledgerPath('demo')] = file(LEDGER, 3)
  await clock.advance(2000)
  expect(await ui.find({ text: /^BUILDING 2$/ }), 'changed back').toBeDefined()
  await ui.unmount()
})

test('a ledger that stops validating keeps the last good board and says why', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [ledgerPath('demo')]: file(LEDGER, 1) }
  world(on, files)
  await start($)
  await board($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  files[ledgerPath('demo')] = { text: '{"version": 1, "run": {', mtimeMs: 2 }
  await clock.advance(2000)
  expect(await ui.find({ text: /^Ledger not readable: the file is not valid JSON/ })).toBeDefined()
  const kept = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(kept, 'the last good board').toContain('>2 building<')
  expect(kept, 'and when that board was written').toContain('>Updated ')

  files[ledgerPath('demo')] = file(LEDGER, 2)
  await clock.advance(2000)
  expect(await ui.find({ text: /^Ledger not readable/ }), 'read again at the same mtime').toBeUndefined()
  await ui.unmount()
})

test('a bare /board shows the newest run; a run id binds the session to that run until `none` lets go', async ($, on) => {
  mock.clock(on, { now: NOW })
  const older: Ledger = { ...LEDGER, run: { ...LEDGER.run, id: 'older', title: 'Single sign-on rework' } }
  world(on, { [ledgerPath('demo')]: file(LEDGER, 5), [ledgerPath('older')]: file(older, 3) })

  const viewing = (await board($)).text ?? ''
  expect(viewing).toContain('Nightly import speed')
  expect(viewing).toContain('Viewing only: /board demo binds this session')
  expect((await picture$($, 'desktop')).source).toContain(' · view only<')

  const bound = (await board($, 'older')).text ?? ''
  expect(bound).toContain('Single sign-on rework')
  expect(bound).toContain('This session is bound to run older.')
  expect((await board($)).text, 'a bare /board keeps the binding').toContain('Single sign-on rework')
  expect((await picture$($, 'desktop')).source).not.toContain('view only')

  expect((await board($, '../x')).text).toContain('is not a run id')
  expect((await board($)).text, 'a refused id changes nothing').toContain('bound to run older')
  expect((await board($, 'absent')).text).toContain('There is no ledger at')
  expect((await board($, 'none')).text, 'let go: the newest again').toContain('Viewing only')
})

test('with no run, and outside a repository, the pane says what it is waiting for', async ($, on) => {
  mock.clock(on, { now: NOW })
  world(on, {})
  expect((await board($)).text).toContain('No run yet')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /^No run to show$/ })).toBeDefined()
    expect(await ui.find({ text: /ledger is read from \.claude\/conductor\/runs/ })).toBeDefined()
    await ui.unmount()
  }
})

test('outside a git repository the command says so', async ($, on) => {
  mock.clock(on, { now: NOW })
  world(on, {}, null)
  expect((await board($)).text).toContain('not inside a git repository')
})
