import { expect, mock, test } from 'claude-code/testing'
import { boardAddress, htmlActions } from '../hooks/html-board'
import { LEDGER, NOW } from './fixture'
import { board, file, ledgerPath, spawn, start, world } from './world'
import type { Ledger } from '../types'
import type { Files } from './world'

const TOKEN = 'a'.repeat(64)
const URL = `http://127.0.0.1:45678/#${TOKEN}`
const PATH = ledgerPath('demo')
const task = (files: Files) => (JSON.parse(files[PATH].text) as Ledger).tasks.find(one => one.id === 't392-1')!

test('the HTML bridge accepts only our authenticated loopback address and tier-only actions', () => {
  expect(boardAddress(URL)).toEqual({ base: 'http://127.0.0.1:45678', token: TOKEN })
  for (const url of ['https://example.com/#' + TOKEN, 'file:///tmp/board.html', 'http://127.0.0.1:1234/?secret=x#' + TOKEN, 'http://user:pass@127.0.0.1:1234/#' + TOKEN]) expect(boardAddress(url)).toBeUndefined()
  expect(htmlActions([{ id: 'b'.repeat(24), task: 't392-1', tier: 'opus' }, { id: 'x', task: '../outside', tier: 'merge' }])).toHaveLength(1)
})

test('an HTML model choice uses the native queued-only owner mutation and does not approve or start work', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(LEDGER, 1) }
  const engine = world(on, files)
  engine.programs.push({ match: argv => argv[0] === 'node' && argv[1]?.endsWith('/codex/board.mjs') === true, answer: { exitCode: 0, stdout: JSON.stringify({ boardView: { url: URL } }) } })
  let pending: { id: string; task: string; tier: string }[] = []
  const replies: { status: string; message: string }[] = []
  engine.htmlHttp = (url, init) => {
    if (!url.startsWith('http://127.0.0.1:45678/')) return undefined
    expect(init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`)
    if (init?.method === 'POST') replies.push(JSON.parse(init.body ?? '{}'))
    const data = init?.method === 'POST' ? { ok: true } : pending.splice(0)
    return { status: 200, json: data }
  }
  await start($); await board($, 'demo')
  expect((await board($, 'html')).text).toContain('[live HTML board](')
  const before = (JSON.parse(files[PATH].text) as Ledger).run.plan
  pending = [{ id: 'b'.repeat(24), task: 't392-1', tier: 'opus' }]
  await clock.advance(2000)
  await board($, 'html')
  expect(task(files).tier).toBe('opus'); expect(task(files).tierBy).toBe('owner')
  expect(task(files).status).toBe('queued'); expect((JSON.parse(files[PATH].text) as Ledger).run.plan).toBe(before)
  expect(replies[0]?.status).toBe('applied')
  engine.agentIds.push('new-worker'); await spawn($, 't392-1')
  pending = [{ id: 'c'.repeat(24), task: 't392-1', tier: 'haiku' }]
  await clock.advance(2000)
  await board($, 'html')
  expect(task(files).tier).toBe('opus'); expect(replies.at(-1)?.status).toBe('error')
})

test('when Node is unavailable the native board and its model picker remain usable', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files: Files = { [PATH]: file(LEDGER, 1) }; world(on, files)
  await start($); await board($, 'demo')
  expect((await board($, 'html')).text).toContain('native board and model pickers remain available')
  const result = await $.command.run({ command: 'tier', args: 't392-1 opus', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(result.text).toContain('opus'); expect(task(files).tier).toBe('opus')
})
