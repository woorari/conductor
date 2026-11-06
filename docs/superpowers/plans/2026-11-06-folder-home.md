# Folder home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** conductor switches on in a folder that holds `.claude/conductor/` and is neither a git nor a Lore root. Each run there works in one git or Lore workspace inside one of the config's places, chosen from its Linear ticket.

**Architecture:** A new module `hooks/home.ts` finds the home and the workspaces inside places, through a small `Io` interface, so it can be tested on its own. `register.tsx` keeps `root` as the home (config, brief, ledgers). In a folder home, its `backend` becomes the bound run's workspace, read from the ledger's new `run.workspace`. So every Lore and git path that asks the backend follows the run. A repository home takes today's code paths unchanged.

**Tech Stack:** TypeScript Claude Code mod (`claude-code` mod API), tests with `claude-code/testing` run by `claude plugin test .`.

**Spec:** `docs/superpowers/specs/2026-11-06-folder-home-design.md` (approved 2026-11-06). Read it first: this plan argues from it.

## Global Constraints

- Test-first: every task writes its failing test before the code.
- `claude plugin test .` stays green, and the existing 533 tests pass **untouched**. Changing the shared test world (`tests/world.ts`, `tests/lore-world.ts`) is allowed only additively: defaults keep today's behaviour.
- `claude plugin validate .` stays clean.
- The repository is public: no private names in code, docs, tests or fixtures. Use `lore.example.test`, the teams `ABC` and `DEF`, and folders such as `/work`, `studio`, `game/code`, `game/art`.
- A repository home (a git or Lore root with its own `.claude/conductor/`) behaves exactly as today. `run_workspace` is registered only in a folder home, so the tool list of a repository home is unchanged.
- Paths fail closed: a path whose real path cannot be read is refused, never assumed.
- Messages the owner reads are copied from spec §5.7 where it gives them.
- Commit after each task on `feature/folder-home`, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.
- Before each task's test run, check weekly usage (`mcp__ccd_session_mgmt__get_usage`, "Weekly · all models"). At 97% or more, stop: commit nothing half-done, write where things stand into `.superpowers/sdd/2026-11-06-folder-home/progress.md`, and tell the owner.

## Review Focus

1. **The session's folder reached through a symlink** (macOS `/tmp` → `/private/tmp`): the home is found by its path, but every inside check compares real path to real path. A symlinked home must still accept its own places. Test in Task 2.
2. **Folder names with spaces** (`Big Game 5.8`): every path reaches programs as one argv element and the prompt quotes it. The folder-home fixture's workspace has a space in its name, so every task's tests exercise it.
3. **A Linear link instead of a key** (`/conduct https://linear.app/team/issue/ABC-12`): the team comes from `linearKeyOf`'s result, not from the raw word. Test in Task 4.
4. **The home config edited between `/conduct` and the pick:** the pick uses the places frozen in the run at `/conduct`. Test in Task 5.
5. **A session in `/` or in the user's home folder, with no home anywhere:** the walk ends, and nothing is registered. Test in Task 2.

---

### Task 1: `places` in the config

**Files:**
- Modify: `types/index.d.ts` (`ProjectConfig`; new `Place`, `WorkspaceKind`, `Candidate`, `RunWorkspace`; `Ledger['run']`)
- Modify: `hooks/project.ts` (`parseConfig`, new exports)
- Modify: `hooks/ledger.ts` (parse and check `run.workspace`, `run.candidates`)
- Test: `tests/project.test.ts`, `tests/ledger.test.ts`

**Interfaces:**
- Produces, in `types/index.d.ts`:
  - `type Place = { folder: string; teams: string[]; about: string; base?: string; lore?: ProjectConfig['lore']; check?: ProjectConfig['check'] }`
  - `ProjectConfig.places?: Place[]`
  - `type WorkspaceKind = 'git' | 'lore'`
  - `type Candidate = { kind: WorkspaceKind; root: string; place: string; about: string }`, where `root` is a real absolute path and `place` is the place's `folder`.
  - `type RunWorkspace = { kind: WorkspaceKind; root: string; place: string; base: string; remote?: string }`
  - `Ledger['run'].workspace?: RunWorkspace` and `Ledger['run'].candidates?: Candidate[]`
