import { describe, expect, test } from 'claude-code/testing'

import { branchInfoOf, ignoreRules, isIgnored, mergeOf, pushOf, repositoryInfoOf, REVISION, statusOf } from '../hooks/lore'
import {
  BRANCH_INFO_MAIN_UNSYNCED,
  BRANCH_INFO_NEW,
  BRANCH_INFO_PUSHED,
  MERGE_CLEAN,
  MERGE_CONFLICT,
  MERGE_INTO_DONE,
  MERGE_INTO_PROTECTED,
  PUSH_DIVERGED,
  PUSH_FIRST,
  PUSH_NEW_EMPTY,
  PUSH_NOTHING,
  PUSH_PROTECTED,
  REPOSITORY_INFO,
  REV_MAIN,
  REV_ON_MAIN,
  REV_RUN,
  REV_T1,
  REV_T2,
  STATUS_CLEAN,
  STATUS_MERGING,
  STATUS_UNTRACKED,
} from './lore-output'

describe('Lore output', () => {
  test('branch info reads remote latest and parents; zeros are no revision', () => {
    expect(branchInfoOf(BRANCH_INFO_PUSHED)).toEqual({
      name: 'conductor/S-1-spike/t1',
      id: '01a1b056ff7174b1841d5932e6e467f1',
      latest: REV_T1,
      remoteLatest: REV_T1,
      parents: [
        { branch: 'conductor/S-1-spike', revision: REV_MAIN },
        { branch: 'main', revision: REV_MAIN },
      ],
    })
    expect(branchInfoOf(BRANCH_INFO_MAIN_UNSYNCED)?.latest).toBeUndefined()
    expect(branchInfoOf(BRANCH_INFO_MAIN_UNSYNCED)?.remoteLatest).toBe(REV_ON_MAIN)
    expect(branchInfoOf(BRANCH_INFO_NEW)?.remoteLatest).toBeUndefined()
    expect(branchInfoOf('error: no such branch')).toBeUndefined()
  })

  test('a conflicted merge is a conflict although lore exits 0', () => {
    expect(mergeOf(0, MERGE_CONFLICT)).toEqual({ kind: 'conflict', files: ['a.txt'] })
    expect(mergeOf(0, MERGE_CLEAN), 'with the revision it took in').toEqual({ kind: 'merged', revision: REV_RUN, source: REV_T1 })
    expect(mergeOf(0, MERGE_INTO_DONE)).toEqual({ kind: 'merged', revision: REV_ON_MAIN })
    const refused = mergeOf(17, MERGE_INTO_PROTECTED)
    expect(refused.kind).toBe('failed')
    expect(refused.kind === 'failed' && refused.reason).toContain('Not authorized')
    expect(mergeOf(0, 'something unexpected').kind, 'no revision read is no merge').toBe('failed')
  })

  test('push outcomes', () => {
    expect(pushOf(0, PUSH_FIRST)).toEqual({ kind: 'pushed', revision: REV_T1 })
    expect(pushOf(0, PUSH_NOTHING)).toEqual({ kind: 'unchanged' })
    expect(pushOf(0, PUSH_NEW_EMPTY), 'a new branch with no commit is made on the server where it was cut').toEqual({ kind: 'pushed', revision: REV_MAIN })
    expect(pushOf(17, PUSH_PROTECTED)).toMatchObject({ kind: 'refused', reason: 'protected' })
    expect(pushOf(255, PUSH_DIVERGED)).toMatchObject({ kind: 'refused', reason: 'diverged' })
    expect(pushOf(1, 'boom')).toMatchObject({ kind: 'refused', reason: 'other', text: 'boom' })
  })

  test('status: in sync, untracked, pending merge with conflicts', () => {
    expect(statusOf(STATUS_CLEAN)).toEqual({
      branch: 'conductor/S-1-spike/t1',
      revision: REV_T1,
      isInSync: true,
      untracked: [],
      changed: [],
      conflicts: [],
      isClean: true,
    })
    expect(statusOf(STATUS_UNTRACKED)).toMatchObject({ revision: REV_RUN, untracked: ['untracked.txt'], isClean: false })
    expect(statusOf(STATUS_MERGING)).toMatchObject({ pendingMerge: REV_T2, changed: ['dir/c.txt'], conflicts: ['a.txt'], isClean: false })
    expect(statusOf('nothing here')).toBeUndefined()
  })

  test('repository info gives name, remote and default branch', () => {
    expect(repositoryInfoOf(REPOSITORY_INFO)).toEqual({
      name: 'conductor-spike',
      remote: 'lores://lore.example.test:41337',
      defaultBranch: 'main',
    })
  })

  test('a revision is 64 lowercase hex', () => {
    expect(REVISION.test(REV_T1)).toBe(true)
    expect(REVISION.test(REV_T1.slice(0, 40))).toBe(false)
  })
})

describe('ignore rules', () => {
  test('ignore rules follow gitignore: anchors, directories, negation after the rule', () => {
    const rules = ignoreRules('/Saved/\n**/Intermediate/\n*.log\n!change.log\n.DS_Store\nPlugins/**/Binaries/Mac/\n')
    expect(isIgnored(rules, 'Saved', true)).toBe(true)
    expect(isIgnored(rules, 'Plugins/X/Saved', true)).toBe(false)
    expect(isIgnored(rules, 'Plugins/X/Intermediate', true)).toBe(true)
    expect(isIgnored(rules, 'Source/INTERMEDIATE', false)).toBe(false)
    expect(isIgnored(rules, 'Docs/change.log', false)).toBe(false)
    expect(isIgnored(rules, 'Logs/run.log', false)).toBe(true)
    expect(isIgnored(rules, 'Plugins/A/B/Binaries/Mac', true)).toBe(true)
    expect(isIgnored(rules, 'Saved/Config/Mac/Game.ini', false)).toBe(true)
  })

  test('a directory-only rule does not match a file, and comments and blanks are skipped', () => {
    const rules = ignoreRules('# build output\n\n/Binaries/\n.DS_Store\n')
    expect(isIgnored(rules, 'Binaries', false)).toBe(false)
    expect(isIgnored(rules, 'Binaries', true)).toBe(true)
    expect(isIgnored(rules, 'Content/.DS_Store', true), 'a rule without a slash matches a directory too').toBe(true)
  })

  test('an anchored rule with an inner slash matches from the root only', () => {
    const rules = ignoreRules('Config/Local*.ini\nfoo/?ar/[ab].txt\n')
    expect(isIgnored(rules, 'Config/LocalSecrets.ini', false)).toBe(true)
    expect(isIgnored(rules, 'Plugins/Config/LocalSecrets.ini', false)).toBe(false)
    expect(isIgnored(rules, 'foo/bar/a.txt', false)).toBe(true)
    expect(isIgnored(rules, 'foo/bar/c.txt', false)).toBe(false)
  })
})
