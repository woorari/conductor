import { describe, expect, test } from 'claude-code/testing'

import { ignoreRules } from '../hooks/lore'
import { relative } from '../hooks/posts'
import { removals, runWorkspaceOf, taskBranchOf, topLevel, workspaceOf, workspacesOf } from '../hooks/workspace'

const RULES = ignoreRules('/Binaries/\n/Intermediate/\n/Saved/\n/DerivedDataCache/\n**/Intermediate/\n*.log\n!change.log\n.DS_Store\n.claude/conductor/runs/\n')

describe('where a run works', () => {
  test('workspaces sit beside the owner\'s workspace, never in it', () => {
    expect(workspacesOf('/work/Big Game 5.8')).toBe('/work/Big Game 5.8.conductor')
    expect(workspacesOf('/work/Big Game 5.8', '/scratch/ws/')).toBe('/scratch/ws')
    expect(workspaceOf('/work/Big Game 5.8.conductor', 'ABC-12', 't1')).toBe('/work/Big Game 5.8.conductor/ABC-12/t1')
    expect(runWorkspaceOf('/work/Big Game 5.8.conductor', 'ABC-12')).toBe('/work/Big Game 5.8.conductor/ABC-12/_run')
    expect(taskBranchOf('conductor/ABC-12-x', 't1')).toBe('conductor/ABC-12-x/t1')
  })
})

describe('what a worker\'s copy holds', () => {
  const entries = [
    { name: '.lore', isDir: true },
    { name: '.loreignore', isDir: false },
    { name: 'Binaries', isDir: true },
    { name: 'Content', isDir: true },
    { name: 'Intermediate', isDir: true },
    { name: 'Saved', isDir: true },
    { name: 'Source', isDir: true },
    { name: 'Game.uproject', isDir: false },
  ]

  test('Saved is never copied; carried folders are', () => {
    expect(topLevel(entries, RULES, [])).toEqual(['.lore', '.loreignore', 'Content', 'Source', 'Game.uproject'])
    expect(topLevel(entries, RULES, ['Intermediate', 'Binaries'])).toEqual(['.lore', '.loreignore', 'Binaries', 'Content', 'Intermediate', 'Source', 'Game.uproject'])
  })

  test('nested ignored paths come out of the copy, the outermost once, and an exception stays', () => {
    const listing = [
      '.claude/',
      '.claude/conductor/',
      '.claude/conductor/runs/',
      '.claude/conductor/runs/ABC-12/',
      '.claude/conductor/runs/ABC-12/ledger.json',
      'Docs/',
      'Docs/change.log',
      'Docs/run.log',
      'Plugins/',
      'Plugins/X/',
      'Plugins/X/Intermediate/',
      'Plugins/X/Intermediate/Build/',
      'Plugins/X/Intermediate/Build/a.o',
      'Source/',
      'Source/a.cpp',
      'Content/.DS_Store',
    ].join('\n')
    expect(removals(listing, RULES, [])).toEqual(['.claude/conductor/runs', 'Content/.DS_Store', 'Docs/run.log', 'Plugins/X/Intermediate'])
    expect(removals(listing, RULES, ['Plugins/X/Intermediate']), 'a carried folder stays, and what is in it').toEqual(['.claude/conductor/runs', 'Content/.DS_Store', 'Docs/run.log'])
  })
})

describe('what a Lore worker changes, as the board compares it', () => {
  test('a path in the worker\'s own workspace is relative to that workspace', () => {
    const ws = '/work/Big Game 5.8.conductor/ABC-12/t1'
    expect(relative(`${ws}/Source/t1.cpp`, '/work/Big Game 5.8', ws)).toBe('Source/t1.cpp')
    expect(relative('/work/Big Game 5.8/Source/t1.cpp', '/work/Big Game 5.8', ws), 'the owner\'s path still reads').toBe('Source/t1.cpp')
    expect(relative('/repo/.claude/worktrees/agent-7f/api/x.py', '/repo'), 'git as before').toBe('api/x.py')
  })
})
