import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { detail } from '../hooks/board'
import { loreByHand } from '../hooks/lore'
import { handover } from '../hooks/handover'
import { briefing } from '../hooks/posts'
import type { Ledger } from '../types'
import { REV_MAIN, REV_T1 } from './lore-output'
import { BASE, RUN, RUN_BRANCH, lored, task } from './lore-world'

type Ran = { text?: string; deny?: string }
const raise = ($: Engine, input: Record<string, unknown>) => ($.tool.call as unknown as (input: Record<string, unknown>) => Promise<Ran>)(input)
const bash = ($: Engine, command: string, agentId?: string) =>
  raise($, { tool: 'Bash', tool_use_id: 'bash', command, description: 'A command', ...(agentId === undefined ? {} : { agentId }) })

const WORKER = { base: 'main', runBranch: RUN_BRANCH, ownBranch: `${RUN_BRANCH}/t1`, caller: 'worker' as const }
const ORCH = { base: 'main', runBranch: RUN_BRANCH, caller: 'orchestrator' as const }

describe('a lore command by hand, in a bound Lore run', () => {
  test('a worker builds only on its own branch', () => {
    expect(loreByHand(`lore push ${RUN_BRANCH}/t2`, WORKER)).toBeDefined()
    expect(loreByHand('lore push', WORKER)).toBeUndefined()
    expect(loreByHand(`lore push ${RUN_BRANCH}/t1`, WORKER)).toBeUndefined()
    expect(loreByHand('lore --non-interactive stage --scan Source && lore commit "t1: fix" && lore push', WORKER)).toBeUndefined()
    for (const command of ['lore branch merge x', 'lore branch switch main', 'lore branch create y', 'lore sync main@LATEST', 'lore branch unprotect main', 'cd x && lore branch merge y']) {
      expect(loreByHand(command, WORKER), command).toBeDefined()
    }
  })

  test('the orchestrator only reads: the mod does the Lore writes', () => {
    for (const command of ['lore status', 'lore history --oneline 5', `lore branch info ${RUN_BRANCH}`, 'lore branch list', 'lore diff a.txt', 'lore file history Source/a.cpp', 'ls -la']) {
      expect(loreByHand(command, ORCH), command).toBeUndefined()
    }
    for (const command of ['/home/u/.local/bin/lore branch unprotect main', 'lore push', 'lore status --scan', 'lore stage --scan .', 'lore commit "x"', 'lore sync', 'FOO=1 lore branch merge y', 'lore --repository /x branch archive z']) {
      expect(loreByHand(command, ORCH), command).toBeDefined()
    }
  })
})

