# conductor

A Claude Code mod for work that is too large for one session. One session becomes the **orchestrator**: it slices the work into tasks, and the mod starts one **worker** agent per task, each in its own git worktree, on a model you can see and change. A live **run board** shows where every task stands. Findings and questions travel between the workers through the board, and the orchestrator's context is compacted before it fills up. Each green pull request is merged on **GitHub**, pinned to the commit whose checks the mod just read, one at a time.

It is built on Claude Code's mod API (function hooks), which is early access and changes between releases. This version was built and tested on Claude Code 2.1.317.

## Install

At the prompt of a terminal session:

```
/plugin install conductor --marketplace woorari/conductor
```

From a shell:

```bash
claude plugin install conductor --marketplace woorari/conductor
```

Answer `y` to add the marketplace, then pick a scope (the user scope loads it in every session). The install asks for three options; all of them can stay as they are.

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `woorari/conductor`, then **Add plugin**.

### Turn it on in a repository

The mod does nothing in a repository until it has a `.claude/conductor/` folder:

```bash
mkdir -p .claude/conductor
```

Keep the run ledgers out of git. They are rewritten every few seconds while a run is live:

```bash
echo '.claude/conductor/runs/' >> .gitignore
```

Optionally, write `.claude/conductor/brief.md`: your project's own rules for every worker (how to run the tests, what never to touch). `brief/example.md` shows the idea.

### The GitHub token

The merge loop reads pull requests and checks, and merges, through GitHub's REST API. It takes the first token it finds:

1. The mod's **GitHub token** option. It is kept in your system's secure storage, never in a settings file.
2. The `GH_TOKEN` environment variable.
3. The `GITHUB_TOKEN` environment variable.
4. `gh auth token`, if you are signed in with the GitHub CLI.

A fine-grained token needs, for the repositories you run in: Metadata (read), Pull requests (read), Checks (read), Commit statuses (read) and Contents (read and write, because a merge writes to the base branch). A classic token needs `repo`.

The token goes into a request's header and nowhere else: not the ledger, not a message, not a log line of the mod.

### Options

| Option | Default | What it does |
|---|---|---|
| GitHub token | empty | See above |
| Base branch | `main` | The branch a run's pull requests merge into |
| Merge method | `merge` | `merge`, `squash` or `rebase`, as GitHub merges a pull request |

## Using it

1. **Start a run.** `/conduct #12` starts a run from issue 12; `/conduct docs/specs/export.md` starts one from a spec document. Any other words become the run's title: `/conduct #12 Retry the flaky upload`. `id=<name>` names the run yourself. The session is now bound to the run, and the orchestrator is asked for a plan.
2. **The plan.** The orchestrator reads the source and adds tasks with `task_add`. Each task has a title, a model tier and the reason for it, the files it is expected to change, and what it waits for. A task is at most 12 files or folders: one change one worker can finish as one pull request. The mod checks the plan for tasks that could run at the same time on the same file.
3. **Approve.** The orchestrator proposes the plan with `run_plan` and stops. `/approve` lets the workers start. `/tier <task> <opus|sonnet|haiku>`, or the picker in the pane, changes a task's tier before it starts. Your choice stands.
4. **Workers.** The orchestrator starts each worker as a background agent in a worktree of its own, named after its task. The mod starts it on the task's tier whatever model the call asks for, briefs it (its task, the rules, your `brief.md`), and records what it is doing. At most 3 workers build at once, or what the run's `maxParallel` says.
5. **The board.** `/board` opens the pane: problems, what needs a decision, each worker on a time axis, and what is building, handed back, next and ready to merge. `/board <run>` binds the session to another run, and `/board none` lets go.
6. **Hand-backs.** A worker opens a pull request, sets its task to review and hands back. The orchestrator judges it: review, green, blocked or failed.
7. **Merge.** A green task's pull request is merged with `merge` (see below). A task with no pull request the orchestrator sets to done itself.
8. **Hold.** `/pause` holds the run: no worker starts and nothing merges, and what is under way finishes. `/unpause` lets it go on. `/rotate` compacts the orchestrator's session now.

