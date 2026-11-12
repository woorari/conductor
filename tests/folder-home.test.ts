import { describe, expect, test } from 'claude-code/testing'

import { candidatesFor, findHome, trustedRootsOf, workspaceOfSpec, workspacesIn } from '../hooks/home'
import type { Io } from '../hooks/home'
import type { Place } from '../types'

/**
 * An in-memory file tree: the folders given and every folder above them.
 * `links` maps a folder to where it really is, as a symlink does; a folder in
 * `unreadable` has no real path that can be read.
 */
function tree(paths: readonly string[], more: { links?: Record<string, string>; unreadable?: readonly string[]; userHome?: string; trustedRoots?: readonly string[] } = {}): Io {
  const dirs = new Set<string>()
  for (const path of paths) {
    let at = path
    while (at !== '') {
      dirs.add(at)
      at = at.slice(0, at.lastIndexOf('/'))
    }
  }

  return {
    exists: async path => dirs.has(path),
    list: async path => [...dirs].filter(one => one.startsWith(`${path}/`) && !one.slice(path.length + 1).includes('/')).map(one => ({ name: one.slice(path.length + 1), kind: 'dir' as const })),
    real: async path => {
      if (!dirs.has(path) || (more.unreadable ?? []).includes(path)) return undefined
      let real = path
      for (const [from, to] of Object.entries(more.links ?? {})) {
        if (real === from || real.startsWith(`${from}/`)) real = `${to}${real.slice(from.length)}`
      }

      return real
    },
    userHome: more.userHome ?? '/home/owner',
    trustedRoots: more.trustedRoots,
  }
}

const HOME = '/home/owner/work'
const CONDUCTOR = `${HOME}/.claude/conductor`
const LORE_WS = `${HOME}/game/code/Big Game 5.8`
const PLACES: Place[] = [
  { folder: 'studio', teams: ['ABC'], about: "the studio's own tools" },
  { folder: 'game/code', teams: ['DEF'], about: 'engine and game code' },
  { folder: 'game/art', teams: ['DEF'], about: '3D art and source assets' },
]
const FOLDER = (at: number) => `config.json: places[${at}].folder must be a folder inside this home, given relative to it.`

describe('finding the home', () => {
  test('findHome: a folder with .claude/conductor that is no repository is a folder home', async () => {
    const io = tree([CONDUCTOR, `${HOME}/game`])
    expect(await findHome(io, HOME, null)).toEqual({ kind: 'folder', root: HOME })
    expect(await findHome(io, `${HOME}/game`, null)).toEqual({ kind: 'folder', root: HOME })
    expect(await findHome(io, `${HOME}/game/`, null), 'a trailing slash changes nothing').toEqual({ kind: 'folder', root: HOME })
  })

  test('findHome: a session inside a repository without its own home finds the folder home above', async () => {
    const io = tree([CONDUCTOR, `${HOME}/studio/.git`, `${HOME}/studio/src`, `${LORE_WS}/.lore`, `${LORE_WS}/Source`])
    expect(await findHome(io, `${HOME}/studio/src`, `${HOME}/studio`)).toEqual({ kind: 'folder', root: HOME })
    expect(await findHome(io, `${LORE_WS}/Source`, null)).toEqual({ kind: 'folder', root: HOME })
  })

  test('findHome: the nearer repository home wins', async () => {
    const io = tree([CONDUCTOR, `${LORE_WS}/.lore`, `${LORE_WS}/.claude/conductor`, `${LORE_WS}/Source`])
    expect(await findHome(io, `${LORE_WS}/Source`, null)).toEqual({ kind: 'repository', root: LORE_WS })
  })

  test('findHome: .claude/conductor below a repository root means nothing', async () => {
    const io = tree([CONDUCTOR, `${HOME}/studio/.git`, `${HOME}/studio/sub/.claude/conductor`])
    expect(await findHome(io, `${HOME}/studio/sub`, `${HOME}/studio`)).toEqual({ kind: 'folder', root: HOME })
    const inLore = tree([`/w/ws/.lore`, `/w/ws/sub/.claude/conductor`])
    expect(await findHome(inLore, '/w/ws/sub', null), 'nor below a Lore root, and nothing above').toBeNull()
  })

  test("findHome: the user's own home folder and / are never a home", async () => {
    const io = tree(['/home/owner/.claude/conductor', '/home/owner/x', '/.claude/conductor'])
    expect(await findHome(io, '/home/owner/x', null)).toBeNull()
    expect(await findHome(io, '/', null)).toBeNull()
    expect(await findHome(tree([]), '/nowhere/at/all', null), 'the walk ends where there is no home').toBeNull()
  })

  test('findHome: a repository home is found as today', async () => {
    const io = tree(['/repo/.claude/conductor', '/repo/src'])
    expect(await findHome(io, '/repo/src', '/repo')).toEqual({ kind: 'repository', root: '/repo' })
    expect(await findHome(tree(['/ws/.lore', '/ws/.claude/conductor']), '/ws', null)).toEqual({ kind: 'repository', root: '/ws' })
  })
})

