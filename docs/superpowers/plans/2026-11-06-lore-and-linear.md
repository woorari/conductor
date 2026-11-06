# Lore and Linear in conductor: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** conductor works in a Lore workspace and takes tickets from Linear: worker workspaces from copy-on-write copies, task branches merged into a run branch by the mod, and the run branch merged into the protected base branch only on the owner's `/approve-main`.

**Architecture:** Everything new that is pure lives in four new modules: `hooks/lore.ts` (Lore output parsers, ignore rules, by-hand guard), `hooks/workspace.ts` (branch names, paths, copy plan), `hooks/project.ts` (per-project config), `hooks/linear.ts` (GraphQL documents and parsers), plus `hooks/lore-merge.ts` (ledger edits for Lore merges). `hooks/register.tsx` stays the only file that touches `$`. It gains a backend (`git` or `lore`), a `lore()` runner, a `linear()` caller, the workspace preparation in `agent.spawn` with a `classic.WorktreeCreate` answer, the Lore merge paths and `/approve-main`. The git and GitHub paths keep their code and their tests.

**Tech Stack:** TypeScript hooks module on Claude Code's mod API (2.1.317/2.1.318), tests on `claude-code/testing` run by `claude plugin test .`, Lore CLI 0.12, Linear GraphQL API.

**Spec:** `docs/superpowers/specs/2026-11-06-lore-and-linear-design.md` (approved 2026-11-06; section 7 holds the spike findings). Real Lore output for fixtures: `docs/superpowers/plans/2026-11-06-lore-outputs.txt`.

## Global Constraints

- The existing 381 tests pass unchanged. `tests/home.test.ts` asserts the exact registered list (18). So new tools and commands are registered only when the backend or the project config asks for them (Tasks 5 and 9), never in a plain git session.
- `$` is passed only to functions in `hooks/register.tsx`. Every other file under `hooks/` is pure (README, "Developing").
- The mod's own tools are matched by pattern (`/^mcp__conductor__ticket_read$/`), never by a string literal.
- The ledger stays `version: 1`. Every new field is optional. A ledger written before this change reads.
- Every Lore call is `[bin, '--non-interactive', ...args]` through `$.process.run` with an explicit `cwd`. No shell string is ever built from a path, a branch name, a message or config. Where a shell is unavoidable (redirecting `find`, the detached check), values travel as positional parameters (`['/bin/sh', '-c', SCRIPT, 'sh', ...values]`).
- Paths may contain spaces (the first real workspace is `.../Ultracore 5.8`).
- `$.process.run` timeouts: 30 s by default, 10 min (600 000 ms) for a copy, a merge, a push or a find. Never more: that is the engine's ceiling.
- The mod never writes into the owner's workspace. No Lore write command runs with `cwd` = the session root, and no `$.fs.write` goes under the root except `.claude/conductor/runs/`.
- The Linear key goes into a request's `Authorization` header and nowhere else: not the ledger, a message, a toast, a problem, a log line.
- No private names anywhere in the repository: code, tests, fixtures, docs. Use `lore.example.test`, team `ABC`, `/work/...` paths.
- Wording follows the existing texts: plain sentences, "Run board:" prefixes for tool descriptions, refusals starting with "Not done." where the existing tools do.

## Review Focus

1. **A workspace root with a space in its path.** Every copy, find, remove and Lore call must work with `/work/Big Game 5.8`. Pinned by Task 6's test "workspace paths with spaces travel as single arguments".
2. **Lore missing from the host program's PATH.** The desktop app may not see `~/.local/bin`. Expect the fallback to `$HOME/.local/bin/lore`, and a refusal that names `lore.bin` when neither runs. Pinned by Task 2's test "lore is found in HOME/.local/bin when PATH lacks it".
3. **Two workers started in one message.** Each gets its own workspace on its own branch, and neither gets the other's path. Pinned by Task 6's test "two starts in one message get one workspace each".
4. **A failure halfway through a merge into the base.** The server times out, or `merge into` fails. The base branch must end up protected again, and the claim must be settled or released, never left as "merging" for good. Pinned by Task 9's test "the base is protected again when merge into fails".
5. **Too little disk, or a copy that fails halfway.** The start is denied with the reason, the half-made workspace is removed, and the task's reservation is released. Pinned by Task 6's test "a failed copy releases the task and leaves no half workspace".

---

### Task 1: Lore output parsers and ignore rules (pure)

**Files:**
- Create: `hooks/lore.ts`
- Create: `tests/lore-output.ts` (fixtures: each block of `docs/superpowers/plans/2026-11-06-lore-outputs.txt` as an exported string constant, names like `BRANCH_INFO_PUSHED`, `MERGE_CONFLICT`, `PUSH_PROTECTED`)
- Test: `tests/lore.test.ts`

**Interfaces:**
- Produces:
  - `REVISION = /^[0-9a-f]{64}$/`
  - `branchInfoOf(out: string): BranchInfo | undefined`, where `BranchInfo = { name: string; id: string; latest?: string; remoteLatest?: string; parents: { branch: string; revision: string }[] }`. A field reading 64 zeros is left undefined.
  - `repositoryInfoOf(out: string): RepositoryInfo | undefined`, where `RepositoryInfo = { name: string; remote: string; defaultBranch: string }`. `remote` is the `Remote URL` line; the clone URL is `${remote}/${name}`.
  - `statusOf(out: string): LoreStatus | undefined`, where `LoreStatus = { branch: string; revision: string; isInSync: boolean; untracked: string[]; changed: string[]; conflicts: string[]; pendingMerge?: string; isClean: boolean }`.
  - `mergeOf(exitCode: number, out: string): MergeOutcome`, where `MergeOutcome = { kind: 'merged'; revision: string } | { kind: 'conflict'; files: string[] } | { kind: 'failed'; reason: string }`. It reads both `branch merge` ("Committed merged repository state N -> <sig>") and `branch merge into` ("Signature : <sig>").
  - `pushOf(exitCode: number, out: string): PushOutcome`, where `PushOutcome = { kind: 'pushed'; revision: string } | { kind: 'unchanged' } | { kind: 'refused'; reason: 'protected' | 'diverged' | 'other'; text: string }`.
  - `ignoreRules(text: string): IgnoreRule[]`
  - `isIgnored(rules: readonly IgnoreRule[], path: string, isDir: boolean): boolean`. Gitignore semantics: comments, blank lines, `!` negation, trailing `/` for directories only, a leading or inner `/` anchors to the root, `**`, `*`, `?`, `[...]`. The last matching rule wins, and a path under an ignored directory is ignored.