- Produces, in `hooks/project.ts`:
  - `folderProblem(folder: unknown, at: number): string | undefined`
  - `homeConfigProblem(config: ProjectConfig, kind: 'repository' | 'folder'): string | undefined`
  - `placeConfig(place: Place, team: string): ProjectConfig` returns `{ tickets: 'linear', linear: { team }, lore?: place.lore, check?: place.check }` (absent keys left out).

- [ ] **Step 1: Write the failing tests** in `tests/project.test.ts`:
  - `places: a folder home's config with places is read as given`: `parseConfig` of the spec §5.2 example (folders `studio`, `game/code`, `game/art`, teams `ABC` and `DEF`) gives `{ config }` deep-equal to the JSON.
  - `places: each folder that leads nowhere safe is refused`: for each of `''`, `'.'`, `'/abs'`, `'~/x'`, `'..'`, `'a/../b'`, `'a/..'`, `'a\\b'`, `'a\u0000b'`, and for a non-string, `parseConfig` gives `{ error: 'config.json: places[0].folder must be a folder inside this home, given relative to it.' }`.
  - `places: two places that are the same folder, or one inside the other, are refused`: `['a','a']`, `['a','a/b']` and `['a/b','a']` give `{ error: 'config.json: places[1].folder lies inside, above or on places[0].folder: places may not overlap.' }`. `'a/'` and `'a'` count as the same folder.
  - `places: teams are Linear team keys and about is one line`: `teams: []`, `teams: ['abc']` and a missing `about` give errors naming `places[0].teams` or `places[0].about`. An `about` holding a newline is refused.
  - `places: a place's lore and check are checked as the top-level ones are`: `places[0].lore.minFreeGB: -1` gives the same message as today's top-level check, prefixed with `places[0].`. An unknown key in a place is refused, as unknown top-level keys are today.
  - `homeConfigProblem: places belong to a folder home only`:
    - `homeConfigProblem({ places: [...] }, 'repository')` names `places`;
    - `homeConfigProblem({}, 'folder')` says that `places` is required;
    - `homeConfigProblem({ places, lore: {} }, 'folder')` and the same with `check` or `linear` say to move that key into a place;
    - `homeConfigProblem({ places, tickets: 'github' }, 'folder')` says that tickets are Linear in a folder home;
    - a valid config gives `undefined`.
  - `placeConfig: a run takes its place's settings in today's shape`: `placeConfig({ folder: 'game/code', teams: ['DEF','ABC'], about: 'x', lore: { branchPrefix: 'c/' } }, 'ABC')` equals `{ tickets: 'linear', linear: { team: 'ABC' }, lore: { branchPrefix: 'c/' } }`.
- [ ] **Step 2: Write the failing ledger tests** in `tests/ledger.test.ts`. `ledger: a run's workspace and candidates are read and kept`: a ledger with `run.workspace = { kind: 'lore', root: '/work/game/code/Big Game 5.8', place: 'game/code', base: 'main' }` and two candidates round-trips. A `kind` other than `git` or `lore`, or a relative `root`, is refused as other bad fields are today.
- [ ] **Step 3: Run them and see them fail**: `claude plugin test .`. Expected: the new tests FAIL, all others pass.
- [ ] **Step 4: Implement it.** Add `places` to `parseConfig`'s accepted top-level keys and a `PLACE` key list (`folder`, `teams`, `about`, `base`, `lore`, `check`). Reuse the existing `lore` and `check` checks by moving them into a helper that takes a key prefix, so the top-level messages stay byte-for-byte the same. `base` follows the existing branch-name rule used for `lore.branchPrefix`, but must be non-empty. Overlap is compared on `/`-split segments after trimming trailing `/`.
- [ ] **Step 5: Run the tests and see them pass**: `claude plugin test .`. Expected: all pass.
- [ ] **Step 6: Commit**: `git add types/index.d.ts hooks/project.ts hooks/ledger.ts tests/project.test.ts tests/ledger.test.ts && git commit -m "config: places for a home that is not a repository"`