describe('a folder home lies in the user\'s own home folder', () => {
  test('findHome: a folder home above or outside the user\'s home folder is never taken', async () => {
    expect(await findHome(tree(['/tmp/.claude/conductor', '/tmp/x']), '/tmp/x', null), 'a shared folder another user could write').toBeNull()
    expect(await findHome(tree(['/home/.claude/conductor', '/home/owner/x']), '/home/owner/x', null), 'above the home folder').toBeNull()
    expect(await findHome(tree([CONDUCTOR]), HOME, null), 'inside it').toEqual({ kind: 'folder', root: HOME })
    expect(await findHome(tree([CONDUCTOR], { userHome: '/home/owner/' }), HOME, null), 'a home folder given with a trailing slash').toEqual({ kind: 'folder', root: HOME })
  })

  test('findHome: with no user home folder known there is no folder home', async () => {
    const io = { ...tree([CONDUCTOR]), userHome: undefined }
    expect(await findHome(io, HOME, null)).toBeNull()
  })

  test('findHome: a folder home whose real path leads out of the user\'s home folder is not taken', async () => {
    const io = tree([CONDUCTOR, '/srv/shared/.claude/conductor'], { links: { [HOME]: '/srv/shared' } })
    expect(await findHome(io, HOME, null)).toBeNull()
  })

  test('findHome: a .git folder git did not name for the session is no repository home', async () => {
    const io = tree(['/tmp/x/.git', '/tmp/x/.claude/conductor', '/tmp/x/y'])
    expect(await findHome(io, '/tmp/x/y', null)).toBeNull()
  })
  describe('trusted roots', () => {
    const SSD = '/Volumes/Dev/Afterglow'
    const LINK = '/home/owner/Afterglow'
    const world = (trusted?: readonly string[], more: Parameters<typeof tree>[1] = {}) =>
      tree([`${SSD}/.claude/conductor`, `${SSD}/Games/Coreborn`], { links: { [LINK]: SSD }, trustedRoots: trusted, ...more })

    test('a home that moved outside the home folder is refused without the option', async () => {
      expect(await findHome(world(), `${SSD}/Games/Coreborn`, null)).toBeNull()
      expect(await findHome(world([]), `${SSD}/Games/Coreborn`, null)).toBeNull()
      expect(await findHome(world(), `${LINK}/Games/Coreborn`, null), 'the symlink path leads out of the home folder').toBeNull()
    })

    test('it is accepted when its folder is trusted', async () => {
      expect(await findHome(world(['/Volumes/Dev']), `${SSD}/Games/Coreborn`, null)).toEqual({ kind: 'folder', root: SSD })
      expect(await findHome(world(['/Volumes/Dev/']), `${SSD}/Games/Coreborn`, null), 'a trailing slash changes nothing').toEqual({ kind: 'folder', root: SSD })
      expect(await findHome(world(['/Volumes/Dev'], { links: { [SSD]: SSD } }), SSD, null)).toEqual({ kind: 'folder', root: SSD })
      const linked = tree([`${SSD}/.claude/conductor`, `${LINK}/.claude/conductor`, `${LINK}/Games/Coreborn`], { links: { [LINK]: SSD }, trustedRoots: ['/Volumes/Dev'] })
      expect(await findHome(linked, `${LINK}/Games/Coreborn`, null), 'the home folder path that leads onto the trusted volume').toEqual({ kind: 'folder', root: LINK })
      const untrusted = tree([`${SSD}/.claude/conductor`, `${LINK}/.claude/conductor`, `${LINK}/Games/Coreborn`], { links: { [LINK]: SSD } })
      expect(await findHome(untrusted, `${LINK}/Games/Coreborn`, null), 'not without the option').toBeNull()
    })

    test('a trusted root is itself never a home', async () => {
      const io = tree(['/Volumes/Dev/.claude/conductor'], { trustedRoots: ['/Volumes/Dev'] })
      expect(await findHome(io, '/Volumes/Dev', null)).toBeNull()
    })

    test("a trusted '/' trusts nothing", async () => {
      expect(await findHome(world(['/']), `${SSD}/Games/Coreborn`, null)).toBeNull()
      expect(await findHome(world(['//', '///']), `${SSD}/Games/Coreborn`, null)).toBeNull()
      const io = tree([`${SSD}/.claude/conductor`], { links: { '/Volumes/Dev': '/' }, trustedRoots: ['/Volumes/Dev'] })
      expect(await findHome(io, SSD, null), 'a root that resolves to /').toBeNull()
    })

    test('a real path that escapes the trusted root is refused', async () => {
      const io = tree([`${SSD}/.claude/conductor`], { links: { [SSD]: '/srv/other/Afterglow' }, trustedRoots: ['/Volumes/Dev'] })
      expect(await findHome(io, SSD, null)).toBeNull()
      const unreadable = tree([`${SSD}/.claude/conductor`], { unreadable: [SSD], trustedRoots: ['/Volumes/Dev'] })
      expect(await findHome(unreadable, SSD, null)).toBeNull()
    })

    test('a folder inside a repository is refused', async () => {
      const io = tree([`${SSD}/.claude/conductor`, `${SSD}/.git`, `${SSD}/sub/.git`], { trustedRoots: ['/Volumes/Dev'] })
      expect(await findHome(io, `${SSD}/sub`, null), 'a repository root').toBeNull()
      const inner = tree(['/Volumes/Dev/repo/.git', '/Volumes/Dev/repo/inner/.claude/conductor'], { trustedRoots: ['/Volumes/Dev'] })
      expect(await findHome(inner, '/Volumes/Dev/repo/inner', null)).toBeNull()
      expect(await findHome(world(['/Volumes/Dev']), `${SSD}/Games/Coreborn`, `${SSD}`), 'git names the folder a repository').toEqual({ kind: 'repository', root: SSD })
    })

    test('the option is read with care', () => {
      expect(trustedRootsOf({ trustedRoots: '/Volumes/Dev/:/a/b, /c' })).toEqual(['/Volumes/Dev', '/a/b', '/c'])
      expect(trustedRootsOf({ trustedRoots: '/' })).toEqual([])
      expect(trustedRootsOf({ trustedRoots: 'rel/path:~/x:/a/../b:/a//b:/ok' })).toEqual(['/ok'])
      for (const odd of [undefined, null, 7, [], { trustedRoots: 5 }, { trustedRoots: ['/a'] }, { trustedRoots: '' }]) expect(trustedRootsOf(odd)).toEqual([])
    })
  })
})

