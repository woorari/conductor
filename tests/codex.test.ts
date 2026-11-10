import { describe, expect, test } from 'claude-code/testing'

import { LAST_WORDS_MAX, after, again, codexArgv, codexBrief, reader, serversIn, serversOff } from '../hooks/codex'
import { parseLedger } from '../hooks/ledger'
import type { Ledger } from '../types'
import { LEDGER } from './fixture'

function ledgerWithRuling(): Ledger {
  const raw = JSON.parse(JSON.stringify(LEDGER))
  raw.rulings = [{ id: 'R1', text: 'Use the shared parser.', at: '2026-10-09T10:30:00.000Z', tasks: ['t391-1'] }]
  return parseLedger(JSON.stringify(raw)).ledger!
}

describe('codexArgv', () => {
  test('the sandbox is fixed and the brief is not in it', () => {
    const argv = codexArgv({ cwd: '/work/w 1', servers: ['pencil', 'my.server'], model: 'gpt-5.1-codex', effort: 'medium' })
    expect(argv.slice(0, 6)).toEqual(['codex', 'exec', '-C', '/work/w 1', '-s', 'workspace-write'])
    expect(argv).toContain('sandbox_workspace_write.network_access=false')
    expect(argv).toContain('agents.enabled=false')
    expect(argv).toContain('mcp_servers.pencil.enabled=false')
    expect(argv).toContain('mcp_servers."my.server".enabled=false')
    expect(argv).toContain('model_reasoning_effort=medium')
    expect(argv.at(-1)).toBe('-')
    expect(argv.join(' ')).not.toMatch(/danger|bypass/)
  })

  test('a second turn resumes the thread', () => {
    const argv = codexArgv({ cwd: '/w', servers: [], thread: 'th-1' })
    expect(argv.slice(0, 3)).toEqual(['codex', 'exec', 'resume'])
    expect(argv.slice(-2)).toEqual(['th-1', '-'])
    expect(argv).toContain('sandbox_mode="workspace-write"')
    expect(argv).toContain('sandbox_workspace_write.network_access=false')
    expect(argv).toContain('agents.enabled=false')
    expect(argv).not.toContain('-C')
    expect(argv).not.toContain('-s')
  })

  test('a resumed turn keeps the servers off and the model', () => {
    const argv = codexArgv({ cwd: '/w', servers: ['a'], model: 'm', thread: 't' })
    expect(argv).toContain('mcp_servers.a.enabled=false')
    expect(argv).toContain('-m')
    expect(argv.at(-1)).toBe('-')
  })

  test('a server name with a quote is escaped in its key', () => {
    expect(codexArgv({ cwd: '/w', servers: ['a"b'] })).toContain('mcp_servers."a\\"b".enabled=false')
  })
})

describe('servers', () => {
  test('read from the config, the kept ones left on', () => {
    const toml = '[mcp_servers.pencil]\ncommand = "x"\n[mcp_servers."my.server".env]\nA = "1"\n[mcp_servers.blender]\n'
    expect(serversIn(toml)).toEqual(['pencil', 'my.server', 'blender'])
    expect(serversOff(serversIn(toml), ['blender'])).toEqual(['pencil', 'my.server'])
    expect(serversOff(['a', 'b'], undefined)).toEqual(['a', 'b'])
    expect(serversIn(undefined)).toEqual([])
  })

  test('a sub-table does not repeat the server, and dotted or quoted names stay whole', () => {
    const toml = [
      '[mcp_servers."a.b"]',
      'command = "x"',
      '[mcp_servers."a.b".env]',
      'K = "v"',
      '[mcp_servers.c.env]',
      "[ mcp_servers.'d e' ]",
      '[other.table]',
      '# [mcp_servers.commented]',
      '',
    ].join('\n')
    expect(serversIn(toml)).toEqual(['a.b', 'c', 'd e'])
  })
})

describe('servers not declared as table headers', () => {
  test('keys under [mcp_servers] itself', () => {
    const toml = '[mcp_servers]\npencil = { command = "x" }\n"my.server".command = "y"\n\'q r\' = {}\n'
    expect(serversIn(toml)).toEqual(['pencil', 'my.server', 'q r'])
  })

  test('dotted keys at the top level', () => {
    const toml = 'mcp_servers.blender.command = "z"\nmcp_servers."a.b" = { command = "w" }\nmodel = "m"\n[other]\nx = 1\n'
    expect(serversIn(toml)).toEqual(['blender', 'a.b'])
  })

  test('a key inside another table counts only by its own meaning', () => {
    const toml = '[profiles.x]\nmcp_servers.q.command = "1"\n[mcp_servers.real]\n[profiles.y]\nreal2 = 1\n'
    expect(serversIn(toml)).toEqual(['real'])
  })

  test('the sub-table of a server does not make its keys servers', () => {
    expect(serversIn('[mcp_servers.a.env]\nK = "v"\n[mcp_servers.b]\ncommand = "x"\n')).toEqual(['a', 'b'])
  })
})

