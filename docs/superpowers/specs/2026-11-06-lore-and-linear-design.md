# Lore and Linear in conductor: design

Date: 2026-11-06. Status: draft, waiting for the owner's approval.

## 1. Why

conductor runs larger work in Claude Code. One session orchestrates, workers build one task each, and a merge loop lands what is green. Today it knows only git and GitHub. It finds the project through git, gives each worker a git worktree, takes tickets from GitHub issues and merges through GitHub pull requests and checks.

The owner keeps their game projects in **Lore**, Epic's open-source version control system, and their tickets in **Linear**. In a Lore workspace conductor stays switched off, because there is no git repository. So the owner can't use it on the work it was made for.

This change adds Lore and Linear to the original conductor as features, next to git and GitHub. Nothing in it is specific to one project or one studio, so anyone with a Lore workspace or a Linear team can use it.

## 2. Goals, non-goals, anti-goals

Goals:

- In a Lore workspace, conductor works as it does in a git repository: board, plan gate, router, messaging, problems, pause and auto-compaction.
- A run can start from a Linear issue (`/conduct ABC-12`), the same way it starts from a GitHub issue (`/conduct #12`) today.
- Each worker builds in a Lore workspace of its own, on a branch of its own, without filling the disk.
- A green task is merged into the run's branch by the mod, pinned to the revision that was judged. The run's branch goes into the base branch only after the owner has approved that exact revision.
- Everything that works for git and GitHub today keeps working unchanged, and its tests pass untouched.

Non-goals:

- No CI integration for Lore (for example Horde). There is no check service to read yet. An optional check command per project stands in for it.
- No change to the GitHub merge loop's behaviour.
- No project- or studio-specific code, and no dependency on any other tool of the owner's.
- conductor does not build or run the project itself. It only runs the project's check command when one is configured.

Anti-goals (a failure even if everything else works):