describe('the guard fails closed where it cannot read a command', () => {
  test('a substitution, another shell or a wrapper around lore is refused, for anyone', () => {
    for (const command of ['echo $(lore branch merge x)', 'echo `lore push`', 'bash -c "lore push x"', 'sh -c \'lore sync\'', 'eval lore push', 'env lore push x', 'sudo lore branch unprotect main', 'xargs lore push < list', 'time lore push', 'nohup lore push &']) {
      expect(loreByHand(command, WORKER), command).toBeDefined()
      expect(loreByHand(command, ORCH), command).toBeDefined()
    }
  })

  test('commands split on & and |& too, and an unknown option before the subcommand is refused', () => {
    expect(loreByHand(`lore status & lore push ${RUN_BRANCH}/t2`, WORKER)).toBeDefined()
    expect(loreByHand(`lore status |& lore push ${RUN_BRANCH}/t2`, WORKER)).toBeDefined()
    expect(loreByHand('lore --weird branch merge x', WORKER)).toBeDefined()
    expect(loreByHand('lore --non-interactive --log-level info status', ORCH)).toBeUndefined()
  })

  test('a worker may only what its own branch needs: an allowlist', () => {
    for (const command of ['lore status --scan', 'lore stage --scan Source', 'lore commit "t1: fix"', 'lore diff a.txt', 'lore lock acquire Content/A.uasset', 'lore history --oneline 3', 'lore branch info']) {
      expect(loreByHand(command, WORKER), command).toBeUndefined()
    }
    for (const command of ['lore layer add other', 'lore link add x y', `lore push --branch ${RUN_BRANCH}/t2`, `lore push --branch=${RUN_BRANCH}/t2`, `lore lock release --branch ${RUN_BRANCH}/t2`]) {
      expect(loreByHand(command, WORKER), command).toBeDefined()
    }
    expect(loreByHand('lore push', { ...WORKER, ownBranch: undefined }), 'no own branch, no push').toBeDefined()
  })

  test('quotes, backslashes and brackets do not hide lore, nor does an interpreter or a variable', () => {
    for (const command of ['l\\ore push x', '"lo""re" push x', "'lore' push x", '(lore push x)', '{ lore push x; }', 'python3 -c "import os; os.system(\'lore push x\')"', 'perl -e "system(q(lore push x))"', 'node -e "require(\'child_process\').execSync(\'lore push x\')"', 'L=lore; $L push x', 'L=lore; "$L" push x']) {
      expect(loreByHand(command, WORKER), command).toBeDefined()
    }
    expect(loreByHand('python3 tools/report.py', WORKER), 'an interpreter with no lore in the line is no lore command').toBeUndefined()
  })

  test('lore anywhere outside a lore invocation is refused, and so is a program named only by variables', () => {
    for (const command of ['env python3 -c "import os; os.system(\'lore push x\')"', 'python3.11 -c "os.system(\'lore push x\')"', 'env -i PATH=/bin lore push x', 'L=lo; R=re; $L$R push x', '${L}${R} push x']) {
      expect(loreByHand(command, WORKER), command).toBeDefined()
    }
    for (const command of ['cat Docs/lore-notes.md', './Script/build.sh --fast', '/Users/me/bin/build.sh', 'lore commit "update the lore docs"', '{ lore status; }', 'lore status 2>/dev/null']) {
      expect(loreByHand(command, WORKER), command).toBeUndefined()
    }
  })

  test('lore in any case is lore (APFS is case-insensitive), and a program the shell works out is refused', () => {
    for (const command of ['LORE push x', 'Lore branch merge y', '/Users/me/.local/bin/LoRe push x', '"$HOME/bin/build.sh" --fast', '/usr/*/bin/lore push x', '~/.local/bin/lo?e push x', '/bin/{lore,true} push x', '/bin/lor{e..e} push x', '{lore,} push x', '! lore push x', 'if lore push x; then true; fi', 'while lore push x; do break; done', '2>/dev/null lore push x', '> out lore push x', 'FOO=1 2>&1 lore push x', '2>/dev/null $L$R push x', '! $L push x', 'if $L push x; then true; fi', '{lo,}re push x', '(lo{r,}e push x)']) {
      expect(loreByHand(command, WORKER), command).toBeDefined()
    }
  })

  test('--scan= is a scan', () => {
    expect(loreByHand('lore status --scan=true', ORCH)).toBeDefined()
  })
})

describe('the guard reads options the way lore does (security review after the merge)', () => {
  const OWN = { ...WORKER, ownWorkspace: '/work/Big Game 5.8.conductor/ABC-12/t1' }

  test('an option and its value between subcommand words do not hide the command', () => {
    for (const command of ['lore branch --log-level info merge x', 'lore branch --repository info merge x', 'lore branch --id x merge y', 'lore file --weird history a.txt']) {
      expect(loreByHand(command, ORCH), command).toBeDefined()
    }
    expect(loreByHand('lore branch --log-level info merge x', OWN)).toBeDefined()
    expect(loreByHand('lore branch info --remote main', ORCH), 'an option after the command words is fine').toBeUndefined()
    expect(loreByHand('lore status --repository /x', ORCH), 'a read stays a read').toBeUndefined()
  })

  test("a worker's lore runs in its own workspace only", () => {
    for (const command of ['lore --repository /work/Big\\ Game\\ 5.8 commit x', `lore --repository=/elsewhere push`, 'cd /work/Big\\ Game\\ 5.8 && lore commit x', 'pushd /tmp; lore push', 'lore commit x --repository /elsewhere']) {
      expect(loreByHand(command, OWN), command).toBeDefined()
    }
    expect(loreByHand(`lore --repository "${OWN.ownWorkspace}" commit x`, OWN), 'its own workspace, named').toBeUndefined()
    expect(loreByHand('lore commit "t1: fix" && lore push', OWN)).toBeUndefined()
  })
})