A run lives in `.claude/conductor/runs/<run id>/`: its `ledger.json`, and `handover.md` once the session has been compacted.

### Commands and tools

| Command | What it does |
|---|---|
| `/conduct <#issue or spec> [title]` | Start a run and its plan |
| `/board [run id \| none]` | Show the board; bind to a run, or let go |
| `/approve` | Approve the plan, so workers may start |
| `/tier <task> <tier>` | Set a queued task's model tier |
| `/pause`, `/unpause` | Hold the run, and let it go on |
| `/merged <task>` | Mark a task done by your word: its pull request is merged |
| `/rotate` | Compact the orchestrator's session with a handover now |

The orchestrator and the workers change the board only through the mod's tools: `task_add`, `task_update`, `run_plan`, `board_post`, `board_rule`, `board_read`, `problem_report`, `problem_resolve`, `problem_assign`, `merge_check` and `merge`.

## Features

### The run board

`/board` opens the **Run board** pane. In the desktop app it is one picture: the run's progress and time, the open problems, what needs your decision, each worker as a lane on a time axis, and what is building now, handed back, up next and ready to merge. A terminal draws the same board as text. In the desktop app, each queued task (up to 8) has a picker for its model tier under the picture; `/tier` sets any queued task's tier.

- The pane reads the run's ledger every 2 seconds. It costs no model tokens, and an "Updated HH:MM" line says when the ledger was last written.
- A building worker shows what it was last seen doing and how many tokens its context holds. One with no sign of life for 10 minutes is called silent.
- The orchestrator's own line says how full its context is and how often it was compacted: `Orchestrator 43% full · compacted twice`, or `compaction waits` when a compaction is due and has not gone through.
- The mod alone writes the ledger. The orchestrator and the workers change it only through the mod's tools, and its hooks record each worker's start, activity and hand-back.

### Planning and approval

- `/conduct` starts a run with its plan in draft and asks the orchestrator to plan it.
- The orchestrator slices the work with `task_add`: each task is at most 12 files or folders, with its ticket, the files it is expected to change, what it waits for, and a model tier with the reason for it.
- The plan check lists open tasks that could run at the same time on the same file, and tasks that name no files. `board_read` shows what it still finds, under "Plan check".
- `run_plan` proposes the plan, and no worker starts before `/approve`.
- For a run from a spec, the orchestrator drafts the tickets the spec needs and files them only after your approval, recording each number with `task_update`.

### Workers and the model router

In a session bound to a run, every agent the orchestrator starts goes through the router:

- A task's worker starts on its task's tier (opus for architecture and design, sonnet for challenging development, haiku for easy jobs), whatever model the call asks for. A tier you set stands.
- A worker's own subagents never run on a dearer tier than the worker. Read-only helpers (Explore, Plan, claude-code-guide) start without a task.
- Any other agent is refused, as is a worker for a task that is done, already building, or waiting for a task that is not green yet. A start is also refused while the run's limit of workers building at once is reached, and while a worker that is building already changes one of the task's files.
- Each worker gets the lowest free number (1, 2, 3) and a briefing: its task, how to report, the rulings and findings that concern it, and your `.claude/conductor/brief.md` with `{task}`, `{slot}` and `{run}` filled in.
- Workers started in one message are decided one after another, each against a board that already counts the ones before it.

### Starting on green

A task starts once everything it waits for is green (reviewed, its checks green) or done: it does not wait for the merge. When what it waits for is green and not merged yet, its worker is told to build on that task's branch, and the task records which one it was built on. A worker builds on one unmerged branch only, and a task is merged only after everything it waits for is merged. Setting a task green answers with what can start now.

### Board messaging

- A **finding** (`board_post`, with the files it concerns) reaches only the workers on those files.
- A **question** reaches the orchestrator, and wakes it if it is idle. Its numbered **ruling** (`board_rule`) goes back to the workers it binds.
- Two open tasks whose workers change the same file are flagged once, to both workers and the orchestrator. Tasks in order by the plan (one waits for the other) are flagged only when both workers are at work at once.
- The mod sends no messages. News reaches each reader with the result of its own next tool call, and a stopped worker reads its news when the orchestrator starts it again.

