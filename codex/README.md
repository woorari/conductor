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

Start a new Codex chat in the project you want to work on, then send `$conductor STU-123`, `$conductor conduct #12`, `$conductor conduct docs/spec.md`, or a natural-language request to use Conductor. As soon as the plan is proposed, Conductor displays the full board in chat with task titles, tiers, dependencies and expected files, then waits for approval. `$conductor approve` starts the approved work. `$conductor board` displays the board again at any time. Revised proposals display the updated board before approval too.

Backups stay outside the skills folder so Codex discovers only the current skill. Updating also relocates backups made beside the skill by older installers, preserving their contents. Use `--backup-dir` to override the backup location; it must be outside the skills directory.

Replies follow the user's conversation language. A bare issue key or path defaults to English when no conversation language has been established.

## Runtime requirements and scope

- Git must be on PATH for isolated Git worktrees. GitHub integration additionally needs an authenticated `gh` CLI.
- The host must expose subagent tools for parallel workers. The skill adapts to the host's available slots.
- Run ledgers are project-local under `.codex/conductor/runs/`; they do not modify `.claude/conductor/runs/`.
- This is a skill/CLI adapter, not Claude's function-hook runtime. The [compatibility table](skill/references/compatibility.md) lists the missing live pane, automatic hooks, Lore provisioning/merges and other differences.
- Installing does not change Codex's model, permissions, MCP configuration or Claude's installation. Unreal and Blender connections are separate machine-local configuration and are not shipped in this repository.

## Linear status updates

A Linear issue key or URL links the run automatically. Approval moves the run issue to a started state; tasks move their linked issues to started as work begins and completed after all work on that ticket is done. The parent completes only after every task is done and open problems/questions are resolved. Team-specific states are selected by type rather than name. Completed and canceled tickets are not reopened.

The connected Linear plugin handles state changes without a separate API key. The CLI returns durable pending transitions, and the skill performs and confirms the corresponding connector updates. Optionally, set `LINEAR_API_KEY` in the CLI environment for direct API synchronization. Failed updates remain visible on the board and can be retried with `linear_sync`; they never undo a board change or verified merge. See the [Linear workflow](skill/references/linear.md) for details.

## Test

The same test command works on macOS and Windows:

```text
node codex/test.mjs
```

The included GitHub Actions workflow runs this suite on macOS and Windows with Node.js 22.18 and 24 after the changes are pushed. Local success alone does not establish a Windows pass.

Tests build a fresh skill into a temporary directory. They exercise install/update/backup and paths with spaces, the actual Git worktree lifecycle, approval/pause/dependency gates, persistence, GitHub merge-policy checks and uncertain-outcome recovery. GitHub transport is simulated; no credentials or live merge are used.

To remove the skill, delete only the installed `conductor` folder. To restore an update backup, close active runs, remove the current skill folder and move the saved backup from `skill-backups` back to the skills directory as `conductor`. Project ledgers and retained worktrees are independent of the installation.