describe('reader', () => {
  test('events across pieces, and lines that are not events', () => {
    const read = reader()
    const line = JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/w/a.ts', kind: 'update' }] } })
    expect(read.feed('warning: something\n' + line.slice(0, 20))).toEqual([])
    expect(read.feed(line.slice(20) + '\n{"type":"thread.started","thread_id":"th-1"}\n')).toEqual([
      { is: 'files', paths: ['/w/a.ts'] },
      { is: 'thread', id: 'th-1' },
    ])
    expect(read.feed('{"type":"turn.completed","usage":{}}')).toEqual([])
    expect(read.rest()).toEqual([{ is: 'ended', ok: true }])
  })

  test('a failed turn carries its error', () => {
    expect(reader().feed('{"type":"turn.failed","error":{"message":"usage limit reached"}}\n')).toEqual([
      { is: 'ended', ok: false, error: 'usage limit reached' },
    ])
  })

  test('CRLF line endings', () => {
    const events = reader().feed('{"type":"thread.started","thread_id":"t"}\r\n{"type":"turn.completed"}\r\n')
    expect(events).toEqual([{ is: 'thread', id: 't' }, { is: 'ended', ok: true }])
  })

  test('a line split one character at a time', () => {
    const read = reader()
    const text = '{"type":"thread.started","thread_id":"abc"}\n'
    const got = [...text].flatMap(char => read.feed(char))
    expect(got).toEqual([{ is: 'thread', id: 'abc' }])
  })

  test('lines that are not JSON, or not events, are skipped', () => {
    const read = reader()
    expect(read.feed('not json\n[1,2]\n42\n{"type":"mystery"}\n{"no":"type"}\n\n')).toEqual([])
    expect(read.rest()).toEqual([])
  })

  test('an unterminated last line is read by rest, and a half line is dropped', () => {
    const read = reader()
    expect(read.feed('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}')).toEqual([])
    expect(read.rest()).toEqual([{ is: 'said', text: 'done' }])
    const half = reader()
    half.feed('{"type":"item.comp')
    expect(half.rest()).toEqual([])
  })

  test('commands, sayings, and an error event', () => {
    const events = reader().feed(
      [
        '{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}',
        '{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}',
        '{"type":"error","message":"boom"}',
        '',
      ].join('\n'),
    )
    expect(events).toEqual([
      { is: 'ran', command: 'npm test' },
      { is: 'ran', command: 'npm test' },
      { is: 'said', text: 'hi' },
      { is: 'ended', ok: false, error: 'boom' },
    ])
  })

  test('a saying is cut to the last-words limit', () => {
    const long = 'x'.repeat(LAST_WORDS_MAX + 500)
    const [one] = reader().feed(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: long } }) + '\n')
    expect(one).toEqual({ is: 'said', text: 'x'.repeat(LAST_WORDS_MAX) })
  })
})

describe('after', () => {
  test('one more turn, once', () => {
    expect(after({ number: 1, ok: false, check: 'none', changed: true })).toBe('again')
    expect(after({ number: 1, ok: true, check: 'failed', changed: true })).toBe('again')
    expect(after({ number: 2, ok: true, check: 'failed', changed: true })).toBe('fail')
    expect(after({ number: 2, ok: false, check: 'none', changed: true })).toBe('fail')
    expect(after({ number: 1, ok: true, check: 'passed', changed: true })).toBe('open')
    expect(after({ number: 1, ok: true, check: 'none', changed: true })).toBe('open')
    expect(after({ number: 1, ok: true, check: 'none', changed: false })).toBe('fail')
  })
})

describe('codexBrief', () => {
  test('what a Codex worker is told', () => {
    const ledger = ledgerWithRuling()
    const one = ledger.tasks.find(item => item.id === 't391-1')!
    const text = codexBrief(ledger, one, { brief: 'Task {task}, slot {slot}, run {run}.', slot: 2 })
    expect(text).toContain('`t391-1`')
    expect(text).toContain(`\`${ledger.run.id}\``)
    expect(text).toContain('Do not commit')
    expect(text).toContain('CLAUDE.md')
    expect(text).toContain(`Task t391_1, slot 2, run ${ledger.run.id}.`)
    expect(text).toContain('Use the shared parser.')
    expect(text).not.toContain('mcp__conductor__')
    expect(text.indexOf('Do not commit')).toBeLessThan(text.indexOf('CLAUDE.md'))
  })

  test('without a project brief it still stands', () => {
    const ledger = ledgerWithRuling()
    expect(codexBrief(ledger, ledger.tasks[0]!)).toContain('pull request')
  })
})

describe('again', () => {
  test('names what went wrong', () => {
    expect(again({ error: 'usage limit' })).toContain('usage limit')
    expect(again({ check: 'lint failed' })).toContain('lint failed')
    expect(again({ rulings: '- Ruling R1: x' })).toContain('Ruling R1')
  })
})
