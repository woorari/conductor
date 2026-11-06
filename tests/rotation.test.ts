import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { KEEP } from '../hooks/handover'
import type { Ledger } from '../types'
import { LEDGER, NOW } from './fixture'
import { board, file, ledgerPath, picture$, spawn, start, world } from './world'
import type { Files } from './world'

const PATH = ledgerPath('demo')
const HANDOVER = PATH.replace('ledger.json', 'handover.md')
const stored = (files: Files): Ledger => JSON.parse(files[PATH]?.text ?? '{}') as Ledger
type Ran = { text?: string; context?: readonly string[] }
const raise = ($: Engine, input: Record<string, unknown>) =>
  ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const reads = ($: Engine, agentId?: string) =>
  raise($, { tool: 'Read', tool_use_id: 'read', file_path: '/repo/README.md', ...(agentId === undefined ? {} : { agentId }) })
const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const turnEnds = ($: Engine, agentId?: string) =>
  $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: `turn-${agentId ?? 'main'}`, reason: 'answer', ...(agentId === undefined ? {} : { agentId }) })
const turnStarts = ($: Engine) => $.turn.start({ text: 'Carry on.', turnId: 'turn-main' })
/** One model request of a loop, as the engine streams it, read to its end. */
async function step($: Engine, agentId: string): Promise<void> {
  const stream = $.turn.step({ turnId: `turn-${agentId}`, index: 0, model: 'claude-sonnet-5-5', messageCount: 4, agentId })
  for await (const _chunk of stream) void _chunk
}

async function bound($: Engine, on: Parameters<typeof world>[0], ledger: Ledger = LEDGER) {
  const clock = mock.clock(on, { now: NOW })
  const session = mock.session(on)
  const files: Files = { [PATH]: file(ledger, 1) }
  const engine = world(on, files)
  await start($)
  await board($, 'demo')

  return { clock, session, files, engine }
}
const notes = (session: ReturnType<typeof mock.session>): string[] =>
  session.appended().map(one => JSON.stringify(one.message.content)).filter(one => one.includes('carried the run'))

test('at 70% and with no turn running, the handover is written and the session compacted, the run\'s state behind the summary', async ($, on) => {
  const { clock, session, files, engine } = await bound($, on)

  engine.percent = 69
  await turnEnds($)
  await clock.advance(5000)
  expect(engine.compactions, 'under the line: nothing').toEqual([])
  expect(stored(files).orchestrator).toEqual({ contextPercent: 69, measuredAt: new Date(NOW).toISOString() })

  engine.percent = 72
  await turnStarts($)
  await clock.advance(5000)
  expect(engine.compactions, 'a turn is running: not now').toEqual([])
  await turnEnds($)
  await clock.advance(5000)

  expect(engine.compactions).toHaveLength(1)
  expect(engine.compactions[0]?.instructions).toBe(KEEP)
  expect(files[HANDOVER]?.text).toContain('# Run demo: Nightly import speed')
  expect(files[HANDOVER]?.text).toContain("with the orchestrator's context 72% full")
  expect(files[HANDOVER]?.text).toContain('- t391-1 [building, sonnet] Pool exhaustion answers 503 · worker w391')
  expect(notes(session), 'the state is in the conversation at once, as a note behind the summary').toHaveLength(1)
  expect(notes(session)[0]).toContain('Run demo: Nightly import speed')
  expect((await reads($)).context, 'and is not handed over a second time').toBeUndefined()
  expect(stored(files).orchestrator).toMatchObject({ contextPercent: 12, rotations: 1 })
  expect(engine.toasts.at(-1)).toBe('Run board: this session was compacted (72% full, now 12%).')

  await clock.advance(60_000)
  expect(engine.compactions, 'once: the reading is 12% now').toHaveLength(1)
  expect((await picture$($, 'desktop')).source).toContain('>Orchestrator 12% full · compacted once<')
})