### Task 2: Finding the home and the workspaces in a place

**Files:**
- Create: `hooks/home.ts`
- Test: `tests/folder-home.test.ts` (unit tests of `home.ts`, with an in-memory `Io`)

**Interfaces:**
- Consumes: `Place`, `Candidate`, `WorkspaceKind` (Task 1).
- Produces:
  - `type Io = { exists(path: string): Promise<boolean>; list(path: string): Promise<{ name: string; kind: 'dir' | 'file' }[]>; real(path: string): Promise<string | undefined>; userHome: string | undefined }`
  - `type Home = { kind: 'repository' | 'folder'; root: string }`
  - `findHome(io: Io, cwd: string, gitRoot: string | null): Promise<Home | null>`
  - `workspacesIn(io: Io, placeReal: string): Promise<{ found: { kind: WorkspaceKind; root: string }[]; left: string[] }>`
  - `candidatesFor(io: Io, home: string, places: readonly Place[], team: string): Promise<{ candidates: Candidate[]; left: string[] } | { error: string }>`
  - `workspaceOfSpec(io: Io, home: string, places: readonly Place[], spec: string): Promise<{ candidate: Candidate; team: string } | { error: string }>`

`findHome` follows spec §5.1. The signature leaves the rule open, so here it is:

```
isRoot(d)  = d === gitRoot || exists(d/.git) || exists(d/.lore)
for d from cwd up to '/' (trailing slashes trimmed; '/' itself and io.userHome are never a home):
  if not exists(d/.claude/conductor): continue
  if isRoot(d): return { kind: 'repository', root: d }
  if no ancestor of d isRoot: return { kind: 'folder', root: d }
  // else: .claude/conductor inside a repository below its root means nothing, as today
return null
```

`workspacesIn` looks at the place itself, then at its direct subfolders, skipping names that start with `.` or end in `.conductor`. A folder with `.git` is git, else one with `.lore` is Lore. A subfolder whose real path is not strictly inside `placeReal` goes to `left` as `"<path> leads out of its place"`. `candidatesFor`:
- resolves the home's real path, then each place of the team;
- refuses the whole call on the first place that is missing, is no folder, has no readable real path, or lies outside the home, using the spec §5.7 messages;
- answers the spec's "no place for the team" and "no workspace" messages when it finds nothing.

`workspaceOfSpec` picks the deepest root holding the spec's real folder. Its team is the place's first.