- [ ] **Step 1: Write the failing tests** in `tests/lore.test.ts`:

```ts
test('branch info reads remote latest and parents; zeros are no revision', () => {
  expect(branchInfoOf(BRANCH_INFO_PUSHED)).toEqual({ name: 'conductor/S-1-spike/t1', id: '01a1b056ff7174b1841d5932e6e467f1',
    latest: '53f36f46…aaa', remoteLatest: '53f36f46…aaa',
    parents: [{ branch: 'conductor/S-1-spike', revision: 'cc156281…4efd' }, { branch: 'main', revision: 'cc156281…4efd' }] })
  expect(branchInfoOf(BRANCH_INFO_MAIN_UNSYNCED)?.latest).toBeUndefined()
  expect(branchInfoOf(BRANCH_INFO_NEW)?.remoteLatest).toBeUndefined()
})
test('a conflicted merge is a conflict although lore exits 0', () => {
  expect(mergeOf(0, MERGE_CONFLICT)).toEqual({ kind: 'conflict', files: ['a.txt'] })
  expect(mergeOf(0, MERGE_CLEAN)).toEqual({ kind: 'merged', revision: '33bd575b…e22f' })
  expect(mergeOf(0, MERGE_INTO_DONE)).toEqual({ kind: 'merged', revision: 'f8e27cef…3e68' })
  expect(mergeOf(17, MERGE_INTO_PROTECTED).kind).toBe('failed')
})
test('push outcomes', () => {
  expect(pushOf(0, PUSH_FIRST)).toEqual({ kind: 'pushed', revision: '53f36f46…aaa' })
  expect(pushOf(0, PUSH_NOTHING)).toEqual({ kind: 'unchanged' })
  expect(pushOf(17, PUSH_PROTECTED)).toMatchObject({ kind: 'refused', reason: 'protected' })
  expect(pushOf(255, PUSH_DIVERGED)).toMatchObject({ kind: 'refused', reason: 'diverged' })
})
test('status: in sync, untracked, pending merge with conflicts', () => {
  expect(statusOf(STATUS_CLEAN)).toMatchObject({ branch: 'conductor/S-1-spike/t1', isInSync: true, isClean: true })
  expect(statusOf(STATUS_UNTRACKED)).toMatchObject({ untracked: ['untracked.txt'], isClean: false })
  expect(statusOf(STATUS_MERGING)).toMatchObject({ pendingMerge: '7dc1ead2…c8f3', conflicts: ['a.txt'], isClean: false })
})
test('repository info gives name, remote and default branch', () => {
  expect(repositoryInfoOf(REPOSITORY_INFO)).toEqual({ name: 'conductor-spike', remote: 'lores://lore.example.test:41337', defaultBranch: 'main' })
})
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
```

Write the full 64-hex values from the outputs file where the sketch shortens them with `…`.

- [ ] **Step 2: Run the tests to make sure they fail.** Run `claude plugin test .`. Expected: `tests/lore.test.ts` fails (module not found), and the other 381 pass.
- [ ] **Step 3: Implement `hooks/lore.ts`** with the exports above. The parsers are line-based and tolerant: unknown lines are skipped, and a missing required line answers `undefined`.
- [ ] **Step 4: Run the tests.** Run `claude plugin test .`. Expected: all pass.
- [ ] **Step 5: Commit.** `git add hooks/lore.ts tests/lore.test.ts tests/lore-output.ts && git commit -m "lore: output parsers and ignore rules"`

### Task 2: Backend detection and the pretend Lore

**Files:**
- Modify: `hooks/register.tsx`. Module state near `root`/`origin` (L131-216), `boundLedger` (L316-322), `rebind` (L367), `refresh` (L1200), `isHome` (L1289-1297), `/conduct` root (L1857-1858).
- Modify: `tests/world.ts`. Add `World.lore` (below) to the `process.run` handler (L228-236): it records `{ argv, cwd }` in `World.loreCalls` before the 127 default. Add `World.dirs: string[]` so that `fs.exists` answers true for listed directories. Answer `session.cwd` with `World.cwd`.
- Test: `tests/lore-backend.test.ts`

