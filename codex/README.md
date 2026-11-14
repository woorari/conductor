# Conductor for Codex

Install the Codex adapter from this checkout on macOS or Windows. Claude's mod and the Codex adapter share the same pure planning, ledger, routing, messaging, problem and merge modules. The installer builds them from `hooks/*.ts`; generated copies are not committed or maintained separately.

## Install

Install **Node.js 22.18 or newer** and Codex first. From this repository, run the same command in Terminal, PowerShell or Command Prompt:

```text
node codex/install.mjs
```

The installer uses `CODEX_HOME` when set; otherwise it installs into `.codex/skills/conductor` under the current user's home directory. It needs no administrator privileges, Python, npm install or Unix shell. Git metadata is optional when installing from a source archive.

To update, preserving the previous installation under `CODEX_HOME/skill-backups` (or `~/.codex/skill-backups`):

```text
node codex/install.mjs --force
```

To preview the destination without writing:

```text
node codex/install.mjs --dry-run
```

Use `--target` for a custom skill directory. Quote paths with spaces. The path must end with the `conductor` folder:

```text
node codex/install.mjs --target "C:\Users\Your Name\.codex\skills\conductor"
```

Start a new Codex chat in the project you want to work on, then send `$conductor STU-123`, `$conductor conduct #12`, `$conductor conduct docs/spec.md`, or a natural-language request to use Conductor. Conductor automatically opens a live board in the desktop app’s right-hand browser panel when the run starts. Tasks, problems, questions and the queue refresh from the saved run while you work. As soon as the plan is proposed, Conductor also displays the full board in chat with task titles, tiers, dependencies and expected files, then waits for approval. `$conductor approve` starts the approved work. `$conductor board` displays the board again at any time. Revised proposals display the updated board before approval too.

Backups stay outside the skills folder so Codex discovers only the current skill. Updating also relocates backups made beside the skill by older installers, preserving their contents. Use `--backup-dir` to override the backup location; it must be outside the skills directory.

Replies follow the user's conversation language. A bare issue key or path defaults to English when no conversation language has been established.

## Runtime requirements and scope

- Git must be on PATH for isolated Git worktrees. GitHub integration additionally needs an authenticated `gh` CLI.
- The host must expose subagent tools for parallel workers. The skill adapts to the host's available slots.
- Run ledgers are project-local under `.codex/conductor/runs/`; they do not modify `.claude/conductor/runs/`.
- This is a skill/CLI adapter, not Claude's function-hook runtime. The [compatibility table](skill/references/compatibility.md) lists automatic hooks, Lore provisioning/merges and other remaining differences.
- Installing does not change Codex's model, permissions, MCP configuration or Claude's installation. Unreal and Blender connections are separate machine-local configuration and are not shipped in this repository.

## Approved delivery and worker roles

The main chat orchestrates; workers implement and resolve conflicts. Plan approval covers the approved outcome through necessary files, regression fixes, tests, commits, pushes, PRs, reviewed PR merges into the recorded base, post-merge checks and ticket synchronization. In-scope follow-ups retain approval. Expected files are worker reservations, not permission prompts: update them with `task_update`, `files`/`dependsOn` and `scopeReason` linking the change to the outcome. Live file conflicts and dependency cycles are still refused.

Use `approve --caller owner` from actual owner approval; default delivery is `complete`. Explicit input `{"delivery":"review-only"}` reserves merging. Individual `approve_merge` remains for limited/legacy approvals. Existing explicit full-delivery permission can be recorded once on a legacy approved run without asking again. Do not silently widen another owner’s earlier approval.

Workers use `quarantine --caller worker:<id>` with `{"paths":["relative/file"]}` to move obsolete approved-scope files into their worktree’s `_deleted` without deleting their contents. Orchestrators cannot use that command to perform implementation changes. Permanent deletion requires explicit deletion approval. System files must never be deleted or quarantined, and reading/writing/searching `~/Library`, including through links, requires explicit user approval for that access. The helper refuses system/Library paths, traversal, symlinks and scope escapes.

Quarantine adds `_deleted/` to local Git exclusions shared by linked worktrees. Never force-add or publish retained files. Claude’s copied-workspace cleanup uses `_deleted` inside its ignored run directory.

