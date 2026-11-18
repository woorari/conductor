# Compatibility

This package adapts Conductor's workflow to a Codex skill and local CLI. Original reusable code is bundled under scripts/core with its MIT license and source revision. Claude's register.tsx and private function-hook runtime are not executed. Installing the skill does not change Codex permissions, model settings, MCP servers, or Claude's installation.

| Feature | Codex adapter |
| --- | --- |
| Plan, propose, user approval | Persistent ledger with enforced start gate |
| Task dependencies, file overlap, capacity | Original Conductor router and preflight logic |
| Isolated Git workers | One orchestrator; implementation/conflicts delegated to Codex collaboration workers in actual Git worktrees |
| Worker tier labels | Portable complexity keys; board separates complexity from current-session inheritance or an explicit owner mapping |
| Board, findings, questions, rulings, problems | Live local board in the desktop right panel, plus Markdown approval board; orchestrator reads and forwards messages |
| GitHub merge policy | Complete-delivery approval covers the recorded base; review-only limits and legacy per-head consent remain; checks, exact-head merges, locks and reconciliation are enforced |
| Pause and resume | Persistent hold checked before worker reservation and merge |
| Handover | Saved Markdown checkpoint; read after compaction/restart |
| Claude slash commands and live pane | Use `$conductor <command>`; local browser panel with automatic refresh, plus Markdown fallback |
| Activity reports | Timestamped task notes attributed to worker/orchestrator; liveness is checked through collaboration tools, not inferred from the board connection |
| Automatic tool interception, activity/tokens, routing overrides | No automatic tool/token telemetry; agents follow skill instructions rather than Claude runtime interception |
| Automatic compaction, timer and post-merge CI watcher | Not installed; Codex handles its context, orchestrator checks CI during the run |
| Lore workspaces, task and run merges, exact-revision approve-main | Ported to the command interface: `worktree` makes a worker's Lore workspace from the local copy, `approve` prepares the run's, `run_check`, `merge`, `run_sync_base` and `run_merge_main` run the Lore steps (the protected base is unprotected for the merge and protected again after it), and `approve_main` records a decision for an exact revision. It needs the `lore` program on this machine; with no local Lore workspace the run stops with a blocker and nothing is cloned |
| A project's `.claude/conductor/config.json` | Read by `conduct` through the shared project module (`staffing`, `lore`, `places`); the run keeps its own copy and picks of agent and effort are checked against it. A file that does not parse stops `conduct` |
| Folder-home workspace selection | `conduct` takes a `place` from the config; a place whose folder is missing is refused, and a Lore place with no local workspace stops the run at `approve`. `--home <dir>` keeps the ledgers and the lock outside the project |
| Proven callers | With `--callers <dir>` the caller is proven by the token in `CONDUCTOR_TOKEN` against a record in that folder, and `--caller` is refused. Without `--callers` the caller is still only declared, as before |
| Linear ticket states | Approval/work-start/completion synchronization via the connected plugin or optional API key; persisted pending updates and retry warnings |
| Linear issue creation | Existing issues can be linked; automatic issue filing is not ported. A Lore run's tickets follow its recorded base merge |

Codex ledgers live in `<project>/.codex/conductor/runs/<id>/`. Claude's `.claude/conductor/runs/` stays separate. A project's existing `.claude/conductor/brief.md` can be read as project reference when no Codex brief exists. No existing run is silently migrated. Worktrees live beside the original repository in `<repo>.conductor-codex/<run>/<task>` and are retained for inspection.

Without `--callers`, the CLI's `--caller` is a cooperative role declaration, not a security boundary; with `--callers` the caller is proven (see the table) and `--caller` is refused. Approval provenance is the user's actual chat instruction. No global hooks are installed to police shell commands outside the adapter. Review gates operate on adapter actions; the host's tools and permissions remain authoritative.

For full native parity, remaining work is a Codex lifecycle integration for tool interception, worker activity/notification delivery, model policy and context telemetry. Do not represent this skill as the unmodified Claude mod running natively.