### Problems

A **blocker** or a **warning** (`problem_report`) belongs to the run until a task of the run has dealt with it. A **note** is for the record.

- A problem gets its task in one of two ways: a task added for it (`task_add` with `addresses`), or a task the run still conducts (`problem_assign`, by the task or by its ticket).
- The orchestrator is told when a worker reports one (woken for a blocker), when the task that was to fix it is done or given up, and when every task is done and one is still open.
- A problem nobody deals with is asked about again every 30 minutes, while the run is approved, not paused and not finished.
- A task is not merged while a problem found under it waits for that decision: it still holds and gets a task, or it does not and is resolved.
- `problem_resolve` is refused while the problem's task still goes on, unless the orchestrator says it turned out to be no problem (`dismiss: true`).

### Merging on GitHub

`merge_check` says what stands in the way and changes nothing. `merge` checks the same and then merges. A merge goes ahead only when all of this holds, read from GitHub at that moment:

- The task is green, is not paused, and everything it waits for is merged.
- The pull request is open, not a draft, and into the base branch.
- GitHub says it is mergeable. A conflict, branch protection that blocks it, or a branch that is behind (where protection wants it up to date) is said in GitHub's own terms.
- Every check on its head has passed: check runs (GitHub Actions among them) and commit statuses alike. A check that is still running, or no check at all, is no verdict. `neutral` and `skipped` count as passed. Any other ending counts as failed.
- The checks on the base branch have not failed. Checks still running there hold nothing. A failure there holds every merge except the one that repairs it, which says so with `onRedMain: true`.
- Its description closes exactly the issues the merge was said to close. A "Closes #N" inside backticks closes nothing.
- No other merge is in flight, in this run or another run of this repository.

The merge call is pinned to the head whose checks were read (`sha`), so GitHub refuses it if anything was pushed in between. The task is done once GitHub has merged it. After that, the mod watches the checks on the base branch: a failure is recorded once, as a blocker, and the orchestrator is told. A pull request someone merged by hand is taken over, with no merge call.

In a bound session, a merge by hand is refused: `gh pr merge`, a call to GitHub's merge endpoint, or a `git push` to the base branch. Workers never merge.

**Elsewhere.** In a repository whose `origin` is not on github.com, the board, the plan, the router, messaging, pause and auto-compaction all work, but the mod asks GitHub nothing. There, a pull request is merged by that repository's own path, and you close its task with `/merged <task>`.

### Pause

`/pause` holds a run: the mod starts no worker and merges nothing, whatever the orchestrator does. Workers that are building finish and hand back, and a merge in flight is still settled with GitHub. `/unpause` lets the run go on: the orchestrator is woken, reads the board and carries on. The pause is in the ledger, so it outlives a restart.

### Auto-compaction

A long run fills the orchestrator's context. The mod compacts it before it is full, and brings the run's state back from the ledger rather than trusting the summary with it.

- **When.** The mod reads how full the orchestrator's context is after each of its turns, and about every 30 seconds during a long one. At 70% a compaction is due. It is made only between turns, never during one. During a long turn the orchestrator is told once to finish the step it is on and end its turn.
- **How.** The mod writes `handover.md` beside the ledger, with every task and its worker, the open problems and questions, the rulings and what has not been read yet. It then compacts the session with instructions to leave the run's state out of the summary. Right after the summary, it adds the state as the ledger has it. Where the session refuses that, the orchestrator gets it with its next tool result.
- **Where.** In a terminal session the mod asks the engine for the compaction. In the desktop app or an SDK host the engine has no such call, so the mod runs `/compact` for you, as a turn of its own once the session is idle, and checks that the context actually got smaller.
- **When it does not go through.** If the engine skips the compaction, the mod asks again in 10 minutes. If `/compact` fails, or leaves the context no smaller, the mod waits 10 minutes too. Any other failure is tried again in 30 seconds. The board shows `compaction waits`, the ledger keeps the reason, and the mod says it once. Your own `/compact` works meanwhile.
- **Any compaction.** Your own `/compact` and the engine's own automatic compaction get the same treatment in a bound session: the summary leaves the run's state out, and the ledger's state follows it.
- **Not for a finished run.** A run whose tasks are all done, and a session bound to no run, are not compacted: `/rotate` compacts one now all the same.
- **Workers.** When a worker's own context is compacted, its briefing is added back, so it keeps its task and what the board holds for it. A run can set `workerHandbackTokens`: a worker whose context holds more is asked, once, to commit and push at its next green step, note where it stopped, and hand back. A fresh worker then goes on from its branch.