test('a compaction the engine skips is asked for again ten minutes later, not every few seconds', async ($, on) => {
  const { clock, files, engine } = await bound($, on)
  engine.percent = 80
  engine.skips = 'nothing to compact'
  await turnEnds($)
  await clock.advance(5000)
  expect(engine.compactions).toHaveLength(1)
  expect(engine.toasts.at(-1)).toBe('Run board: not compacted (nothing to compact); the mod asks again in ten minutes.')
  expect(stored(files).orchestrator?.rotations).toBeUndefined()

  await clock.advance(9 * 60_000)
  expect(engine.compactions).toHaveLength(1)
  engine.skips = undefined
  await clock.advance(60_000)
  expect(engine.compactions).toHaveLength(2)
  expect(stored(files).orchestrator?.rotations).toBe(1)
})

test('a run with nothing left to do, and a session bound to no run, are not compacted; /rotate does it on the person\'s word', async ($, on) => {
  const finished: Ledger = { ...LEDGER, tasks: LEDGER.tasks.map(one => ({ ...one, status: 'done' as const })) }
  const { clock, files, engine } = await bound($, on, finished)
  engine.percent = 91
  await turnEnds($)
  await clock.advance(10_000)
  expect(engine.compactions, 'every task is done').toEqual([])

  await turnStarts($)
  await clock.advance(30_000)
  expect((await reads($)).context, 'nor is its orchestrator told that it will be').toBeUndefined()
  await turnEnds($)

  expect((await command($, 'rotate')).text).toBe('Compaction asked for: it runs once no turn is running.')
  await clock.advance(5000)
  expect(engine.compactions, 'asked for').toHaveLength(1)
  expect(files[HANDOVER]).toBeDefined()

  await board($, 'none')
  engine.percent = 95
  await turnEnds($)
  await clock.advance(10_000)
  expect(engine.compactions, 'bound to no run').toHaveLength(1)
  expect((await command($, 'rotate')).text).toContain('bound to no run')
})

test('during a long turn the orchestrator is told once that its context is full enough to end the turn', async ($, on) => {
  const { clock, engine } = await bound($, on)
  await turnStarts($)
  engine.percent = 50
  await clock.advance(30_000)
  expect((await reads($)).context).toBeUndefined()

  engine.percent = 74
  await clock.advance(30_000)
  expect((await reads($)).context?.[0]).toMatch(/^Run board: your context is 74% full\. Finish the step you are on and end your turn/)
  await clock.advance(60_000)
  expect((await reads($)).context, 'once').toBeUndefined()
  expect(engine.compactions, 'never in the middle of its turn').toEqual([])
})

test('any compaction of a bound session keeps the run: the summarizer is told to leave it out, and the ledger\'s state follows the summary', async ($, on) => {
  const { engine } = await bound($, on)
  const transcript = [{ role: 'user' as const, text: 'Start the run.', toolUses: [] }]

  const manual = await $.session.compact({ trigger: 'manual', instructions: 'Keep the list of PRs.', messages: transcript })
  expect(engine.compactions.at(-1)?.instructions).toBe(`Keep the list of PRs.\n\n${KEEP}`)
  expect(manual.messages?.map(one => one.text.slice(0, 40))).toEqual(['Summary of the conversation so far.', "The conductor mod carried the run's stat"])
  expect(manual.messages?.at(-1)?.text).toContain('- t391-1 [building, sonnet]')

  const auto = await $.session.compact({ trigger: 'auto', messages: transcript })
  expect(engine.compactions.at(-1)?.instructions).toBe(KEEP)
  expect(auto.messages).toHaveLength(2)

  const ahead = await $.session.compact({ trigger: 'precompute', messages: transcript })
  expect(ahead.messages, 'a summary computed ahead is left alone: the state would be stale by the time it is used').toHaveLength(1)

  engine.skips = 'too short'
  expect(await $.session.compact({ trigger: 'manual', messages: transcript })).toEqual({ skip: 'too short' })
  engine.skips = undefined

  const before = engine.compactions.length
  // Finished by the owner's word: a task with a pull request is not done on the orchestrator's.
  for (const one of LEDGER.tasks) await command($, 'merged', one.id)
  const finished = await $.session.compact({ trigger: 'auto', instructions: 'Theirs.', messages: transcript })
  expect(finished.messages, 'a finished run: the compaction is left as it is').toHaveLength(1)
  expect(engine.compactions.at(-1)?.instructions).toBe('Theirs.')
  expect(engine.compactions.length).toBe(before + 1)

  await board($, 'none')
  const unbound = await $.session.compact({ trigger: 'manual', instructions: 'Mine.', messages: transcript })
  expect(unbound.messages).toHaveLength(1)
  expect(engine.compactions.at(-1)?.instructions).toBe('Mine.')
})