describe('the workspaces in a place', () => {
  test('workspacesIn: the place itself and its direct subfolders that are roots', async () => {
    const code = `${HOME}/game/code`
    const io = tree([`${LORE_WS}/.lore`, `${code}/Engine/Source/deep/.lore`, `${code}/Big Game 5.8.conductor/run/t1/.lore`, `${code}/.hidden/.lore`])
    expect(await workspacesIn(io, code)).toEqual({ found: [{ kind: 'lore', root: LORE_WS }], left: [] })

    const nested = tree(['/p/.lore', '/p/inner/.lore'])
    expect(await workspacesIn(nested, '/p')).toEqual({ found: [{ kind: 'lore', root: '/p' }, { kind: 'lore', root: '/p/inner' }], left: [] })

    const both = tree(['/p/.lore', '/p/.git'])
    expect((await workspacesIn(both, '/p')).found, 'a folder that is both counts as git, as today').toEqual([{ kind: 'git', root: '/p' }])
  })

  test('workspacesIn: a subfolder that leads out through a symlink is left out', async () => {
    const art = `${HOME}/game/art`
    const io = tree([`${art}/linked/.lore`, `${art}/own/.git`], { links: { [`${art}/linked`]: '/elsewhere' } })
    expect(await workspacesIn(io, art)).toEqual({ found: [{ kind: 'git', root: `${art}/own` }], left: [`${art}/linked leads out of its place`] })
  })
})

