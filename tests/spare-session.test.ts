import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CONDUCT_USAGE } from '../hooks/plan'
import { NOW } from './fixture'
import { HOME_ROOT, conductIn, folderWorld, startAt } from './folder-world'
import { HOME } from './world'

/** The folder the desktop app starts a spare session's process in, before it hands the session to the folder it is for. */
const SPARE = `${HOME}/Library/Application Support/Claude/claude-code-spare`
const handedOver = ($: Engine) => ($.classic as unknown as { SessionStart: (e: { source: string }) => Promise<unknown> }).SessionStart({ source: 'startup' })

test('a session started ahead of time in a spare folder switches on once it is handed to its own folder', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = folderWorld(on, {}, { cwd: SPARE })
  engine.dirs.push(SPARE)
  await startAt($, SPARE)
  expect(engine.registered, 'nothing in the spare folder').toEqual([])

  engine.cwd = HOME_ROOT
  await handedOver($)
  for (const name of ['/conduct', '/approve', '/board', 'run_plan', 'run_workspace']) expect(engine.registered, name).toContain(name)
  expect((await conductIn($, '')).text).toBe(CONDUCT_USAGE)
})

test('a session that switched on at its start registers nothing twice when SessionStart comes', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = folderWorld(on, {})
  await startAt($)
  const before = [...engine.registered]
  await handedOver($)
  expect(engine.registered).toEqual(before)
})
