import { describe, expect, test } from 'claude-code/testing'

import { conducting } from '../hooks/plan'
import { LORE_DEFAULTS, PLACEHOLDER_SNIPPET, hasPlaceholder, parseConfig, runsIgnored } from '../hooks/project'
import { runBranchOf, slugOf } from '../hooks/workspace'

const error = (text: string | undefined): string => {
  const read = parseConfig(text)

  return 'error' in read ? read.error : 'accepted'
}

describe('a project config', () => {
  test('no file is an empty config, and the Lore defaults stand', () => {
    expect(parseConfig(undefined)).toEqual({ config: {} })
    expect(LORE_DEFAULTS).toEqual({ branchPrefix: 'conductor/', minFreeGB: 20, carry: [] })
  })

  test('every field reads as given', () => {
    const config = {
      tickets: 'linear',
      linear: { team: 'ABC' },
      lore: { branchPrefix: 'eng/', workspaces: '/work/ws', carry: ['Intermediate', 'DerivedDataCache'], minFreeGB: 30, lockPatterns: ['*.uasset'] },
      check: { argv: ['./Script/check.sh', '--fast'], timeoutMin: 45 },
    }
    expect(parseConfig(JSON.stringify(config))).toEqual({ config })
  })

  test('an unknown key, a bad check, a relative workspaces folder and bad JSON are refused, by name', () => {
    expect(error('{"tickts": "linear"}')).toBe('config.json: "tickts" is no setting here (tickets, linear, lore, check).')
    expect(error('{"lore": {"bins": "x"}}')).toBe('config.json: "lore.bins" is no setting here (branchPrefix, workspaces, carry, minFreeGB, lockPatterns).')
    expect(error('{"lore": {"bin": "/tmp/evil"}}'), 'which program runs is never the project\'s to say').toBe(
      'config.json: "lore.bin" is no setting here (branchPrefix, workspaces, carry, minFreeGB, lockPatterns).',
    )
    expect(error('{"tickets": "jira"}')).toBe('config.json: tickets is "github" or "linear".')
    expect(error('{"check": {"argv": [], "timeoutMin": 5}}')).toBe('config.json: check.argv is a non-empty list of strings: the program and its arguments.')
    expect(error('{"check": {"argv": ["x"], "timeoutMin": 0}}')).toBe('config.json: check.timeoutMin is a whole number of minutes from 1 to 240.')
    expect(error('{"lore": {"workspaces": "ws"}}')).toBe('config.json: lore.workspaces is an absolute path.')
    expect(error('{"lore": {"minFreeGB": -1}}')).toBe('config.json: lore.minFreeGB is a whole number of gigabytes from 0.')
    expect(error('{"linear": {"team": "abc"}}')).toBe('config.json: linear.team is a Linear team key, like ABC.')
    expect(error('{oops')).toBe('config.json is not valid JSON.')
    expect(error('{"lore": {"branchPrefix": "-f"}}')).toBe('config.json: lore.branchPrefix is letters, digits and . _ / -, starting with a letter or digit.')
  })
})

describe('what a Lore project needs before a run', () => {
  test('the WorktreeCreate placeholder, in either settings file', () => {
    expect(hasPlaceholder([undefined, undefined])).toBe(false)
    expect(hasPlaceholder(['{"hooks": {"Stop": []}}', undefined])).toBe(false)
    expect(hasPlaceholder([undefined, PLACEHOLDER_SNIPPET])).toBe(true)
    expect(hasPlaceholder(['not json', PLACEHOLDER_SNIPPET])).toBe(true)
    const snippet = JSON.parse(PLACEHOLDER_SNIPPET) as { hooks: { WorktreeCreate: { hooks: { type: string; command: string }[] }[] } }
    expect(snippet.hooks.WorktreeCreate[0]?.hooks[0]).toEqual({
      type: 'command',
      command: "echo 'Worker workspaces here are made by the conductor mod. Install or enable conductor.' >&2; exit 1",
    })
  })

  test('the runs folder ignored by .loreignore', () => {
    expect(runsIgnored(undefined)).toBe(false)
    expect(runsIgnored('/Saved/\n')).toBe(false)
    expect(runsIgnored('/Saved/\n.claude/conductor/runs/\n')).toBe(true)
  })
})

describe('a run from a Linear issue', () => {
  test('a key or a link to it starts a Linear run named by the key', () => {
    const LINEAR = { id: 'ABC-12', source: 'ABC-12', kind: 'linear' }
    expect(conducting('ABC-12')).toEqual(LINEAR)
    expect(conducting('https://linear.app/acme/issue/ABC-12/retry-the-flaky-upload')).toEqual(LINEAR)
    expect(conducting('ABC-12 Retry the flaky upload')).toEqual({ ...LINEAR, title: 'Retry the flaky upload' })
    expect(conducting('#12 ABC-12'), 'a GitHub issue comes first').toMatchObject({ source: '#12', title: 'ABC-12' })
  })

  test('the run branch is the prefix, the key and a short slug of the title', () => {
    expect(slugOf('Retry the flaky upload!')).toBe('retry-the-flaky-upload')
    expect(slugOf('Ünïcode & co')).toBe('n-code-co')
    expect(slugOf('x'.repeat(60))).toHaveLength(40)
    expect(runBranchOf('conductor/', 'ABC-12', 'ABC-12', 'Retry the flaky upload')).toBe('conductor/ABC-12-retry-the-flaky-upload')
    expect(runBranchOf('eng/', 'docs/spec.md', 'spec', undefined)).toBe('eng/spec')
    expect(runBranchOf('', '#12', '12', '!!!')).toBe('12')
  })
})
