import { describe, expect, test } from 'claude-code/testing'

import { conducting } from '../hooks/plan'
import { LORE_DEFAULTS, PLACEHOLDER_SNIPPET, hasPlaceholder, homeConfigProblem, parseConfig, placeConfig, runsIgnored } from '../hooks/project'
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
    expect(error('{"lore": {"workspaces": "/"}}')).toBe('config.json: lore.workspaces is an absolute path.')
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

describe('places: a home that is not a repository', () => {
  const PLACES = [
    { folder: 'studio', teams: ['ABC'], about: "the studio's own tools", check: { argv: ['npm', 'test'], timeoutMin: 20 } },
    { folder: 'game/code', teams: ['DEF'], about: 'engine and game code', lore: { branchPrefix: 'conductor/' } },
    { folder: 'game/art', teams: ['DEF'], about: '3D art and source assets' },
  ]
  const placed = (places: unknown): string => error(JSON.stringify({ places }))
  const one = (place: Record<string, unknown>): string => placed([{ folder: 'studio', teams: ['ABC'], about: 'x', ...place }])
  const FOLDER = 'config.json: places[0].folder must be a folder inside this home, given relative to it.'

  test("places: a folder home's config with places is read as given", () => {
    expect(parseConfig(JSON.stringify({ places: PLACES }))).toEqual({ config: { places: PLACES } })
  })

  test('places: each folder that leads nowhere safe is refused', () => {
    for (const folder of ['', '.', '/abs', '~/x', '..', 'a/../b', 'a/..', 'a\\b', 'a\u0000b', 'a/./b', 3]) {
      expect(one({ folder }), JSON.stringify(folder)).toBe(FOLDER)
    }
  })

  test('places: two places that are the same folder, or one inside the other, are refused', () => {
    const OVERLAP = 'config.json: places[1].folder lies inside, above or on places[0].folder: places may not overlap.'
    for (const [first, second] of [['a', 'a'], ['a', 'a/b'], ['a/b', 'a'], ['a/', 'a']]) {
      expect(placed([{ folder: first, teams: ['ABC'], about: 'x' }, { folder: second, teams: ['ABC'], about: 'y' }]), `${first} ${second}`).toBe(OVERLAP)
    }
    expect(placed([{ folder: 'ab', teams: ['ABC'], about: 'x' }, { folder: 'a', teams: ['ABC'], about: 'y' }]), 'a shared prefix is no overlap').toBe('accepted')
  })

  test('places: teams are Linear team keys and about is one line', () => {
    const TEAMS = 'config.json: places[0].teams is a list of one or more Linear team keys, like ["ABC"].'
    expect(one({ teams: [] })).toBe(TEAMS)
    expect(one({ teams: ['abc'] })).toBe(TEAMS)
    expect(one({ teams: 'ABC' })).toBe(TEAMS)
    const ABOUT = 'config.json: places[0].about is one line that says what belongs there.'
    expect(placed([{ folder: 'studio', teams: ['ABC'] }])).toBe(ABOUT)
    expect(one({ about: 'two\nlines' })).toBe(ABOUT)
    expect(one({ about: ' ' })).toBe(ABOUT)
    expect(placed([])).toBe('config.json: places is a list of one or more places.')
    expect(error('{"places": {}}')).toBe('config.json: places is a list of one or more places.')
  })

  test("places: a place's lore, check and base are checked as the top-level ones are", () => {
    expect(one({ lore: { minFreeGB: -1 } })).toBe('config.json: places[0].lore.minFreeGB is a whole number of gigabytes from 0.')
    expect(one({ lore: { workspaces: 'rel' } })).toBe('config.json: places[0].lore.workspaces is an absolute path.')
    expect(one({ lore: { bins: 'x' } })).toBe('config.json: "places[0].lore.bins" is no setting here (branchPrefix, workspaces, carry, minFreeGB, lockPatterns).')
    expect(one({ check: { argv: [], timeoutMin: 5 } })).toBe('config.json: places[0].check.argv is a non-empty list of strings: the program and its arguments.')
    expect(one({ bogus: 1 })).toBe('config.json: "places[0].bogus" is no setting here (folder, teams, about, base, lore, check).')
    const BASE = 'config.json: places[0].base is a branch name: letters, digits and . _ / -, starting with a letter or digit.'
    expect(one({ base: '' })).toBe(BASE)
    expect(one({ base: '-main' })).toBe(BASE)
    expect(one({ base: 'release/2' })).toBe('accepted')
  })

  test('homeConfigProblem: places belong to a folder home only', () => {
    const places = [PLACES[0]!]
    expect(homeConfigProblem({ places }, 'repository')).toBe('config.json: places is for a home that is not itself a repository. Here the repository is the workspace: remove places.')
    expect(homeConfigProblem({}, 'folder')).toBe(
      'config.json: this home is not a repository, so it lists its places, for example {"places": [{"folder": "studio", "teams": ["ABC"], "about": "what belongs there"}]}.',
    )
    for (const key of ['lore', 'check', 'linear'] as const) {
      const config = { places, [key]: key === 'check' ? { argv: ['x'], timeoutMin: 1 } : {} }
      expect(homeConfigProblem(config, 'folder')).toBe(`config.json: in a home that is not a repository, ${key} belongs in a place: move it into the place it is for.`)
    }
    expect(homeConfigProblem({ places, tickets: 'github' }, 'folder')).toBe('config.json: in a home that is not a repository, tickets are Linear: remove "tickets": "github".')
    expect(homeConfigProblem({ places, tickets: 'linear' }, 'folder')).toBeUndefined()
    expect(homeConfigProblem({ places }, 'folder')).toBeUndefined()
    expect(homeConfigProblem({ lore: {} }, 'repository')).toBeUndefined()
  })

  test("placeConfig: a run takes its place's settings in today's shape", () => {
    expect(placeConfig({ folder: 'game/code', teams: ['DEF', 'ABC'], about: 'x', lore: { branchPrefix: 'c/' } }, 'ABC')).toEqual({
      tickets: 'linear',
      linear: { team: 'ABC' },
      lore: { branchPrefix: 'c/' },
    })
    expect(placeConfig({ folder: 'studio', teams: ['ABC'], about: 'x', base: 'master', check: { argv: ['npm', 'test'], timeoutMin: 20 } }, 'ABC')).toEqual({
      tickets: 'linear',
      linear: { team: 'ABC' },
      check: { argv: ['npm', 'test'], timeoutMin: 20 },
    })
  })
})