### After a restart

The session's binding to its run is kept in the mod's own store under the session's id, for 30 days, and taken up again when the session starts. A worker whose session was restarted is listed with its agent id, so the orchestrator can start it again by that id.

### Run settings

A run's ledger takes two settings of its own: `maxParallel`, the most workers building at once (3 when absent), and `workerHandbackTokens` (above).

## What it never does

- It starts no agent and sends no message by itself.
- It merges only when the orchestrator calls `merge`. Its timer only reads.
- It stores no command text or message, only which tool ran, a file name, or a command's description.
- It writes the GitHub token nowhere.

## Limits

- **GitHub only.** github.com only, not GitHub Enterprise Server, and one base branch per installation.
- **No deploy watch.** Nothing is deployed or watched beyond the checks on the base branch: "done" means merged.
- **Partial checks.** A commit with more than 100 check runs (one page) is never called green.
- **One gap remains.** Between the mod's look and its merge, a push by someone outside the mod can still land. The pinned `sha` refuses a moved head, but not a moved base.
- **Worktrees aren't checked.** The mod tells the orchestrator to start each worker in its own worktree, but does not check that it did.
- **Hand-back limit.** A worker is asked to hand back early only once its context passes the run's `workerHandbackTokens`. The mod cannot see how large a worker model's window is.
- **Guards read text.** The by-hand guards read a command's text: a merge hidden inside a script is not seen.

What has been seen for real: the board, the plan gate, the router, messaging, pause and auto-compaction, in real runs on a Forgejo-based ancestor of this mod. What has not: the GitHub merge loop against GitHub itself. Its request and response shapes are checked against GitHub's documented API in the tests (a pretend GitHub), and its readers against real answers of GitHub's API, but no merge has been made through it yet.

## Developing

Clone the repository and load it from its folder for one session:

```bash
claude --plugin-dir /path/to/conductor
```

In the desktop app, name the folder in the `env` block of `~/.claude/settings.json` as `CLAUDE_CODE_PLUGIN_DIRS`, and start a new session.

Validate and test it with the engine your sessions run on:

```bash
claude plugin validate . && claude plugin test .
```

Once Claude Code has loaded the mod, it lays its type declarations in `.claude-plugin/types/`, and `tsc -p .` type-checks the mod and its tests.

Rules the engine holds a hooks module to, each learned by breaking it:

- `$` is passed only to functions declared in `hooks/register.tsx`, never across an import. Everything else under `hooks/` is pure.
- The mod's own tools are matched by pattern (`/^mcp__conductor__task_update$/`), not by a string literal.
- A prompt cannot be submitted from inside a tool call, and a mod's own `session.compact` hook does not run on a compaction that mod asked for. `$.session.compact` does not exist in a session the desktop app or an SDK host runs: there the mod runs `/compact`.
- The engine keeps some command names for itself (`/run`, `/resume`) and refuses a mod that registers one. So each command and tool is registered on its own.
- Hooks for agents started in one message run interleaved, so whatever one start decides and the next must see is decided inside the ledger's write queue.
- `$.state` survives a hot reload but not a restart of the app. What a session must still know after one (the run it is bound to) is also written to `$.store`.

After a change, prove the tests can fail: break a copy of the mod and run the tests on the copy.

## License

MIT. See `LICENSE`.