describe('the candidates for a ticket', () => {
  const HERE = [CONDUCTOR, `${HOME}/studio/.git`, `${LORE_WS}/.lore`, `${HOME}/game/art`]

  test('candidatesFor: the workspaces in the places of the team', async () => {
    expect(await candidatesFor(tree(HERE), HOME, PLACES, 'ABC')).toEqual({ candidates: [{ kind: 'git', root: `${HOME}/studio`, place: 'studio', about: "the studio's own tools" }], left: [] })
    expect(await candidatesFor(tree(HERE), HOME, PLACES, 'DEF')).toEqual({ candidates: [{ kind: 'lore', root: LORE_WS, place: 'game/code', about: 'engine and game code' }], left: [] })
  })

  test('candidatesFor: a place that leads out of the home is refused', async () => {
    const out = tree([...HERE, '/elsewhere/game/code/.lore'], { links: { [`${HOME}/game`]: '/elsewhere/game' } })
    expect(await candidatesFor(out, HOME, PLACES, 'DEF')).toEqual({ error: FOLDER(1) })
    const unreadable = tree(HERE, { unreadable: [`${HOME}/game/code`] })
    expect(await candidatesFor(unreadable, HOME, PLACES, 'DEF'), 'a real path that cannot be read fails closed').toEqual({ error: FOLDER(1) })
    const linkedPlace = tree([...HERE, '/elsewhere/art/.lore'], { links: { [`${HOME}/game/art`]: '/elsewhere/art' } })
    expect(await candidatesFor(linkedPlace, HOME, PLACES, 'DEF'), 'every place of the team is checked').toEqual({ error: FOLDER(2) })
    const missing = tree([CONDUCTOR, `${HOME}/studio/.git`, `${LORE_WS}/.lore`])
    expect(await candidatesFor(missing, HOME, PLACES, 'DEF')).toEqual({ error: 'No run was started. places[2].folder, game/art, is no folder in this home: correct config.json, or make the folder.' })
  })

  test('candidatesFor: a symlinked home still takes its own places', async () => {
    const io = tree(['/tmp/work/.claude/conductor', '/tmp/work/studio/.git', '/private/tmp/work/studio/.git'], { links: { '/tmp': '/private/tmp' } })
    expect(await candidatesFor(io, '/tmp/work', PLACES, 'ABC')).toEqual({
      candidates: [{ kind: 'git', root: '/private/tmp/work/studio', place: 'studio', about: "the studio's own tools" }],
      left: [],
    })
  })

  test('candidatesFor: no place for the team, and places with no workspace', async () => {
    expect(await candidatesFor(tree(HERE), HOME, PLACES, 'XYZ')).toEqual({
      error: "No run was started. No place in .claude/conductor/config.json takes team XYZ: add XYZ to a place's teams.",
    })
    const empty = tree([CONDUCTOR, `${HOME}/game/code`, `${HOME}/game/art`])
    expect(await candidatesFor(empty, HOME, [PLACES[1]!], 'DEF')).toEqual({
      error: 'No run was started. game/code holds no git or Lore workspace. Put the folder the work needs into Lore or git first, then give /conduct again.',
    })
    expect(await candidatesFor(empty, HOME, PLACES, 'DEF')).toEqual({
      error: 'No run was started. game/code and game/art hold no git or Lore workspace. Put the folder the work needs into Lore or git first, then give /conduct again.',
    })
  })

  test('workspaceOfSpec: the nearest root that holds the spec wins, and a spec in no workspace is refused', async () => {
    const io = tree([...HERE, `${LORE_WS}/docs`, `${HOME}/game/code/.lore`, `${HOME}/game/code/notes`])
    expect(await workspaceOfSpec(io, HOME, PLACES, 'game/code/Big Game 5.8/docs/x.md'), 'a workspace nested in another is left out: the outer one holds the spec').toEqual({
      candidate: { kind: 'lore', root: `${HOME}/game/code`, place: 'game/code', about: 'engine and game code' },
      team: 'DEF',
    })
    expect(await workspaceOfSpec(tree([...HERE, `${LORE_WS}/docs`]), HOME, PLACES, 'game/code/Big Game 5.8/docs/x.md'), 'the nearest root').toEqual({
      candidate: { kind: 'lore', root: LORE_WS, place: 'game/code', about: 'engine and game code' },
      team: 'DEF',
    })
    expect(await workspaceOfSpec(io, HOME, PLACES, `${HOME}/game/code/notes/y.md`), 'an absolute path, in the outer root').toEqual({
      candidate: { kind: 'lore', root: `${HOME}/game/code`, place: 'game/code', about: 'engine and game code' },
      team: 'DEF',
    })
    expect(await workspaceOfSpec(io, HOME, PLACES, 'game/art/z.md')).toEqual({
      error: 'No run was started. game/art/z.md lies in no workspace of a place in .claude/conductor/config.json.',
    })
    expect(await workspaceOfSpec(io, HOME, PLACES, '/elsewhere/z.md')).toEqual({
      error: 'No run was started. /elsewhere/z.md lies in no workspace of a place in .claude/conductor/config.json.',
    })
  })
})