- [ ] **Step 1: Write the failing tests**:
  - `findHome: a folder with .claude/conductor that is no repository is a folder home`: cwd `/work`, and cwd `/work/game`, give `{ kind: 'folder', root: '/work' }`.
  - `findHome: a session inside a repository without its own home finds the folder home above`: a git repository at `/work/studio`, and a Lore workspace at `/work/game/code/Big Game 5.8`, each without `.claude/conductor`, give `/work`.
  - `findHome: the nearer repository home wins`: `/work/game/code/Big Game 5.8/.claude/conductor` exists, so cwd inside it gives `{ kind: 'repository', root: '/work/game/code/Big Game 5.8' }`.
  - `findHome: .claude/conductor below a repository's root means nothing`: `/work/studio/sub/.claude/conductor` with cwd `/work/studio/sub` gives `/work`, not `/work/studio/sub`.
  - `findHome: the user's own home folder and / are never a home`: `/home/owner/.claude/conductor` exists, and cwd `/home/owner/x` gives `null`. Cwd `/` gives `null`. **(Review Focus 5)**
  - `findHome: a repository home is found as today`: gitRoot `/repo` with `/repo/.claude/conductor`, and cwd `/repo/src`, give `{ kind: 'repository', root: '/repo' }`.
  - `workspacesIn: the place itself and its direct subfolders that are roots`:
    - `game/code` holding `Big Game 5.8/.lore`, `Engine` (no root) and `Big Game 5.8.conductor/` gives one Lore root;
    - a place that is itself `.lore` with a nested `.lore` child gives both;
    - a folder with both `.git` and `.lore` is git;
    - nothing deeper than one level is looked at.
  - `workspacesIn: a subfolder that leads out through a symlink is left out`: the real path of `/work/game/art/linked` is `/elsewhere`, so `left` names it and `found` lacks it.
  - `candidatesFor: a place that leads out of the home is refused`:
    - place `game` whose real path is `/elsewhere/game`;
    - place `game/code` under a symlinked `game` that leads out;
    - a real path that can't be read (`real` answers undefined).

    Each answers `{ error }` with the spec §5.7 folder message.
  - `candidatesFor: a symlinked home still takes its own places`: home `/tmp/work`, whose real path is `/private/tmp/work`, with a place inside, answers the candidate with real root `/private/tmp/work/...`. **(Review Focus 1)**
  - `candidatesFor: no place for the team, and places with no workspace`: these answer exactly `No run was started. No place in .claude/conductor/config.json takes team XYZ: add XYZ to a place's teams.` and `No run was started. game/code holds no git or Lore workspace. Put the folder the work needs into Lore or git first, then give /conduct again.`
  - `workspaceOfSpec: the nearest root that holds the spec wins, and a spec in no workspace is refused`.
- [ ] **Step 2: Run them and see them fail**: `claude plugin test .`. Expected: FAIL, "home.ts" not found.
- [ ] **Step 3: Implement `hooks/home.ts`** as given above. It has no imports from `register.tsx`.
- [ ] **Step 4: Run the tests and see them pass**: `claude plugin test .`. Expected: all pass.
- [ ] **Step 5: Commit**: `git commit -m "home: find a folder home and the workspaces in its places"` (with the two files).

### Task 3: The mod switches on in a folder home

**Files:**
- Modify: `hooks/register.tsx` (`isHome`, `rootOf`, module state, the `Io` of `$`)
- Modify: `tests/world.ts` (additive: `homes?: string[]`; when set, `fs.exists` of `<x>/.claude/conductor` is true only for `x` in `homes`, otherwise `isHome` answers as today)
- Create: `tests/folder-world.ts` (the folder-home fixture)
- Test: `tests/folder-home-session.test.ts`