- Anything reaching the base branch without the owner's approval of that exact revision.
- conductor changing the owner's own workspace: it never commits, syncs, switches branch or writes files there.
- Filling the disk. A large workspace (the first real user's is about 96 GB on disk) can't be copied whole for each worker.
- Untracked local files of the owner's workspace (local secrets, logs, saves) ending up in a worker's workspace. The same goes for a Linear key in the ledger, a message or a log line.
- A merge conflict resolved by picking a side, above all on a binary file.
- Private names (servers, teams, projects) in this public repository: code, docs, tests and fixtures alike.

## 3. Constraints

- Lore CLI 0.12 (`lore`, pre-1.0, its output can change between releases). It has branches (`lore branch create|switch|merge|protect|archive|info|list`), revisions with 64-hex ids, `lore lock` for files, sparse views and a shared local store. There are no pull requests and no checks.
- The mod API (function hooks) is early access. This build: Claude Code 2.1.317/2.1.318. What the API offers and this design relies on:
  - `$.session.repo()` answers git repositories only. In a Lore workspace it answers nothing.
  - `$.session.cwd()` gives the session's folder, and `$.fs.exists` can look for a `.lore` folder above it.
  - `$.process.run(argv, { cwd, env, stdin, timeoutMs })` runs a program without a shell, for at most 10 minutes, with up to 4 MiB of output.
  - A mod can answer the `classic.WorktreeCreate` event with `{ worktreePath }`. This is Claude Code's hook for creating a worker's isolated copy in a version control system other than git, with `classic.WorktreeRemove` for removing it.
  - `$.http.fetch` reaches Linear's GraphQL API.
- The owner's machine has about 95 GB free. One full clone of the first real project would take most of that.
- The ledger format stays `version: 1`. Old ledgers must still read. New fields are optional.

## 4. Decided by the owner

- Tickets come from Linear. A run starts from a Linear issue.
- Code lives in Lore, and conductor treats Lore like git: branches, review, a protected base branch, and no merge into it without approval.
- These changes go into the original conductor as features, not into a fork.
- Each worker gets a workspace of its own on a branch of its own. It never works in the owner's workspace or another worker's.
- Lore has no checks yet. A task counts as green once the orchestrator has reviewed it and, if the project names a check command, that check has passed.
- Merging has two levels. Each run gets its own branch. A green task's branch is merged into the run branch by the mod when the orchestrator asks, with no person needed. Only the run branch goes into the base branch, and only after the owner approves that exact revision with a command (working name `/approve-main`). Anything pushed to the run branch after the approval needs a new approval.
- Workspaces are made cheap on disk. The first choice is a copy-on-write copy of the owner's workspace (APFS clones cost almost nothing until files change), measured before it's relied on.
- conductor is for sessions the owner conducts. It stays separate from any other agent setup the owner runs.

## 5. How it works

### 5.1 Which backend

Two independent choices are made for each repository:

- **Code:** `git` (today's behaviour, with GitHub or "elsewhere") or `lore`.
- **Tickets:** `github` (today's behaviour) or `linear`.

When a session starts, the mod asks `$.session.repo()` first. If that answers nothing, it looks upward from `$.session.cwd()` for a folder that holds `.lore/`, and that folder is the workspace root. As today, the mod does nothing until `<root>/.claude/conductor/` exists. For a Lore root it reads `lore repository info` once: the remote URL, the repository name and the default branch.

The ticket backend follows the run's source: `#12` is a GitHub issue and `ABC-12` is a Linear issue. A project can also fix it in its config (5.10). Linear works with both code backends. With git, a Linear issue is moved to Done after its merge, because GitHub's "Closes #N" can't close it.

### 5.2 Tickets in Linear

- `/conduct ABC-12` starts a run from that Linear issue. Other words still become the title, and `id=<name>` still names the run.
- A task's `ticket` takes a Linear key as well as a GitHub number (`number | string`). The tools, the board and the handover accept and show both.
- New tools for the orchestrator, backed by Linear's API:
  - read a ticket: its title, description, state, sub-issues, links and comments;
  - file a drafted ticket as a sub-issue of the run's issue, refused until the plan is approved (the same rule `plan.ts` states today);
  - nothing else that writes.
- The mod moves states itself, by state type and not by name, since each team names its states its own way:
  - the run's issue goes to started when the plan is approved;
  - a task's issue goes to started when its worker starts;
  - a task's issue goes to completed when it is merged into the run branch;
  - the run's issue goes to completed when the run is merged into the base branch.

  When a team has several states of one type, the mod takes the first by position. A failed Linear call never stops the run. It is recorded once as a warning problem.
- A run from a spec document has no issue of its own. With Linear tickets it needs `linear.team` in the project config, and `/conduct` refuses without it. After the plan is approved, the mod files a parent issue for the run in that team (the run's title, linking the spec) and files the drafted tickets as its sub-issues.
- The key comes from the mod's new option **Linear API key** (sensitive, kept in the system's secure storage), then from the `LINEAR_API_KEY` environment variable. It goes into a request's header and nowhere else.

### 5.3 Branches (Lore)

- **Base branch:** the existing option, or the repository's default branch when the option is left empty. It is protected with `lore branch protect`.
- **Run branch:** `<prefix><ticket or run id>-<short title>`, created from the base branch's latest revision when the owner types `/approve`. The prefix comes from the project config and defaults to `conductor/`.
- **Task branch:** `<run branch>/<task id>`. It is created from the run branch when the task's worker starts, or from another task's branch when the task builds on that one (today's "starting on green", unchanged in meaning).
- Task branches are archived after the run is merged into the base branch. Run branches are kept.

### 5.4 Worker workspaces (Lore)

The orchestrator starts each worker as today, with `isolation: "worktree"`. In a bound session with the Lore backend, the mod answers `classic.WorktreeCreate`. It makes the worker's workspace and answers its path. Anywhere else it passes the event on, so git works exactly as before.

What a worker's workspace holds:

- the tracked files of its task branch at that branch's latest revision;
- the ignored folders the project names in `carry` (for an Unreal project, for example, the build caches that make a first build fast), and nothing else that is untracked or ignored. That keeps local secrets, saves and logs out.

How it's made:

- The first choice is a copy-on-write copy of the owner's workspace, turned into a Lore workspace of its own (its own instance), then synced to the task branch with local changes reset.
- Spike 2 (section 7) showed that a copy becomes a safe separate workspace, so the fallback (a sparse `lore clone --view` through Lore's shared store) is not built.
- The copy may be taken while the owner is mid-edit. Syncing to the branch with local changes reset means the owner's unsaved or uncommitted edits never carry over. A carried cache folder may be caught mid-write, which is harmless for a cache.

Spike 1 passed (section 7), so no fallback path is built. One safety net stays: in a Lore run, a worker that has no workspace of its own has its Edit, Write, NotebookEdit and Bash calls refused, with the reason that it was started without `isolation: "worktree"`. So a worker never builds in the owner's workspace.

Rules:

- Workspaces live under the project's `workspaces` folder. The default is `<parent of root>/<root name>.conductor/<run id>/<task id>`, always outside the owner's workspace.
- Before making one, the mod checks free disk space and refuses below `minFreeGB` (default 20). The refusal comes back to the orchestrator in the start's result.
- A workspace is removed when its task is done (Claude Code sends no `classic.WorktreeRemove` for it), but only if its branch is pushed and `lore status --scan` shows it clean. Then everything in it is in Lore apart from regenerable build output. Otherwise it is kept, and the orchestrator is told why.
- The mod also keeps a **run workspace** on the run branch, made the same way. Merges happen there, never in the owner's workspace.

### 5.5 Hand-back and green (Lore)

- A worker stages, commits and pushes its own task branch with the Lore CLI, as often as it finishes a green step. Then it sets the task to review with its `branch` and the pushed `revision` (a new optional task field, 64 hex), and hands back. The `pr` field stays GitHub's.
- Binary files can't be merged. When the project config lists `lockPatterns` (for example `*.uasset`), the brief tells the worker to `lore lock` each matching file before changing it. The mod releases the task's locks once the task is merged or given up.
- The orchestrator judges the hand-back as today: review, green, blocked or failed.
- A task with no code to push (research, a ticket only) has no branch and no revision. The orchestrator sets it to done itself, as it does today for a task with no pull request.
- If the project config names a `check` (an argv plus a time limit), a merge needs a passing check on the task branch's current head. The mod runs it in the task's workspace and records the result with the revision it ran on. A run can last longer than `$.process.run`'s 10 minutes, so how it runs detached and reports back is the builder's call. The board shows "checking" meanwhile.

### 5.6 Merging a task into the run branch (Lore)

`merge_check` and `merge` keep their names and their contract: check reads only, merge checks the same things and then merges. For a Lore task they hold when:

- the task is green and not paused, everything it waits for is merged, and no problem found under it waits for a decision (as today);
- no other merge is in flight, in this run or another run of the repository (as today);
- the task branch's latest revision is the one recorded at review, and the check passed on it when one is configured. This is the pinning, Lore's counterpart of GitHub's `sha`.

The merge runs in the run workspace: sync to the run branch's latest, `lore branch merge <task branch>`, then push. On a conflict the mod aborts the merge, leaves the run branch as it was and names the conflicting files. The task goes back to the orchestrator, with a note, as blocked. The mod never resolves a conflict itself. When the merge succeeds, the task is done, `mergeCommit` holds the run branch's new revision, and its Linear issue moves to completed.

### 5.7 Merging the run into the base branch (Lore)

- When every task is done and no blocker or warning is open, the board shows the run as ready for the base branch, with the run branch's revision. The orchestrator tells the owner in a line or two what changed and how to try it. If a check is configured, it has to have passed on that revision.
- The owner types `/approve-main` (working name). It records the approval in the ledger with the time, the run branch revision it covers and the base branch revision it was made against. Then it merges the run branch into the base branch, pinned to that revision.
- If the run branch's head is no longer the approved revision, the merge is refused and a new approval is needed.
- If the base branch has moved since the approval (another run was merged meanwhile, for example), the merge is refused too: merging into a newer base would land a result nobody approved. The orchestrator then has the mod merge the base branch into the run branch, in the run workspace, with the same conflict rule as 5.6. That gives the run branch a new head, so a new approval is needed.
- Only a person can type the command. No tool lets the orchestrator or a worker merge into the base branch.
- After the merge the run's Linear issue moves to completed, task branches are archived, and clean workspaces are removed.

### 5.8 Guards in a bound session (Lore)

The git guards stay. For Lore, a by-hand command is refused when it would:

- push the base branch or the run branch;
- push any task branch other than the worker's own;
- merge branches;
- protect or unprotect a branch, or archive one.

The mod knows which worker a call comes from, as it does today when it records a worker's activity, and a task branch's name is derived from the run branch and the task id. Like today's guards, these read the command's text, and the README's limits say so.

### 5.9 Words the model and the owner read

The orchestrator's instructions, the worker brief, the board, the handover and the "after a restart" text all say "branch and revision" instead of "pull request" for a Lore task. They name the Lore commands a worker uses (`lore status --scan`, `lore stage`, `lore commit`, `lore push`, `lore diff`) instead of git's. The GitHub and git wording stays as it is.

### 5.10 Options and project config

- New mod options: **Linear API key** (sensitive) and **Lore program** (the lore binary's path). The existing options stay. `mergeMethod` is GitHub's only.
- New optional per-project file `.claude/conductor/config.json`. Every field is optional, and it can be committed with the project:
  - `tickets`: `"github"` or `"linear"`, to fix the ticket backend;
  - `linear.team`: the team key a run's issue must belong to;
  - `lore.branchPrefix`, `lore.workspaces`, `lore.carry`, `lore.minFreeGB`, `lore.lockPatterns`;
  - `check`: `{ "argv": [...], "timeoutMin": N }`.
- The config is read once, at `/conduct`, from the session's root (where `brief.md` is read today), and frozen in the run's ledger. A branch that changes `config.json` doesn't change the run it's part of, so a worker can't make its own task green by editing `check`. The check still runs the code on the task branch, as any CI does. The orchestrator's review covers changes to the scripts a check runs.
- In a Lore project the README says to add `.claude/conductor/runs/` to `.loreignore`, the counterpart of `.gitignore` today. `/conduct` refuses with that instruction when the runs folder isn't ignored.
- A Lore project also declares the placeholder WorktreeCreate hook in its own settings (section 7, finding 1). `/conduct` refuses with the exact snippet when it's missing.

## 6. Testing

- The existing test suite passes unchanged.
- New tests use a pretend Lore and a pretend Linear, the way the tests use a pretend GitHub today. The pretend Lore answers `$.process.run` from output captured from real `lore` 0.12 runs, with private names replaced (`lore.example.test`). The pretend Linear answers in the shapes of Linear's documented GraphQL API.
- The README's rule holds: break a copy of the mod and show that the new tests fail.
- **Live end to end**, before the change is called done:
  - against a throwaway Lore repository on the owner's server and a throwaway Linear issue, a run with two tasks: plan, approve, two workers in workspaces of their own, hand-back, both merged into the run branch, `/approve-main`, merged into the base branch;
  - plus a conflict, and a revision that moved after approval;
  - then the first real use on the owner's project, with the owner.

## 7. Spikes, settled on 2026-11-06

Run in throwaway folders, a throwaway Lore repository and a throwaway mod, with Lore 0.12.0 and Claude Code 2.1.318. The plan relies on these findings.

1. **Worker workspaces through `classic.WorktreeCreate`.**
   - In a session outside git, an agent started with `isolation: "worktree"` fails with "not in a git repository and no WorktreeCreate hooks are configured" unless a WorktreeCreate hook is configured in settings.
   - With one configured, the mod's `classic.WorktreeCreate` hook runs first. Its `{ worktreePath }` is used, and the worker runs in that folder.
   - The placeholder can't ship in the mod's own `hooks.json`. With it there, a git repository fails ("hook is configured but did not run") when the mod answers `{}`. So the placeholder goes in the Lore project's own settings (`.claude/settings.json` or `.claude/settings.local.json`), as a command hook that fails with a message saying conductor makes the workspaces. In a git repository with no placeholder, the mod answers `{}` and Claude Code makes its git worktree as before.
   - The event's `name` is `agent-<agent id>`, not the task's name. `agent.spawn` fires about 10 ms before it and carries no `isolation` field.
   - `classic.WorktreeRemove` did not fire for a workspace the mod made. The mod removes its workspaces itself (5.4).
2. **Copy-on-write workspaces.**
   - `cp -c -R` of the real 96 GB workspace (165,000 files; `Saved` and `.idea` left out) took 46 s and about 130 MB of disk.
   - `lore repository update-path` in the copy registers it under its own path and leaves the original's registration alone.
   - `lore status --scan` of the copy took 3 s and showed it in sync, with no changes.
   - In the throwaway repository, the copy and the original stayed independent: branches, commits and files didn't cross. The copy keeps the original's instance id, with no effect seen in 0.12.
   - The fallback (5.4) is not needed.
3. **Branches.**
   - Names with `/` work (`conductor/S-1-spike/t1`).
   - `lore branch create <name>` branches from the workspace's current revision and switches to the new branch.
   - The first `lore push` creates the branch on the server.
   - Revision numbers count per branch (two task branches can both be "revision 2"), so the mod pins the 64-hex signature.
4. **Protection.**
   - `lore branch protect <base>` holds without sign-in. A direct push and `lore branch merge into <base>` are refused with "Not authorized to access repository" (exit 17).
   - Protection can't be read back from any command, and anyone can `unprotect`, so it guards against accidents only.
   - The mod's merge into the base: `lore branch unprotect <base>`, then `lore branch merge into <base> "<message>"` from the run workspace on the run branch (a server-side merge that prints the new `Signature`), then `lore branch protect <base>`, always, even after a failure.
5. **Merging.**
   - `lore branch merge <source> --message "<m>"` merges into the current branch and commits locally ("Committed merged repository state N -> <signature>"). `lore push` sends it.
   - A conflict still exits 0. It prints "N conflicted" and a "Files in conflict:" list, and `lore status` then shows "Pending merge" and "Changes in conflict". The mod reads the output, never the exit code alone.
   - `lore branch merge abort` reverts to the revision before the merge.
6. **Revisions.**
   - `lore branch info [<branch>]` prints `Latest:` (local), `Remote Latest:` (server) and `Parent:`. A branch never synced locally shows 64 zeros as `Latest`.
   - The mod reads `Remote Latest`.
   - `lore status` prints "On branch <b> revision N -> <signature>" and "Local branch in sync with remote".
   - A push to a branch whose server head moved fails with "Branch has diverged" (exit 255).
7. **Tracked and untracked files.** There is no command that lists tracked files. `lore status --scan` lists untracked files that are not ignored ("Untracked files:"). Ignored files show nowhere. So a worker's copy:
   - leaves out every top-level entry the root `.loreignore` ignores, unless `carry` names it;
   - removes from the copy the nested paths `.loreignore` ignores, unless `carry` names them;
   - deletes what `lore status --scan` lists as untracked;
   - syncs to its branch with `--reset`.
8. **Linear.** These request shapes are proven by a working client against Linear's API:
   - a POST to `https://api.linear.app/graphql` with the key as the bare `Authorization` value (no `Bearer`);
   - `issue(id: "ABC-12")` takes the key;
   - a team's states are `team.states { nodes { id name type position } }`;
   - `issueCreate(input: { teamId, title, description, parentId, stateId })` and `issueUpdate(id, input: { stateId })`.
9. **The Lore binary.** A host program such as the desktop app may not have `~/.local/bin` on its PATH. The mod runs the path in its own **Lore program** option, or `LORE_BIN`, when either is set. Otherwise it runs `lore` and then `$HOME/.local/bin/lore` (where Epic's install script puts it). The project config never names the program: a repository could name any program, and the mod would run it when a session opens (a security review finding, 2026-11-06).

## 8. Calls I made (the owner checks these)

- The ticket and code backends are independent, so Linear also works with git and GitHub.
- The mod moves Linear states itself (started, completed), as a GitHub merge closes its issue.
- Run branch prefix `conductor/` by default; the project sets its own.
- Workspaces live outside the owner's workspace. Only tracked files plus a named `carry` list go in, so untracked local files never do.
- A clean, pushed workspace is removed when its task is done, and any other is kept.
- 20 GB minimum free disk before a new workspace, configurable.
- Task branches are archived after the run reaches the base branch.
- If the base branch moves after `/approve-main`, the merge is refused, the base is merged into the run branch, and the owner approves again. This follows from "exact revision": nothing unapproved reaches the base branch.
- The project config is frozen at `/conduct`, so branches can't change their own rules.
- A Linear run from a spec needs `linear.team` and gets a parent issue the mod files after approval.
- A task with no code is set to done by the orchestrator, as today.
- A worker in a Lore run without a workspace of its own has its write and Bash calls refused (the spikes made a fallback unnecessary).
- The work happens on the branch `feature/lore-linear` of the conductor repository. It is pushed and offered as a pull request only when the owner says so.

## 9. Left to the builder

- How backends are split in the code (an interface per backend, or functions chosen by the backend).
- How a long check runs detached and reports back within the mod API's limits.
- The exact Linear GraphQL queries and Lore commands, from the spikes.
- Board layout details for branch and revision.
- The final name of `/approve-main`.