The HTML board displays timestamped worker and orchestrator reports from `task_update` notes. Review rows mean a hand-back awaits orchestration, not that a worker is running. The connected indicator describes the board connection; agents check actual worker status and report meaningful progress and waiting states in chat at least every 60 seconds during ongoing work.

This is the same orchestration concept as Claude, implemented with Codex collaboration agents and a local CLI. The skill and role checks control the workflow; they do not globally intercept arbitrary tools outside it. Without a worker capability, retain the plan and report the host limitation rather than implementing in the orchestrator.

## Models on host handover

Task complexity survives a handover; provider model assignments do not. The portable tier keys stay `opus`/`sonnet`/`haiku` for ledger compatibility, but Codex displays architecture/implementation/simple and shows **current Codex model** as the default next-worker selection. Workers inherit the model selected in the receiving chat. Claude resolves the same complexity keys to its native tier aliases. A prior worker’s recorded model is shown separately as history, and a new reservation clears that record until the new engine reports its actual model.

On a host takeover, `model_policy` with input `{}` resets future Codex assignments to session inheritance. An explicit owner-supplied mapping is stored with `model_policy --caller owner` and input `{"models":{"sonnet":"<available Codex model>"}}`; unmapped tiers inherit. Workers cannot change this policy. Approval, task progress, existing agents and completed history are preserved. This is model handling, not automatic ledger or workspace migration between the two hosts.

## Live desktop board

Claude and Codex share these HTML assets and the local server; Claude’s entry is `node codex/board.mjs --root <project> --run <id>`. It reads `.claude/conductor/runs/`, uses Claude’s native commands and supports queued-task tier changes through the active Claude session. The Codex view remains backed by `.codex/conductor/runs/`.

The board runs locally with the same Node.js runtime as the adapter, without npm dependencies or API keys. It shows progress, task states, measured worker timelines, open problems/questions, rulings, pending Linear transitions, and the full plan with tiers, dependencies and expected files. Approval and resume buttons copy commands to send in chat; viewing or clicking the board never approves or changes a run.

The desktop browser panel accepts HTTP/HTTPS pages, so an HTML file beside the ledger cannot open there directly. The local server exposes only the board assets and authenticated run snapshot; it is not a general file server.

The CLI returns `boardView.url` after `conduct` and `run_plan`. The skill opens that URL in the desktop app beside the chat. `$conductor board` reopens the view on resume. If a host lacks the desktop panel tool, the Markdown board and local URL remain available.

For manual recovery, run the installed `scripts/conductor.mjs` with `board_open --root <original-project-root> --run <id>`. Use `board_close` with the same arguments to stop only the board server. These commands are orchestrator actions. The server is reused per run, listens only on `127.0.0.1`, protects run data with a random access token in the URL fragment, and exits after 30 minutes without a viewer. After a restart, `board_open` recovers a stopped or stale server. Do not publish the access URL.

## Linear status updates

A Linear issue key or URL links the run automatically. Approval moves the run issue to a started state; tasks move their linked issues to started as work begins and completed after all work on that ticket is done. The parent completes only after every task is done and open problems/questions are resolved. Team-specific states are selected by type rather than name. Completed and canceled tickets are not reopened.

The connected Linear plugin handles state changes without a separate API key. The CLI returns durable pending transitions, and the skill performs and confirms the corresponding connector updates. Optionally, set `LINEAR_API_KEY` in the CLI environment for direct API synchronization. Failed updates remain visible on the board and can be retried with `linear_sync`; they never undo a board change or verified merge. See the [Linear workflow](skill/references/linear.md) for details.

## Test

The same test command works on macOS and Windows:

```text
node codex/test.mjs
```

The included GitHub Actions workflow runs this suite on macOS and Windows with Node.js 22.18 and 24 after the changes are pushed. Local success alone does not establish a Windows pass.

Tests build a fresh skill into a temporary directory. They exercise install/update/backup and paths with spaces, the actual Git worktree lifecycle, approval/pause/dependency gates, persistence, GitHub merge-policy checks and uncertain-outcome recovery, local board authentication, concurrent server reuse, live updates and recovery. GitHub transport is simulated; no credentials or live merge are used.

To remove the skill, delete only the installed `conductor` folder. To restore an update backup, close active runs, remove the current skill folder and move the saved backup from `skill-backups` back to the skills directory as `conductor`. Project ledgers and retained worktrees are independent of the installation.