**Interfaces:**
- Consumes: `findHome`, `Io`, `Home` (Task 2).
- Produces:
  - `homeOf($): Promise<Home | null>` in `register.tsx`, read once per session like `backend`;
  - `ioOf($): Io`, where `real` runs `['/bin/pwd', '-P']` with `cwd: path` and answers the trimmed stdout, or `undefined` on any failure, and `userHome` comes from `$.env.get('HOME')`;
  - `rootOf($)` now answers the home's root, so ledgers, config and `brief.md` come from the home;
  - in `tests/folder-world.ts`:
    - the paths `HOME_ROOT = '/home/owner/work'` (inside the test world's user home, `/home/owner`), `LORE_WS = HOME_ROOT + '/game/code/Big Game 5.8'` and `GIT_WS = HOME_ROOT + '/studio'`;
    - `FOLDER_CONFIG`: the spec §5.2 example with folders `studio`, `game/code` and `game/art`, the art place holding no workspace;
    - `folderWorld(on, files, more?: { cwd?: string })`, which wraps `world(on, files, null)` with `homes: ['/work']`, the Lore and git roots in `dirs`, the `/bin/pwd -P` answer as identity, Lore's `repository info` answered, and `cwd` `/work`;
    - `folderLedgerPath(run)`: `/work/.claude/conductor/runs/<run>/ledger.json`.

- [ ] **Step 1: Write the failing tests**:
  - `a session in a folder home registers the mod's commands and tools`: `engine.registered` holds `/conduct`, `/approve`, `/board` and `run_workspace`, beside today's list.
  - `/conduct with no words in a folder home answers its usage`: the answer's text starts with `Say what the run starts from:`.
  - `a session in a git repository inside a folder home switches on there too`: cwd `/work/studio`, gitRoot `/work/studio`, and `/conduct` gives the usage text.
  - `a repository home registers no run_workspace`: in today's `world`, `engine.registered` lacks `run_workspace`. (The existing `home.test.ts` list stays as it is.)
- [ ] **Step 2: Run them and see them fail**: `claude plugin test .`. Expected: the four new tests FAIL.
- [ ] **Step 3: Implement it.** `isHome` becomes `(await homeOf($)) !== null`. In a repository home, `homeOf` answers the backend's root as today, so today's behaviour is unchanged. In a folder home, `backendOf` answers `null` until Task 6. Register `run_workspace` only when `home.kind === 'folder'`. For now it answers `Nothing to pick yet.`; Task 5 fills it in.
- [ ] **Step 4: Run the tests and see them pass**, with all 533 old ones untouched: `claude plugin test .`.
- [ ] **Step 5: Commit**: `git commit -m "register: switch on in a home that is not a repository"`

### Task 4: `/conduct` in a folder home

**Files:**
- Modify: `hooks/register.tsx` (the `command.run` handler for `conduct`; new `fixWorkspace`)
- Test: `tests/folder-conduct.test.ts`

**Interfaces:**
- Consumes: `candidatesFor`, `workspaceOfSpec` (Task 2); `homeConfigProblem`, `placeConfig` (Task 1); `folderWorld` (Task 3).
- Produces: `fixWorkspace($, run: { id: string; source: string; title?: string }, candidate: Candidate, place: Place, team: string): Promise<{ workspace: RunWorkspace; config: ProjectConfig; lore?: Ledger['run']['lore'] } | { error: string }>`. It does the per-kind checks of spec §5.4:
  - **Lore:** `lore repository info` with `cwd` at the root; the placeholder in the session's own folder (`$.session.cwd()`), in `.claude/settings.json` or `.claude/settings.local.json`; then `run.lore`, with `base` = `place.base ?? config.base` and `branch` = `runBranchOf(place.lore?.branchPrefix ?? LORE_DEFAULTS.branchPrefix, source, id, title)`.
  - **Git:** `git -C <root> remote get-url origin` through `runProgram`, giving `remote`; the placeholder check only when `$.session.repo()` is null.

- [ ] **Step 1: Write the failing tests**:
  - `a ticket with one workspace fixes it at /conduct`: `/conduct ABC-12` in `folderWorld` writes `folderLedgerPath('ABC-12')`, whose `run.workspace` is `{ kind: 'git', root: '/work/studio', place: 'studio', base: 'main', remote: ORIGIN }`. Its `run.config` equals `placeConfig(studio place, 'ABC')`. No `run.candidates`.
  - `a ticket whose team has several workspaces lists them for the orchestrator`: the place `game/code` holds two Lore roots, so `/conduct DEF-4` writes `run.candidates` (both, each with `about`). `run.workspace` stays undefined and `run.config` is `{ places: [the DEF places] }`.
  - `a Linear link gives its team` **(Review Focus 3)**: `/conduct https://linear.app/team/issue/ABC-12` fixes `/work/studio`.
  - `refusals`: each answers its exact text, and no ledger is written:
    - team `XYZ`, the "no place" text;
    - only `game/art` for team `DEF`, the "no workspace" text;
    - `/conduct #12`: `No run was started. In a home that is not a repository, tickets are Linear: give the ticket's key, like /conduct ABC-12. A GitHub issue is run from a session in its own repository.`;
    - a config with top-level `lore`, the `homeConfigProblem` text after `No run was started: `.
  - `a spec run works in the workspace that holds the spec`: `/conduct game/code/Big Game 5.8/docs/x.md` (with the spec file present) fixes that Lore root. `run.config.linear.team` is `DEF`.
  - `in a folder home the ledgers need no .loreignore line`: a Lore `/conduct` passes with no `.loreignore` in the workspace.
  - `in a folder home the placeholder is read from the session's own folder`:
    - placeholder at `/work/.claude/settings.local.json`: passes;
    - placeholder only in `/work/game/code/Big Game 5.8/.claude/settings.local.json`: refused with today's text, naming `/work/.claude/settings.local.json`.
- [ ] **Step 2: Run them and see them fail**: `claude plugin test .`.
- [ ] **Step 3: Implement it.** In a folder home the handler:
  - reads and checks the home config (`parseConfig`, `homeConfigProblem(config, 'folder')`);
  - takes the team from the Linear key before the dash;
  - calls `candidatesFor` or `workspaceOfSpec`;
  - with one candidate, calls `fixWorkspace` and writes its result into the new run;
  - with several, writes `candidates` and `config: { places }`.

  A repository home keeps today's code path line for line.
- [ ] **Step 4: Run the tests and see them pass**: `claude plugin test .`.
- [ ] **Step 5: Commit**: `git commit -m "conduct: a run in a home that is not a repository takes its workspace from the ticket"`

### Task 5: `run_workspace` and the plan gate

**Files:**
- Modify: `hooks/register.tsx` (`run_workspace` tool, `run_plan` handler, `/approve` text, orchestrator prompt lines for an open pick)
- Test: `tests/folder-pick.test.ts`

**Interfaces:**
- Consumes: `fixWorkspace` (Task 4), `workspacesIn` and `candidatesFor` (Task 2).
- Produces:
  - Tool `run_workspace`, taking `{ path: string }` (an absolute root from the candidates). Its answer names the picked workspace relative to the home.
  - `relOf(root: string): string`, a workspace relative to the home's real root, for every text the owner reads.

- [ ] **Step 1: Write the failing tests**:
  - `run_plan waits for the pick`: in a run with candidates and no workspace, `run_plan` answers `Pick the run's workspace first: run_workspace takes one of the workspaces this run lists.`, and the ledger's plan is unchanged.
  - `run_workspace takes only a listed workspace`: a root not among the candidates, or a root that has stopped being one (its `.lore` gone), is refused. A listed one writes `run.workspace`, `run.config` (= `placeConfig`) and `run.lore`.
  - `a folder put into Lore after /conduct counts`: a new Lore root under `game/code` is accepted by `run_workspace`.
  - `the pick may change until the plan is approved, then it is fixed`: a second `run_workspace` before `/approve` replaces the first. After `/approve` it answers `This run's workspace is fixed: the plan naming it is approved.`
  - `the home config edited after /conduct does not move the pick` **(Review Focus 4)**: `config.json` rewritten without `game/code` after `/conduct`. `run_workspace` still accepts a `game/code` root, because it rescans the places frozen in `run.config.places`.
  - `/approve names the workspace`: the approval prompt's text contains `game/code/Big Game 5.8`.
  - `the orchestrator is told to pick first`: the orchestrator's prompt (as `world` captures it) contains `This run's workspace is not picked yet.`, each candidate's root and about, and `If the work lies outside all of them, say so with board_post and propose no plan.`
- [ ] **Step 2: Run them and see them fail**: `claude plugin test .`.
- [ ] **Step 3: Implement it.** `run_workspace` rescans with `workspacesIn` over the places in `run.config.places`, never the live config. Then it calls `fixWorkspace` and writes through `mutate`. `run_plan` and `/approve` refuse while `run.candidates !== undefined && run.workspace === undefined`.
- [ ] **Step 4: Run the tests and see them pass**: `claude plugin test .`.
- [ ] **Step 5: Commit**: `git commit -m "run_workspace: the orchestrator picks the run's workspace before it plans"`

### Task 6: A folder home's backend is the bound run's workspace (Lore)

**Files:**
- Modify: `hooks/register.tsx` (`backendOf`, `bind`, the orchestrator prompt's workspace line)
- Test: `tests/folder-lore.test.ts`

**Interfaces:**
- Consumes: `Ledger['run'].workspace` (Task 1), `folderWorld` (Task 3).
- Produces: in a folder home, `backendOf($)` answers from the bound run's `run.workspace`:
  - git: `{ kind: 'git', root, remote }`;
  - Lore: today's `{ kind: 'lore', root, bin, info }` for that root.

  It answers `null` when no run is bound or its workspace is not picked. The cached value is cleared in `bind()`.

- [ ] **Step 1: Write the failing tests**. Each uses a bound, approved Lore run in `folderWorld` with `run.workspace.root = LORE_WS`.
  - `a worker's workspace is a copy of the run's workspace`: the copy program's source is `LORE_WS`, and the copy lands at `/work/game/code/Big Game 5.8.conductor/<run>/<task>`.
  - `the orchestrator's lore commands are guarded against the run's workspace`: the orchestrator's `lore branch merge x` is denied as today. `lore status` reaches the engine.
  - `a worker's lore line is pinned to its own workspace`: the worker's `lore status` reaches the engine as today's pin text, with its own workspace in `cd -- '...'`.
  - `the worker's brief comes from the home`: `/work/.claude/conductor/brief.md` text appears in the worker's brief.
  - `the orchestrator is told where the run works`: its prompt contains `- This run works in game/code/Big Game 5.8, a Lore workspace inside this home. Run its commands there: cd -- '/work/game/code/Big Game 5.8' first.`
  - `binding another run moves the backend`: bound to a run in `LORE_WS`, then `/board` binds a run in a second Lore root. A worker's copy then comes from the second root.
- [ ] **Step 2: Run them and see them fail**: `claude plugin test .`.
- [ ] **Step 3: Implement it** as in Interfaces. A repository home's `backendOf` stays as today.
- [ ] **Step 4: Run the tests and see them pass**: `claude plugin test .`.
- [ ] **Step 5: Commit**: `git commit -m "register: in a home that is not a repository, the run's workspace is where Lore work happens"`

### Task 7: Live check: does the engine take the mod's worktree in a git session?

Spec §5.6 asks for this before the git task builds on it.

**Files:**
- Create (scratchpad only, never committed): a throwaway mod and two throwaway git repositories, X and Y.
- Modify: `docs/superpowers/specs/2026-11-06-folder-home-design.md` §5.6 (one line recording the answer)

- [ ] **Step 1: Build the throwaway.** Make two git repositories, X and Y, in the scratchpad, each with one commit. Write a minimal mod whose `classic.WorktreeCreate` runs `git -C Y worktree add -b spike <Y>.wt HEAD` and answers `{ worktreePath: '<Y>.wt' }`.
- [ ] **Step 2: Run it**: from X, `claude -p --plugin-dir <mod> --model haiku "Start one background agent with isolation: \"worktree\" whose only job is to run pwd and report it, then report what it said."`. The pass condition: the agent reports `<Y>.wt`.
- [ ] **Step 3: Record the answer** in spec §5.6, then tell the owner which way it went. If the engine ignored the answer, Task 8 builds the refusal: `No run was started. This session is in the git repository <X>, and this run works in <Y>: start the session in the home folder, <home>.`
- [ ] **Step 4: Commit the spec line**: `git commit -m "docs: what the engine does with the mod's worktree in a git session"`. Delete the throwaway.

### Task 8: Git from a folder home

**Files:**
- Modify: `hooks/register.tsx` (`isAtForge`/`origin`, `workspaceFor`, `classic.WorktreeCreate`, removals, `config.base` call sites)
- Test: `tests/folder-git.test.ts`

**Interfaces:**
- Consumes: `backendOf` (Task 6), `workspaceOf`/`workspacesOf` (existing, `hooks/workspace.ts`), Task 7's answer.
- Produces:
  - `baseFor(ledger: Ledger | undefined): string` answers `ledger?.run.workspace?.base ?? config.base`. Each `config.base` call site that acts for a bound run uses it.
  - In a folder home, `isAtForge` reads `origin` from the run's backend remote.

- [ ] **Step 1: Write the failing tests**. Each uses a bound, approved git run in `folderWorld` with `run.workspace = { kind: 'git', root: GIT_WS, place: 'studio', base: 'main', remote: ORIGIN }`, and `engine.programs` answering `git`.
  - `owner and name come from the run's workspace`: the merge tool's GitHub calls go to `API` (`repos/acme/widgets`). This holds although `$.session.repo()` is null.
  - `a worker gets a worktree the mod made`: on the worker's start, the programs ran `git -C /work/studio fetch origin main`, then `git -C /work/studio worktree add -b <branch> /work/studio.conductor/<run>/<task> origin/main`, as argv. `classic.WorktreeCreate` answers that path and never calls `next`.
  - `a worktree that cannot be made says why`: `git worktree add` exits 128 with a message. The worker's start is refused, naming that line, and nothing is removed.
  - `a done task's worktree is removed with git worktree remove`: at the point where a Lore run removes a clean, pushed copy, the programs ran `git -C /work/studio worktree remove /work/studio.conductor/<run>/<task>`, without `--force`.
  - `a place's base is the run's base`: with `base: 'master'`, the orchestrator's `git push origin master` is denied naming `master`, and the worktree starts from `origin/master`.
  - If Task 7 failed: `a session in another git repository is refused for a run elsewhere`. With cwd and gitRoot `/work/other`, `/conduct ABC-12` answers Task 7's refusal text.
- [ ] **Step 2: Run them and see them fail**: `claude plugin test .`.
- [ ] **Step 3: Implement it.** `workspaceFor` dispatches on the backend's kind: Lore as today, git through a new `prepareGitWorktree($, making)` that runs the two git commands above. `classic.WorktreeCreate` hands back a prepared git worktree exactly as it hands back a Lore one. In a repository home, git still goes to `next(e)`.
- [ ] **Step 4: Run the tests and see them pass**, with all old tests untouched: `claude plugin test .`.
- [ ] **Step 5: Commit**: `git commit -m "git: a home that is not a repository makes its workers' worktrees itself"`

### Task 9: Board, README, and the end check

**Files:**
- Modify: `hooks/board.ts` or `hooks/dashboard.ts` (the workspace line, wherever the run's header is drawn)
- Modify: `README.md` (a section "A home that is not a repository": the config of spec §5.2, the placeholder, what a folder home does and doesn't do)
- Test: `tests/board.test.ts` (one test)

- [ ] **Step 1: Write the failing test**. `the board names a folder-home run's workspace`: the board's text for a run with `run.workspace.place = 'game/code'` contains `game/code/Big Game 5.8`. A repository-home run's board is unchanged (the existing tests).
- [ ] **Step 2: Run it and see it fail, implement it, and see it pass**: `claude plugin test .`.
- [ ] **Step 3: Write the README section**, using the public example names only.
- [ ] **Step 4: Check everything:**
  - `claude plugin test .`: all pass, and the count is 533 plus the new ones.
  - `claude plugin validate .`: clean.
  - `git diff main --stat -- tests/` shows old test files changed only in the additive world fixtures: `world.ts` and the new files.
  - The private-name scan (its word list is kept outside the repository, in the progress ledger) finds nothing in this branch's changes.
- [ ] **Step 5: Check it by hand.**
  1. Make a scratch folder home: `<scratch>/home/.claude/conductor/config.json` with one place `studio` (team `ABC`), and `<scratch>/home/studio` a git repository.
  2. Run `cd <scratch>/home && claude -p --plugin-dir <this repository> "/conduct"`. Expected: the output starts with `Say what the run starts from:`.
- [ ] **Step 6: Commit**: `git commit -m "board and readme: a home that is not a repository"`. Then report to the owner. Ask before any push.