describe('final review fixes', () => {
  test('findHome: a session in a linked git worktree finds its repository home, as before', async () => {
    const io = tree(['/code/X/.git', '/code/X/.claude/conductor', '/code/X-wt/src'])
    expect(await findHome(io, '/code/X-wt/src', '/code/X')).toEqual({ kind: 'repository', root: '/code/X' })
  })

  test('candidatesFor: a workspace inside another one is left out, since its workers\' copies would land inside the outer one', async () => {
    const io = tree([CONDUCTOR, `${HOME}/game/code/.lore`, `${LORE_WS}/.lore`, `${HOME}/studio/.git`, `${HOME}/game/art`])
    expect(await candidatesFor(io, HOME, PLACES, 'DEF')).toEqual({
      candidates: [{ kind: 'lore', root: `${HOME}/game/code`, place: 'game/code', about: 'engine and game code' }],
      left: [`${LORE_WS} lies inside the workspace ${HOME}/game/code, so its workers' copies would land inside that one`],
    })
    const submodule = tree([CONDUCTOR, `${HOME}/studio/.git`, `${HOME}/studio/vendor/lib/.git`])
    const deep = await candidatesFor(submodule, HOME, [{ folder: 'studio/vendor', teams: ['ABC'], about: 'vendored code' }], 'ABC')
    expect(deep, 'a place inside a repository, holding a submodule').toEqual({
      error: 'No run was started. studio/vendor holds no git or Lore workspace. Put the folder the work needs into Lore or git first, then give /conduct again.',
    })
  })
})
