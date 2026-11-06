import { expect, mock, test } from 'claude-code/testing'

import { CONDUCT_USAGE } from '../hooks/plan'
import { NOW } from './fixture'
import { GIT_WS, conductIn, folderWorld, startAt } from './folder-world'
import { start, world } from './world'

test('a session in a folder home registers the mod\'s commands and tools', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = folderWorld(on, {})
  await startAt($)
  for (const name of ['/conduct', '/approve', '/board', 'run_plan', 'run_workspace']) expect(engine.registered, name).toContain(name)
})

test('/conduct with no words in a folder home answers its usage', async ($, on) => {
  mock.clock(on, { now: NOW })
  folderWorld(on, {})
  await startAt($)
  expect((await conductIn($, '')).text).toBe(CONDUCT_USAGE)
})

test('a session in a git repository inside a folder home switches on there too', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = folderWorld(on, {}, { cwd: GIT_WS, gitRoot: GIT_WS })
  await startAt($, GIT_WS)
  expect(engine.registered).toContain('run_workspace')
  expect((await conductIn($, '')).text).toBe(CONDUCT_USAGE)
})

test('a repository home registers no run_workspace', async ($, on) => {
  mock.clock(on, { now: NOW })
  const engine = world(on, {})
  await start($)
  expect(engine.registered).toContain('/conduct')
  expect(engine.registered).not.toContain('run_workspace')
})