**Interfaces:**
- Consumes: `repositoryInfoOf` (Task 1).
- Produces, in register.tsx:
  - `type Backend = { kind: 'git'; root: string; remote: string | null } | { kind: 'lore'; root: string; remote: string; repository: string; defaultBranch: string; bin: string }`
  - `backendOf($): Promise<Backend | null>`: git first through `$.session.repo()`. Otherwise it walks up from `$.session.cwd()` to the first folder with `.lore`, then runs `repository info` there. Cached like `root`.
  - `lore($, args: string[], cwd: string, timeoutMs?: number): Promise<{ exitCode: number; stdout: string; stderr: string }>`. It never throws: a rejection becomes `exitCode: 1` with the error's message in `stderr`.
  - `loreBin($): Promise<string | undefined>`: `config.lore.bin`, else `lore` if `lore --version` exits 0, else `${HOME}/.local/bin/lore` if that runs.
  - `root` keeps its meaning (the backend's root), so `isHome`, `ledgerPath` and every reader work unchanged.
- Produces, in tests/world.ts: `World.lore: Array<{ match: (argv: string[], cwd?: string) => boolean; answer: { exitCode: number; stdout: string; stderr?: string } }>`, `World.loreCalls: { argv: string[]; cwd?: string }[]`, `World.dirs`, `World.cwd`.

- [ ] **Step 1: Write the failing tests** in `tests/lore-backend.test.ts`:
  - "the mod switches on in a Lore workspace with .claude/conductor": `world(on, files, null)` with `dirs: ['/work/Big Game 5.8/.lore', '/work/Big Game 5.8/.claude/conductor']` and `cwd: '/work/Big Game 5.8/Source'`. After `start($)`, `engine.registered` holds `/board` and `/conduct`, and one `loreCalls` entry is `['lore', '--non-interactive', 'repository', 'info']` with `cwd: '/work/Big Game 5.8'`.
  - "a Lore workspace without .claude/conductor stays off": nothing is registered.
  - "lore is found in HOME/.local/bin when PATH lacks it": `lore --version` answers 127 and `/home/u/.local/bin/lore --version` answers 0 (with `env.HOME = '/home/u'`). The later calls use `/home/u/.local/bin/lore`.
  - "with lore not running at all, /conduct says to set lore.bin": the text contains `lore.bin` and `.claude/conductor/config.json`.
  - "a git repository is unchanged": `world(on, files)` (the default git repo) shows no `loreCalls`.
- [ ] **Step 2: Run the tests to make sure they fail.** Run `claude plugin test .`. Expected: the new file fails, and the rest pass.
- [ ] **Step 3: Implement** `backendOf`, `lore`, `loreBin` and the cached backend. Replace the five `(await $.session.repo())?.root` reads with `(await backendOf($))?.root`. Keep the "not inside a git repository" texts for when there's no backend at all, worded as "not inside a git repository or a Lore workspace".
- [ ] **Step 4: Run the tests.** Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -am "lore: find the workspace, run lore, pretend lore in tests"` (add the new test file first).

### Task 3: Ledger fields for Lore, Linear and the frozen config

**Files:**
- Modify: `types/index.d.ts` (Task L28-75, Merge L81-94, Ledger L164-207)
- Modify: `hooks/ledger.ts` (`task()` L185-212, `merge()` L223-249, run fields L~371-381, `check()` L~298-345)
- Modify: `hooks/signals.ts` (`addTask` L375-394, `updateTask` L413-481, `assignProblem` L597-629)
- Modify: `hooks/register.tsx` tool schemas (`task_update` L1323-1343, `task_add` L1344-1364, `problem_assign` L1511-1527)
- Modify: `hooks/merge.ts` (`Flight`, `flightsOf` L230-243)
- Test: `tests/lore-ledger.test.ts`

**Interfaces:**
- Produces, as types:
  - `Ticket = number | string`. A string must match `LINEAR_KEY` (Task 5's regex; define it here in `hooks/ledger.ts` and re-export it from `hooks/linear.ts`).
  - `Task.ticket?: Ticket`
  - `Task.revision?: string` (64 hex)
  - `Task.workspace?: string`
  - `Task.check?: CheckRecord`, where `CheckRecord = { revision: string; verdict: 'running' | 'passed' | 'failed'; at: string; line?: string }`
  - `Ledger.run.tickets?: 'github' | 'linear'`
  - `Ledger.run.issue?: string` (the run's Linear issue)
  - `Ledger.run.config?: ProjectConfig` (Task 4's type, stored as given)
  - `Ledger.run.lore?: { remote: string; repository: string; base: string; branch: string; workspace?: string; baseAt?: string }`
  - `Ledger.run.approval?: { revision: string; base: string; at: string }`
  - `Ledger.run.merged?: { revision: string; at: string }`
  - `Ledger.run.check?: CheckRecord`
  - `Merge.pr?: number` (it was required), plus `Merge.revision?: string` and `Merge.target?: 'run' | 'base'`. A merge record needs either `pr`, or `revision` and `target`.
  - `Flight = { run: string; task: string; pr?: number; revision?: string; startedAt: string }`

- [ ] **Step 1: Write the failing tests** in `tests/lore-ledger.test.ts`:
  - "a ledger from before this change still reads": the `LEDGER` fixture reads unchanged.
  - "a Linear key is a ticket, a lowercase or malformed key is not": `ticket: 'ABC-12'` reads; `'abc-12'`, `'ABC-0'` and `'ABC'` are refused with `tasks[0].ticket: expected a whole number from 1 or an issue key like ABC-12`.
  - "a revision is 64 hex": `revision: 'f'.repeat(64)` reads; `'f'.repeat(40)` is refused.
  - "a Lore merge claim needs revision and target": `{ task, revision, target: 'run', state: 'merging', startedAt }` reads; without `target` it is refused; GitHub's `{ pr: 548, head, … }` still reads.
  - "task_add and task_update take a Linear key": through `call($, 'task_add', { …, ticket: 'ABC-12' })` the stored task has `ticket: 'ABC-12'`. `problem_assign` with `ticket: 'ABC-12'` finds the task carrying it, and its text reads `ticket ABC-12` (no `#`).
  - "the schemas take an integer or a key": `engine.schemas` for `task_add.ticket` is `{ anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$' }] }`.
- [ ] **Step 2: Run the tests to make sure they fail.**
- [ ] **Step 3: Implement.** Add `optionalTicket`, `optionalRevision`, the run and merge readers, and the cross-check that `merge.task` names a task (it exists already). In signals.ts, validate tickets with one shared `ticketError(value): string | undefined`. `#N` is printed only for numbers.
- [ ] **Step 4: Run the tests.** Expected: all pass, the 381 included. A refusal text an old test asserts must not change for numbers.
- [ ] **Step 5: Commit.** `git commit -am "ledger: Linear keys, Lore revisions, run config, approval and Lore merge claims"`

### Task 4: Project config and `/conduct` in a Lore workspace

**Files:**
- Create: `hooks/project.ts`
- Modify: `hooks/plan.ts` (`issueOf` L~28, `conducting` L53, `CONDUCT_USAGE` L16, `newRun` L82)
- Modify: `hooks/register.tsx`, the `/conduct` hook (L1852-1883)
- Test: `tests/project.test.ts`, `tests/lore-conduct.test.ts`

**Interfaces:**
- Consumes: `isIgnored`, `ignoreRules` (Task 1); `LINEAR_KEY` (Task 3); `backendOf` (Task 2).
- Produces in `hooks/project.ts`:
  - `CONFIG_PATH = '.claude/conductor/config.json'`
  - `ProjectConfig = { tickets?: 'github' | 'linear'; linear?: { team?: string }; lore?: { bin?: string; branchPrefix?: string; workspaces?: string; carry?: string[]; minFreeGB?: number; lockPatterns?: string[] }; check?: { argv: string[]; timeoutMin: number } }`
  - `parseConfig(text: string | undefined): { config: ProjectConfig } | { error: string }`. A missing file is `{ config: {} }`. An unknown key is an error naming it. `check.argv` must be a non-empty list of strings. `timeoutMin` runs from 1 to 240. `workspaces` must be absolute.
  - `LORE_DEFAULTS = { branchPrefix: 'conductor/', minFreeGB: 20, carry: [] as string[] }`
  - `hasPlaceholder(settings: readonly (string | undefined)[]): boolean`: true when any of `.claude/settings.json` or `.claude/settings.local.json` declares a `hooks.WorktreeCreate` command hook.
  - `PLACEHOLDER_SNIPPET: string`: the JSON the README shows. Its command prints "Worker workspaces here are made by the conductor mod. Install or enable conductor." to stderr and exits 1.
  - `runsIgnored(loreignore: string | undefined): boolean`: `isIgnored(rules, '.claude/conductor/runs/x/ledger.json', false)`.
- Produces in `hooks/plan.ts`: `Conducting.kind` gains `'linear'`. `conducting('ABC-12 …')` and `conducting('https://linear.app/team/issue/ABC-12/some-title')` give `{ id: 'ABC-12', source: 'ABC-12', kind: 'linear' }`. `newRun(id, source, at, title?, more?: { tickets?; config?; lore? })`.

- [ ] **Step 1: Write the failing tests.** In `tests/project.test.ts`: parse defaults, unknown key, bad `check`, relative `workspaces`, placeholder present or absent, runs ignored or not. In `tests/lore-conduct.test.ts`, in a Lore world from Task 2:
  - "/conduct refuses until the runs folder is ignored": no `.loreignore` → the text names `.claude/conductor/runs/` and `.loreignore`, and no ledger is written.
  - "/conduct refuses until the WorktreeCreate placeholder is configured": the text contains `PLACEHOLDER_SNIPPET`.
  - "/conduct ABC-12 starts a Linear run with the config frozen": the stored ledger has `run.source === 'ABC-12'`, `run.tickets === 'linear'`, `run.config` deep-equal to the parsed config, and `run.lore` equal to `{ remote: 'lores://lore.example.test:41337', repository: 'conductor-spike', base: 'main', branch: 'conductor/ABC-12-retry-the-flaky-upload' }` for `/conduct ABC-12 Retry the flaky upload`.
  - "a spec run with Linear tickets needs linear.team": with `tickets: 'linear'` and no team, `/conduct docs/specs/x.md` refuses and names `linear.team`.
  - "a malformed config.json refuses /conduct with the parse error".
  - "in git, /conduct #12 is unchanged": the existing plan tests cover it, and they still pass.
- [ ] **Step 2: Run the tests to make sure they fail.**
- [ ] **Step 3: Implement.** The base is `config.base` when the option was set, else `defaultBranch` from `repository info`. The branch name comes from `runBranchOf` (Task 6 defines it in `hooks/workspace.ts`; create that file here with `runBranchOf` and `slugOf` only). `runBranchOf(prefix, source, id, title)` is `${prefix}${linearKey ?? id}-${slug(title)}`, where the slug is lowercase `[a-z0-9]+` joined by `-`, at most 40 characters, and dropped when empty.
- [ ] **Step 4: Run the tests.** Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "conduct: project config, Linear sources and Lore preconditions"` (add the new files).

### Task 5: Linear client, ticket tools and automatic states

**Files:**
- Create: `hooks/linear.ts`
- Modify: `.claude-plugin/plugin.json` (`userConfig.linearApiKey`: `type` string, `title` "Linear API key", `sensitive` true, `required` false, `description` "A Linear API key for runs whose tickets are in Linear. Leave it empty to use LINEAR_API_KEY.")
- Modify: `hooks/register.tsx`. Add `linear()` beside `github()` (L900-918), using `ask` (L831). Register `ticket_read` and `ticket_file` in `session.start` only when the project config says `tickets: "linear"` or a Linear key is set. Add their handlers. Add state moves in `/approve` (L1885), in `heard()` (L484, a worker started), and in the merge settle paths (Tasks 8 and 9 call `moveIssue`).
- Modify: `tests/world.ts`. In the `http.fetch` handler (L252-308), a URL equal to `LINEAR_API` routes to `World.linear: { issues: Record<string, LinearIssue>; teams: Record<string, LinearTeam>; created: object[]; updated: object[]; accepts: string; isDown?: boolean }`, checking `Authorization === accepts` (no `Bearer`).
- Test: `tests/linear.test.ts`

**Interfaces:**
- Produces in `hooks/linear.ts`:
  - `LINEAR_API = 'https://api.linear.app/graphql'`, and `LINEAR_KEY` re-exported
  - `linearKeyOf(word: string): string | undefined` (a key, or a `linear.app/.../issue/KEY/...` URL)
  - `apiKeyOf(options: unknown): string`
  - `Q_ISSUE`: `issue(id:)` with `id identifier title description url state { name type } parent { identifier } children { nodes { identifier title state { name type } } } comments(last: 20) { nodes { body createdAt user { displayName } } } team { id key states { nodes { id name type position } } }`
  - `Q_TEAM`: a team by key, with its states
  - `M_CREATE`: `issueCreate` returning `identifier url`
  - `M_UPDATE`: `issueUpdate(id:, input: { stateId })`
  - `issueOf(json: unknown): IssueView | undefined` and `issueText(view: IssueView): string`
  - `stateFor(states, type: 'started' | 'completed'): string | undefined`: the state of that type with the lowest `position`
  - `createdOf(json: unknown): { key: string; url: string } | undefined`
- Produces in register.tsx:
  - `linear($, query: string, variables: Record<string, unknown>): Promise<{ data: unknown } | { error: string }>`, which never throws
  - `linearKey($): Promise<string | undefined>`: the option, then `LINEAR_API_KEY`
  - `moveIssue($, path: string, key: string, type: 'started' | 'completed'): Promise<void>`. A failure is recorded once as a warning problem whose text names the issue and the state type; it is never thrown.
  - Tools:
    - `ticket_read { key }`: answers `issueText`.
    - `ticket_file { title, description, task? }`: refused until `run.plan === 'approved'`. Its parent is `run.issue ?? run.source` (a Linear key). When `task` is given, it sets that task's `ticket`.
  - For a spec run with `tickets: 'linear'`, `/approve` first files the run's parent issue in `config.linear.team` (title = run title, description = `Spec: <path>`) and records `run.issue`.

- [ ] **Step 1: Write the failing tests** in `tests/linear.test.ts`:
  - "ticket_read reads an issue with its sub-issues": the text contains `ABC-12`, the title, the state and each child key with its state.
  - "the key goes in the header and nowhere else": after the reads, writes and a failed call, `JSON.stringify(files)`, the toasts, the problems and every tool text contain no part of the key.
  - "/approve moves the run's issue to its team's first started state": the team has two started states at positions 2 and 1, and `updated` holds the one at position 1.
  - "a worker start moves its task's issue to started".
  - "in git, a GitHub merge of a task with a Linear ticket moves it to completed": the settle path after GitHub's merge (register.tsx L1075-1077, `onMain`) calls `moveIssue`. The GitHub merge texts stay unchanged.
  - "ticket_file is refused before approval, and files a sub-issue after it": `created[0]` has `parentId` set to the run issue's `id`. With `task: 't1'`, the task's ticket becomes the new key.
  - "a spec run files its parent issue at /approve in linear.team".
  - "Linear down is a warning problem once, never a stopped run": `isDown: true`, two state moves → one warning problem, and the plan is still approved.
  - "no key: the Linear tools say where to set it": the text names the option "Linear API key" and `LINEAR_API_KEY`.
  - "a git session with no Linear config registers no Linear tool": `engine.registered` is exactly the list in `tests/home.test.ts`.
- [ ] **Step 2: Run the tests to make sure they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "linear: ticket tools, key option and automatic states"` (add the new files).

### Task 6: Worker workspaces

**Files:**
- Modify: `hooks/workspace.ts` (created in Task 4)
- Modify: `hooks/register.tsx`. The `agent.spawn` hook (L1543-1617) prepares the workspace between `claim` and `next`. Add `on('classic.WorktreeCreate', …)` and a `tool.call` safety net in the generic hook (L1619-1653).
- Modify: `hooks/posts.ts`. `relative(path, root, workspace?)` (L40) also strips a worker's own workspace prefix.
- Test: `tests/workspace.test.ts` (pure), `tests/lore-workers.test.ts`

**Interfaces:**
- Consumes: `ignoreRules`, `isIgnored`, `statusOf`, `branchInfoOf` (Task 1); `lore`, `backendOf` (Task 2); `Task.workspace`, `run.lore` (Task 3); `LORE_DEFAULTS` (Task 4).
- Produces in `hooks/workspace.ts`:
  - `taskBranchOf(runBranch: string, taskId: string): string`, which is `${runBranch}/${taskId}`
  - `workspacesOf(root: string, configured?: string): string`, defaulting to `${dirname(root)}/${basename(root)}.conductor`
  - `workspaceOf(base: string, runId: string, taskId: string): string`, and `runWorkspaceOf(base, runId)`, which is `${base}/${runId}/_run`
  - `topLevel(entries: { name: string; isDir: boolean }[], rules, carry: readonly string[]): string[]`: the entries to copy (not ignored, or carried)
  - `removals(listing: string, rules, carry): string[]`. `listing` is `find` output relative to the copy, one path per line, with a trailing `/` for a directory. It answers the outermost ignored paths that are not carried, each once (descendants of a removed directory are skipped).
- Produces in register.tsx:
  - `prepareWorkspace($, at: { root: string; path: string; branch: string; from: string; carry: string[]; minFreeGB: number }): Promise<{ path: string } | { error: string }>`, which runs these steps in order:
    1. Check free space with `df -Pk <parent>`, refusing below `minFreeGB`.
    2. `cp -c -R <root>/<entry> <path>/` for each entry from `topLevel`.
    3. Write a listing of the copy into a file under `.claude/conductor/runs/<run>/`, with `['/bin/sh', '-c', 'find "$1" -mindepth 1 -type d -exec printf "%s/\\n" {} + > "$2"; find "$1" -mindepth 1 -type f >> "$2"', 'sh', path, listingFile]`. macOS's `find` has no `-printf`, which is why the directories go through `printf`. Read the listing with `$.fs.read` and make its paths relative to `path`.
    4. `rm -rf` the `removals`, in batches of at most 200 paths.
    5. `lore repository update-path`.
    6. `lore status --scan`, then `rm` its `untracked`.
    7. `lore branch switch <from> --reset`.
    8. If `branchInfoOf(branch info <branch>)` has a `remoteLatest`, `lore branch switch <branch> --reset`. Otherwise `lore branch create <branch>` and then `lore push`.

    On any failure it removes `path` and answers `{ error }`.
  - A start lock: `let starting: Promise<void>` serializes the preparation and the `next(e)` call of Lore worker starts. `pendingWorkspace: { taskId: string; path: string } | undefined` is set just before `next(e)` and cleared by the WorktreeCreate hook or when `next` resolves.
  - The `classic.WorktreeCreate` hook:
    - Lore backend with a pending workspace: answer `{ worktreePath: pending.path }`.
    - Git backend (or no bound run): answer `{}`, never `next(e)`, so a git repository keeps Claude Code's own worktree (spec section 7, finding 1).
    - Lore with nothing pending: answer `{}`, and the engine's placeholder then says why.
  - The `from` branch is the task's base branch when it builds on a green task (`decided.base.branch`, router.ts:37), else `run.lore.branch`. The task records `workspace` and `branch`.
  - The safety net: a worker of a Lore run whose task has no `workspace` gets `{ deny }` on Edit, Write, NotebookEdit and Bash. The reason names `isolation: "worktree"`.

- [ ] **Step 1: Write the failing tests.** In `tests/workspace.test.ts`: `topLevel` leaves out `Saved` and keeps carried `Intermediate`; `removals` gives the outermost ignored directory once and respects `!change.log`; `workspacesOf('/work/Big Game 5.8')` is `'/work/Big Game 5.8.conductor'`. In `tests/lore-workers.test.ts`, in a Lore world with an approved run:
  - "a worker start makes its workspace on its own branch and the engine is told its path": `loreCalls` include `branch create conductor/ABC-12-x/t1` with `cwd` at the workspace, and `$.classic.WorktreeCreate({ name: 'agent-a1' })` answers `{ worktreePath: '/work/Big Game 5.8.conductor/ABC-12/t1' }`. The task holds `workspace` and `branch`.
  - "workspace paths with spaces travel as single arguments": every `cp` argv element containing `Big Game 5.8` is one element, and no argv contains a shell string built from a path.
  - "Saved is never copied": no `cp` argv names `Saved`.
  - "two starts in one message get one workspace each": two `spawn` calls started together, each followed by a WorktreeCreate, answer two different paths, matching their tasks.
  - "a failed copy releases the task and leaves no half workspace": `cp` answers exit 1 → the start is denied with the reason, the task is `queued` again, and an `rm -rf <path>` was run.
  - "too little disk denies the start": `df` reports 10 GB free with `minFreeGB` 20 → denied, naming both numbers, and no `cp` ran.
  - "a restarted task reuses its pushed branch": `branch info` shows a `remoteLatest` → `branch switch`, never `branch create`.
  - "in git, WorktreeCreate answers {} and the engine makes its worktree".
  - "a Lore worker with no workspace cannot write": `bash($, 'ls', 'a9')` for a worker whose task has no workspace is denied.
- [ ] **Step 2: Run the tests to make sure they fail.**
- [ ] **Step 3: Implement** the pure functions, `prepareWorkspace`, the start lock and the two hooks.
- [ ] **Step 4: Run the tests.** Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "lore: worker workspaces from copy-on-write copies on their own branches"` (add the new tests).

### Task 7: The run branch and the run workspace at `/approve`

**Files:**
- Modify: `hooks/register.tsx`, the `/approve` hook (L1885-1899)
- Test: `tests/lore-approve.test.ts`

**Interfaces:**
- Consumes: `prepareWorkspace`, `runWorkspaceOf` (Task 6); `branchInfoOf` (Task 1); `moveIssue` (Task 5).
- Produces: in a Lore run, `/approve` does the following before `approvePlan`:
  1. `prepareWorkspace` for `_run`, with `from: base` and `branch: run.lore.branch`. This creates and pushes the run branch.
  2. `lore branch protect <base>`, run in the run workspace (idempotent).
  3. Records `run.lore.workspace` and `run.lore.baseAt` (the base's `remoteLatest`).

  Any failure refuses the approval with the reason, and the plan stays `proposed`. The copy can take minutes, so `/approve` toasts "Making the run workspace" first.

- [ ] **Step 1: Write the failing tests:**
  - "approve makes the run branch from the base and protects the base": the order of `loreCalls` is `branch switch main --reset`, then `branch create conductor/ABC-12-x`, then `push`, then `branch protect main`, and `run.lore.baseAt` equals the base's `Remote Latest` from the fixture.
  - "a failed run workspace keeps the plan proposed".
  - "a re-run /approve after a failure reuses a pushed run branch".
- [ ] **Step 2: Run the tests to make sure they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "lore: run branch and run workspace at approve"`

### Task 8: Hand-back and merging a task into the run branch

**Files:**
- Create: `hooks/lore-merge.ts`
- Modify: `hooks/register.tsx`. `mergeTool` (L1001-1097): a Lore backend goes to `loreMergeTool`. The `merge_check`/`merge` schemas get `closes` and `onRedMain` described as GitHub-only, and their descriptions say "branch" for Lore.
- Modify: `hooks/signals.ts` `updateTask` (L413-481): a Lore task in `review` needs `branch` and `revision`. `done` is refused for a task with a `revision` ("done once merged: call mcp__conductor__merge"), mirroring the `pr` rule at L440-444. A task with no branch and no revision may be set `done` by the orchestrator.
- Test: `tests/lore-merge.test.ts`

**Interfaces:**
- Consumes: `mergeOf`, `pushOf`, `branchInfoOf`, `statusOf` (Task 1); `lore` (Task 2); `moveIssue` (Task 5); `Task.workspace` (Task 6); `run.lore.workspace` (Task 7).
- Produces in `hooks/lore-merge.ts`:
  - `loreReady(ledger: Ledger, caller: Caller, input: Record<string, unknown>, others: readonly Flight[]): { task: Task; branch: string; revision: string } | { error: string }`. It gives the same refusals, in the same words, as `precheck` (merge.ts:268-318) for: not the orchestrator, unknown task, not green, paused, unmerged dependencies, a problem waiting under it, and a merge in flight here or in another run. It adds: no `branch`/`revision` recorded ("set it to review with branch and revision"), and a check configured but not `passed` on this revision.
  - `startLoreMerge(raw: Raw, at: string, claim: { task: string; revision: string; target: 'run' | 'base' }): Outcome`
  - `onRunBranch(raw: Raw, at: string, taskId: string, revision: string): Outcome`. It sets the task `done`, `mergeCommit = revision`, `mergedAt`, and clears `merge`. Its text: `Merged: <task> is on <run branch> as <rev7>, and the task is done. Go on at once: start what can start and merge the next green task.`
  - `conflicted(raw: Raw, at: string, taskId: string, files: string[]): Outcome`. It clears `merge`, sets the task `blocked`, and its note and text name the files: "Its branch conflicts with the run branch in: <files>. Nothing was merged. Have its worker bring the run branch into its own branch and resolve, then judge it again."
  - `letGo(raw: Raw, why: string): Outcome`: clears `merge` and says why. It is not named `released`, because signals.ts already exports a `released`.
- Produces in register.tsx, `loreMergeTool($, call, isCheckOnly)`, which runs these steps:
  1. `loreReady`
  2. `branch info <task branch>` (in the run workspace); refuse unless `remoteLatest === task.revision` ("its branch moved since it was judged: judge it again")
  3. `merge_check` answers here
  4. claim
  5. `branch switch <run branch> --reset`
  6. `branch merge <task branch> --message "<task id>: <title>"`, which is either:
     - a conflict: `branch merge abort`, then `conflicted`;
     - merged: `push`; if pushed, `onRunBranch`, `moveIssue(ticket, 'completed')`, `lock release --branch <task branch>`, and removal of the worker's workspace when `status --scan` there is clean and in sync; if refused, `letGo` with the push text.

     Every path that fails after the claim settles it. None leaves `merge` set without an answer.

- [ ] **Step 1: Write the failing tests** in `tests/lore-merge.test.ts`:
  - "a green task is merged into the run branch, pinned to its judged revision": the `branch merge` argv names the task branch, the task is `done` with `mergeCommit` equal to the merged signature, `merge` is cleared, and the Linear issue was moved to completed.
  - "a branch that moved since it was judged is refused and nothing merges".
  - "a conflict aborts, blocks the task and names the files": `branch merge abort` ran, `push` did not, and the run branch is untouched.
  - "a failed push releases the claim".
  - "merge_check says what stands in the way and runs no write".
  - "one merge at a time, across runs" (reuse the flight fixture with a Lore flight).
  - "a check configured but not passed on this revision holds the merge".
  - "a clean pushed workspace is removed after the merge; a dirty one is kept and the orchestrator told".
  - "a task without code is set done by the orchestrator".
  - "in git, merge still goes to GitHub" (the existing merging tests, unchanged).
- [ ] **Step 2: Run the tests to make sure they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "lore: merge a judged task branch into the run branch"` (add the new files).

### Task 9: `/approve-main`, bringing the base in, and the end of a run

**Files:**
- Modify: `hooks/lore-merge.ts`
- Modify: `hooks/register.tsx`. Register `/approve-main` and the tool `run_sync_base` only for a Lore backend. Add their handlers.
- Test: `tests/lore-main.test.ts`

**Interfaces:**
- Consumes: Task 8's claim and settle functions; `run.lore.baseAt` (Task 7); `moveIssue` (Task 5).
- Produces in `hooks/lore-merge.ts`:
  - `readyForBase(ledger: Ledger): string[]`: what stands in the way. That's a task not `done`, an open blocker or warning, a merge in flight, the run paused, or a configured run check not passed on the run branch's head. Empty means ready.
  - `approvedMain(raw: Raw, at: string, approval: { revision: string; base: string }): Outcome`
  - `onBase(raw: Raw, at: string, revision: string): Outcome`. It sets `run.merged`, clears `merge`, and its text says the run is on the base branch.
  - `baseBroughtIn(raw: Raw, at: string, baseAt: string, revision: string): Outcome`. It sets `run.lore.baseAt` and clears `run.approval`.
- Produces in register.tsx:
  - `/approve-main`, which only a person can type. It reads the run branch's and the base's `remoteLatest` (R and B).
    - It refuses when `readyForBase` names anything.
    - It refuses when B ≠ `run.lore.baseAt`. The text: "<base> moved since the run branch last took it in. Ask the orchestrator to bring it in (run_sync_base), then approve again."
    - Otherwise it records `approvedMain` with R, then claims (`target: 'base'`) and runs:
      1. `branch switch <run branch> --reset`, checking that `status` shows revision R;
      2. `branch unprotect <base>`;
      3. `branch merge into <base> "<run title> (<run id>)"`;
      4. `branch protect <base>`, in a `finally`, so it runs after every outcome.
    - Then `onBase`, `moveIssue(run issue, 'completed')`, `branch archive` for each task branch, and removal of clean workspaces including `_run`.
  - `run_sync_base {}` (orchestrator only). In the run workspace it runs `branch switch <run branch> --reset`, then `branch merge <base> --message "Bring <base> into <run branch>"`. A conflict means `branch merge abort` plus a blocker problem naming the files. A clean merge means `push`, then `baseBroughtIn`.
  - For a git run with Linear tickets, the run's issue moves to completed when every task is done.
  - prompt.compose (Lore) tells the orchestrator: when `readyForBase` is empty, say in a line or two what changed and how to try it, and ask the owner to type `/approve-main`.

- [ ] **Step 1: Write the failing tests** in `tests/lore-main.test.ts`:
  - "approve-main merges the approved revision into the protected base and protects it again": the order is `unprotect`, `merge into`, `protect`; `run.merged.revision` is the merge-into signature; the run's issue is completed; task branches are archived.
  - "the base is protected again when merge into fails": `merge into` answers exit 17 → `protect` still ran, the claim is released, the run is not merged, and the text quotes the error.
  - "a run branch that moved after its approval is refused": `status` shows a revision other than R → nothing is unprotected.
  - "a moved base is refused with run_sync_base named".
  - "run_sync_base brings the base in, and a new approval is needed": `baseBroughtIn` clears `run.approval`.
  - "approve-main while a task is open or a warning is open names what stands in the way".
  - "no tool lets the orchestrator merge into the base": `call($, 'merge', { task: '<run id>' …})` is refused, and `/approve-main` from `$.command.run` with `origin.kind !== 'composer'` is refused.
  - "a git session has no /approve-main": `tests/home.test.ts` passes unchanged.
  - "across a whole run, no Lore write ran in the owner's workspace": drive `/conduct`, `/approve`, two worker starts, two merges and `/approve-main`. Every `loreCalls` entry whose `cwd` is the owner's root is `repository info`, `--version`, `branch info` or `status` without `--scan`.
- [ ] **Step 2: Run the tests to make sure they fail.**
- [ ] **Step 3: Implement.** Check which command `origin` kinds the engine gives a typed command (`tests/world.ts` sends `origin: { kind: 'composer' }`). Refuse every other origin for `/approve-main`.
- [ ] **Step 4: Run the tests.** Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "lore: approve-main into the protected base, bring the base in"` (add the new test).

### Task 10: The check command

**Files:**
- Modify: `hooks/register.tsx`. A detached check runner, polled every `WATCH_EVERY`th tick of the existing timer (L1304-1316).
- Modify: `hooks/board.ts` (`detail` L171) and `hooks/dashboard.ts` (L468). They show "checking", "check passed" or "check failed" for a Lore task.
- Test: `tests/lore-check.test.ts`

**Interfaces:**
- Consumes: `run.config.check` (Task 4); `Task.check`, `run.check` (Task 3); the readiness rules (Tasks 8 and 9).
- Produces:
  - `startCheck($, path: string, target: { taskId?: string; cwd: string; revision: string }): Promise<void>`. It runs `['/bin/sh', '-c', 'cd "$1" || exit 97; shift 2; ( "$@" > "$OUT" 2>&1; echo $? > "$OUT.exit" ) &', 'sh', cwd, '--', ...argv]`, with `env: { OUT: <runs>/<run>/checks/<target>-<rev7>.log }`. It records `check = { revision, verdict: 'running', at }`.
  - The poll reads `<log>.exit`. 0 is `passed`, anything else is `failed`, with `line` set to the last non-empty line of the log (at most 200 characters). A check running longer than `timeoutMin` is `failed` with "timed out after N min". The process gets `kill` through its recorded pid: the script writes `$!` to `"$OUT.pid"`.
  - A check starts when a Lore task goes to `green` with a recorded revision (in its worker's workspace), and when `readyForBase` lacks only the run check (in the run workspace, on R). A new revision restarts it.
  - The orchestrator is told when a check ends (`carry` with a `tell`).

- [ ] **Step 1: Write the failing tests:**
  - "green starts the check in the worker's workspace, and argv travels as parameters": the `/bin/sh` argv ends with the config's `argv` elements, unchanged.
  - "an exit file of 0 passes the check and unblocks the merge".
  - "a non-zero exit fails it with the log's last line".
  - "a check past its time is failed and killed".
  - "a new revision restarts the check".
- [ ] **Step 2: Run the tests to make sure they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "lore: optional check command, detached and polled"`

### Task 11: By-hand guards and the words for Lore

**Files:**
- Modify: `hooks/lore.ts` (add `loreByHand`)
- Modify: `hooks/register.tsx`. The generic `tool.call` guard (L1619-1653), prompt.compose (L1737-1773), `rotation` and `session.compact` (`isElsewhere` → backend-aware).
- Modify: `hooks/posts.ts` `briefing` (L272-315), `hooks/handover.ts` (L36, 53, 95-100), `hooks/board.ts` (L184), `hooks/dashboard.ts` (L468), `hooks/pause.ts` (L46)
- Test: `tests/lore-words.test.ts`

**Interfaces:**
- Produces:
  - `loreByHand(command: string, ctx: { base: string; runBranch?: string; ownBranch?: string; caller: 'orchestrator' | 'worker' }): string | undefined`. It splits segments as `byHand` does, and recognizes `lore` by its last path part.
    - For a worker, it refuses `push <b>` with `b` ≠ `ownBranch`, `branch merge|switch|create|protect|unprotect|archive`, and `sync`.
    - For the orchestrator, it refuses every Lore write: `push`, `commit`, `stage`, `sync`, `reset`, `lock`, and `branch merge|switch|create|protect|unprotect|archive|reset`. Reads stay allowed: `status` without `--scan`, `history`, `diff`, `branch info|list|diff`, `file history|diff|info`.
    - The refusal texts name the mod's path: `merge`, `/approve-main`, `run_sync_base`.
  - The Lore texts:
    - prompt.compose: a Lore bullet set replaces L1758-1765's GitHub/elsewhere pair. It covers the run branch, task branches, workspaces made by the mod, `merge` into the run branch, `/approve-main` by the owner only, and `run_sync_base`.
    - The worker brief: its commands (`lore status --scan`, `lore stage --scan <paths>`, `lore commit "<message>"`, `lore push`, `lore diff`), "set the task to review with branch and revision", and locks for `lockPatterns` (`lore lock acquire <file>` before changing a matching file).
    - The restart text: "run lore status --scan and lore diff, and commit and push what is its own".
    - handover and board: `<branch> @ <rev7>` where GitHub shows `PR N`.
    - pause: "settled" without "with GitHub".
  - Every git and GitHub text stays byte-identical.

- [ ] **Step 1: Write the failing tests** in `tests/lore-words.test.ts`:
  - Guard tables, one `expect` per row: `lore push conductor/ABC-12-x/t2` by the worker of t1 is refused; `lore push` by that worker is allowed; `/home/u/.local/bin/lore branch unprotect main` by the orchestrator is refused; `lore status` by the orchestrator is allowed; `cd x && lore branch merge y` is refused.
  - "the orchestrator in a Lore run is told the Lore rules and not GitHub's": the compose text contains `/approve-main` and contains no `pull request`.
  - "a worker's brief names its branch, its lore commands and its locks".
  - "the git texts are unchanged": the existing elsewhere and stacking tests pass untouched.
- [ ] **Step 2: Run the tests to make sure they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "lore: by-hand guards and the words for Lore runs"`

### Task 12: README, manifest, and the live end-to-end run

**Files:**
- Modify: `README.md`:
  - a new "Lore" section: turning it on, the `.loreignore` line, the placeholder snippet, `config.json` with every field, branches, workspaces, merges, `/approve-main`, `run_sync_base`, the guards;
  - a new "Linear" section: the key option, `/conduct ABC-12`, the ticket tools, the automatic states;
  - "Commands and tools" gains `/approve-main`, `ticket_read`, `ticket_file` and `run_sync_base`;
  - "Limits" gains Lore protection guarding against accidents only, the instance id shared with the original, and copies costing nothing until files change;
  - "What it never does" gains that the mod never writes into the owner's workspace.
- Modify: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`: the description names Lore and Linear, and the keywords gain `lore` and `linear`. Bump `version` to `0.2.0`.
- Create: `brief/example-lore.md`: a worker brief for a Lore project with an Unreal-style layout. It names no real project.

- [ ] **Step 1: Run the whole suite and the validator.** Run `claude plugin validate . && claude plugin test .`. Expected: validation passes, and every test passes (the 381 plus the new ones).
- [ ] **Step 2: Prove the tests can fail** (README rule). Copy the repository to a scratch folder and break three things there: make `mergeOf` treat a conflict as merged, drop the `protect` from the `finally`, and copy `Saved`. Expected: `claude plugin test <copy>` fails in `lore-output`/`lore-merge`, `lore-main` and `lore-workers`. Delete the copy.
- [ ] **Step 3: Scan for private names.** Run `grep -rn -i -E "rieck|ultracore|coreborn|kuro|10\.100\." --exclude-dir=.git .`. Expected: no output.
- [ ] **Step 4: Commit.** `git commit -am "docs: Lore and Linear in the README and manifest"` (add `brief/example-lore.md`).
- [ ] **Step 5: The live end-to-end run, with the owner.** This needs the owner's Linear key in the mod's option and a throwaway Linear issue. Ask the owner to:
  - set the key;
  - create the issue in a team they choose;
  - open a session in a fresh workspace of the throwaway Lore repository `conductor-spike` (cloned to a scratch folder, `.claude/conductor/` and the placeholder added locally), loading the branch with `claude --plugin-dir <repo>`.

  Then run the spec's section 6 script, recording each step's result in `docs/superpowers/plans/2026-11-06-lore-e2e.md`:
  - `/conduct <key>`, a two-task plan, `/approve`;
  - two workers in their own workspaces;
  - hand-backs and `merge` for both, then `/approve-main`;
  - a forced conflict (both tasks change one line);
  - a revision moved after approval.

  Expected: every step behaves as the spec says. The base ends protected, and `lore history --branch main` shows the run's merge.
- [ ] **Step 6: Commit the record.** `git add docs/superpowers/plans/2026-11-06-lore-e2e.md && git commit -m "docs: live Lore and Linear run"`