test('a worker whose own context is compacted keeps its task and what the board holds for it', async ($, on) => {
  const { engine } = await bound($, on)
  engine.agentIds.push('a1', 'child')
  await spawn($, 't392-1')
  await spawn($, undefined, 'a1')
  const transcript = [{ role: 'user' as const, text: 'Do the task.', toolUses: [] }]

  const worker = await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: transcript })
  expect(worker.messages).toHaveLength(2)
  expect(worker.messages?.at(-1)?.text).toMatch(/^---\nRun board \(conductor\)\. You are the worker for task `t392-1`/)
  expect(engine.compactions.at(-1)?.instructions, 'its summary is its own business').toBeUndefined()

  expect((await $.session.compact({ trigger: 'auto', agentId: 'child', messages: transcript })).messages, 'a subagent has no task of its own').toHaveLength(1)
})

test('how many tokens a worker holds is read from its model requests, and past the run\'s limit it is asked once to hand back', async ($, on) => {
  const limited: Ledger = { ...LEDGER, run: { ...LEDGER.run, workerHandbackTokens: 400_000 } }
  const { clock, files, engine } = await bound($, on, limited)
  engine.agentIds.push('a1')
  await spawn($, 't392-1')

  engine.stepTokens = 181_400
  await step($, 'a1')
  await clock.advance(5000)
  expect(stored(files).tasks.find(one => one.id === 't392-1')?.contextTokens).toBe(181_400)
  expect((await reads($, 'a1')).context).toBeUndefined()

  engine.stepTokens = 412_000
  await step($, 'a1')
  await clock.advance(5000)
  expect((await reads($, 'a1')).context?.[0]).toMatch(/^Run board: your context holds about 412 thousand tokens, past this run's limit for a worker\./)
  engine.stepTokens = 430_000
  await step($, 'a1')
  await clock.advance(5000)
  expect((await reads($, 'a1')).context, 'once').toBeUndefined()
  await clock.advance(2000)
  expect((await picture$($, 'desktop')).source).toContain('430k tokens')
})

test('a compaction that goes through neither way is kept on the board with its reason, said once, and tried again in ten minutes', async ($, on) => {
  const { clock, files, engine } = await bound($, on)
  const written = () => files[PATH]?.mtimeMs

  engine.percent = 72
  engine.refusal = 'a turn is running'
  engine.compactCommand = 'cannot be run'
  await turnEnds($)
  await clock.advance(5000)
  expect(engine.compactions, 'the engine was asked').toHaveLength(1)
  expect(engine.commands, 'and then /compact was run for the person').toEqual([{ command: 'compact', args: KEEP }])
  const held = stored(files).orchestrator?.held
  expect(held?.since).toBe(new Date(NOW + 5000).toISOString())
  expect(held?.reason).toMatch(/^\/compact could not be run for you \(.+\); the engine's own call: .+/)
  expect(engine.toasts).toEqual([
    `Run board: a compaction is due and did not go through (${held?.reason}). The mod tries again; /compact works too.`,
  ])
  await clock.advance(2000)
  expect((await picture$($, 'desktop')).source).toContain('>Orchestrator 72% full · compaction waits<')
  const read = await raise($, { tool: 'mcp__conductor__board_read', tool_use_id: 'read-board' })
  expect(read.text).toContain(`This session is due for a compaction that has not gone through since ${held?.since}. The engine's reason: ${held?.reason}.`)

  // A command is not run for the person every half minute: the next try is ten minutes on.
  const before = written()
  await clock.advance(60_000)
  await clock.advance(5 * 60_000)
  expect(engine.commands).toHaveLength(1)
  expect(written(), 'the ledger is left alone meanwhile').toBe(before)
  await clock.advance(5 * 60_000)
  expect(engine.commands).toHaveLength(2)
  expect(engine.toasts, 'the same reason is not said twice').toHaveLength(1)
  expect(stored(files).orchestrator?.held?.since, 'since the first time').toBe(held?.since)

  // Once it goes through, nothing is held up any more.
  engine.compactCommand = 'compacts'
  await clock.advance(10 * 60_000)
  expect(stored(files).orchestrator).toMatchObject({ rotations: 1, contextPercent: 12 })
  expect(stored(files).orchestrator?.held).toBeUndefined()
  expect(engine.toasts.at(-1)).toBe('Run board: this session was compacted (72% full, now 12%).')
})

test('in a session the desktop app runs, the mod compacts by running /compact for the person', async ($, on) => {
  const { clock, session, files, engine } = await bound($, on)
  engine.isSdkHost = true
  engine.percent = 72
  await turnEnds($)
  await clock.advance(5000)

  expect(engine.commands).toEqual([{ command: 'compact', args: KEEP }])
  expect(stored(files).orchestrator).toMatchObject({ rotations: 1, contextPercent: 12 })
  expect(stored(files).orchestrator?.held).toBeUndefined()
  expect(notes(session), "the run's state follows the compaction").toHaveLength(1)
  expect(engine.toasts.at(-1)).toBe('Run board: this session was compacted (72% full, now 12%).')

  // Not again while the context is small.
  await clock.advance(10 * 60_000)
  expect(engine.commands).toHaveLength(1)
})

test('a /compact that leaves the context as full as it was is no compaction, and is not run again every half minute', async ($, on) => {
  const { clock, files, engine } = await bound($, on)
  engine.isSdkHost = true
  engine.compactCommand = 'changes nothing'
  engine.percent = 72
  await turnEnds($)
  await clock.advance(5000)

  expect(stored(files).orchestrator?.rotations).toBeUndefined()
  expect(stored(files).orchestrator?.held?.reason).toMatch(/^\/compact ran and the context is no smaller \(72%\); the engine's own call: /)
  await clock.advance(9 * 60_000)
  expect(engine.commands).toHaveLength(1)
  await clock.advance(2 * 60_000)
  expect(engine.commands).toHaveLength(2)
})

test('/rotate in such a session is tried once, by the command, and not again on every tick', async ($, on) => {
  const { clock, files, engine } = await bound($, on)
  engine.isSdkHost = true
  engine.compactCommand = 'cannot be run'
  expect((await command($, 'rotate')).text).toBe('Compaction asked for: it runs once no turn is running.')
  await clock.advance(5000)
  expect(engine.commands).toHaveLength(1)
  expect(stored(files).orchestrator?.held).toBeDefined()
  await clock.advance(60_000)
  expect(engine.commands, 'the person was answered: it is not asked again by itself').toHaveLength(1)

  engine.compactCommand = 'compacts'
  await command($, 'rotate')
  await clock.advance(5000)
  expect(engine.commands).toHaveLength(2)
  expect(stored(files).orchestrator).toMatchObject({ rotations: 1, contextPercent: 12 })
  expect(stored(files).orchestrator?.held).toBeUndefined()
})

test('a reload of the mod does not forget that a compaction is due', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.session(on)
  const files: Files = { [PATH]: file(LEDGER, 1) }
  const engine = world(on, files)
  // The session was bound before the reload, and its context is past the line.
  engine.store['bound:session-1'] = { run: 'demo', at: new Date(NOW).toISOString() }
  engine.percent = 74
  await start($)

  await clock.advance(5000)
  expect(stored(files).orchestrator?.contextPercent, 'read as the mod starts, without waiting for a turn to end').toBe(12)
  expect(engine.compactions).toHaveLength(1)
})

test('a context that shrank by a compaction of the engine\'s own is not held up any more', async ($, on) => {
  const { clock, files, engine } = await bound($, on)
  engine.percent = 72
  engine.refusal = 'a turn is running'
  engine.compactCommand = 'cannot be run'
  await turnEnds($)
  await clock.advance(5000)
  expect(stored(files).orchestrator?.held).toBeDefined()

  // The engine compacted by itself meanwhile: the next reading is far lower.
  engine.percent = 15
  await turnEnds($)
  expect(stored(files).orchestrator).toMatchObject({ contextPercent: 15 })
  expect(stored(files).orchestrator?.held).toBeUndefined()
  await clock.advance(2000)
  expect((await picture$($, 'desktop')).source).toContain('>Orchestrator 15% full<')
})