describe('what a Lore run is told', () => {
  const RUNNING: Ledger = {
    ...RUN,
    run: { ...RUN.run, config: { lore: { lockPatterns: ['*.uasset', '*.umap'] } }, lore: { ...RUN.run.lore!, workspace: `${BASE}/ABC-12/_run`, baseAt: REV_MAIN } },
    tasks: [task('t1', { status: 'building', branch: `${RUN_BRANCH}/t1`, workspace: `${BASE}/ABC-12/t1`, agentId: 'a1', worker: 't1' }), task('t2', { status: 'green', branch: `${RUN_BRANCH}/t2`, revision: REV_T1 })],
  }

  test("a worker's brief names its branch, its lore commands and its locks", () => {
    const brief = briefing(RUNNING, RUNNING.tasks[0]!)
    expect(brief).toContain(`your branch ${RUN_BRANCH}/t1`)
    expect(brief).toContain('lore stage --scan')
    expect(brief).toContain('lore push')
    expect(brief).toContain('revision')
    expect(brief).toContain('lore lock acquire')
    expect(brief).toContain('*.uasset, *.umap')
    expect(brief).not.toContain('pull request')
  })

  test('the orchestrator in a Lore run is told the Lore rules and nothing of pull requests', async ($, on) => {
    await lored($, on, RUNNING)
    const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
    const text = (composed as { sections: { id: string; text: string }[] }).sections.find(one => one.id === 'conductor:run')?.text ?? ''
    expect(text).toContain('/approve-main')
    expect(text).toContain('run_sync_base')
    expect(text).toContain(RUN_BRANCH)
    expect(text).not.toContain('pull request')
    expect(text).not.toContain('git status')
  })

  test('a helper the board knows of no task gets the read-only rules, not a worker\'s', async ($, on) => {
    await lored($, on, RUNNING)
    expect((await bash($, 'lore push', 'helper-9')).deny).toContain('/approve-main')
    expect((await bash($, 'echo lorem ipsum')).deny, 'a word that only contains lore is no lore command').toBeUndefined()
  })

  test('a by-hand lore merge is refused in a bound session, and a worker pushing another branch too', async ($, on) => {
    await lored($, on, RUNNING)

    expect((await bash($, 'lore branch merge x')).deny).toContain('/approve-main')
    expect((await bash($, `lore push ${RUN_BRANCH}/t2`, 'a1')).deny).toContain(`${RUN_BRANCH}/t1`)
    expect((await bash($, 'lore status')).deny).toBeUndefined()
  })

  test('the board shows a Lore task by its revision and its check', () => {
    const row = { ...RUNNING.tasks[1]!, waitsFor: [], check: { revision: REV_T1, verdict: 'running' as const, at: '2026-10-09T10:00:00.000Z' } }
    const line = detail(row as never)
    expect(line).toContain(`rev ${REV_T1.slice(0, 7)}`)
    expect(line).toContain('check running')
  })
})

describe('found in the live run', () => {
  const LORE_RUN: Ledger = { ...RUN, run: { ...RUN.run, lore: { ...RUN.run.lore!, workspace: `${BASE}/ABC-12/_run`, baseAt: REV_MAIN, head: REV_MAIN } } }

  test('the handover of a Lore run tells how Lore merges, never /merged', () => {
    const text = handover(LORE_RUN, { at: '2026-10-09T10:30:00.000Z', isElsewhere: true })
    expect(text).toContain('mcp__conductor__merge')
    expect(text).toContain('/approve-main')
    expect(text).not.toContain('/merged')
  })

  test('/merged is refused in a Lore run: its tasks merge through the board', async ($, on) => {
    const { files } = await lored($, on, { ...LORE_RUN, tasks: [task('t1', { status: 'green', branch: `${RUN_BRANCH}/t1`, revision: REV_T1 })] })

    const said = await $.command.run({ command: 'merged', args: 't1', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(said.text).toContain('mcp__conductor__merge')
    expect(JSON.parse(files['/work/Big Game 5.8/.claude/conductor/runs/ABC-12/ledger.json']?.text ?? '{}').tasks[0].status).toBe('green')
  })

  test('the Lore rules say workers need isolation "worktree" and push their own branches', async ($, on) => {
    await lored($, on, LORE_RUN)
    const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
    const text = (composed as { sections: { id: string; text: string }[] }).sections.find(one => one.id === 'conductor:run')?.text ?? ''
    expect(text).toContain('always with isolation: "worktree"')
    expect(text).toContain('Each worker commits and pushes its own branch itself')
  })
})
