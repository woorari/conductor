# Compatibility

This package adapts Conductor's workflow to a Codex skill and local CLI. Original reusable code is bundled under scripts/core with its MIT license and source revision. Claude's register.tsx and private function-hook runtime are not executed. Installing the skill does not change Codex permissions, model settings, MCP servers, or Claude's installation.

| Feature | Codex adapter |
| --- | --- |
| Plan, propose, user approval | Persistent ledger with enforced start gate |
| Task dependencies, file overlap, capacity | Original Conductor router and preflight logic |
| Isolated Git workers | One orchestrator; implementation/conflicts delegated to Codex collaboration workers in actual Git worktrees |
| Worker tier labels | Portable complexity keys; board separates complexity from current-session inheritance or an explicit owner mapping |
| Board, findings, questions, rulings, problems | Live local board in the desktop right panel, plus Markdown approval board; orchestrator reads and forwards messages |
| GitHub merge policy | Separate owner consent pinned to PR/head/base, plus original checks and policy; live GH reads, exact-head merge, repository lock, uncertain-outcome reconciliation |
| Pause and resume | Persistent hold checked before worker reservation and merge |
| Handover | Saved Markdown checkpoint; read after compaction/restart |
| Claude slash commands and live pane | Use `$conductor <command>`; local browser panel with automatic refresh, plus Markdown fallback |
| Activity reports | Timestamped task notes attributed to worker/orchestrator; liveness is checked through collaboration tools, not inferred from the board connection |
| Automatic tool interception, activity/tokens, routing overrides | No automatic tool/token telemetry; agents follow skill instructions rather than Claude runtime interception |
| Automatic compaction, timer and post-merge CI watcher | Not installed; Codex handles its context, orchestrator checks CI during the run |
| Lore workspaces/merges and exact-revision approve-main | Not ported; no claim of runtime-enforced equivalence |
| Folder-home workspace selection | Select a concrete repository first; no automatic places routing |
| Linear ticket states | Approval/work-start/completion synchronization via the connected plugin or optional API key; persisted pending updates and retry warnings |
| Linear issue creation and Lore lifecycle | Existing issues can be linked; automatic issue filing and Lore state synchronization are not ported |

Codex ledgers live in `<project>/.codex/conductor/runs/<id>/`. Claude's `.claude/conductor/runs/` stays separate. A project's existing `.claude/conductor/brief.md` can be read as project reference when no Codex brief exists. No existing run is silently migrated. Worktrees live beside the original repository in `<repo>.conductor-codex/<run>/<task>` and are retained for inspection.

The CLI's `--caller` is a cooperative role declaration, not a security boundary. Approval provenance is the user's actual chat instruction. No global hooks are installed to police shell commands outside the adapter. Review gates operate on adapter actions; the host's tools and permissions remain authoritative.

For full native parity, remaining work is a Codex lifecycle integration for tool interception, worker activity/notification delivery, model policy, context telemetry, and the Lore/folder-home lifecycle. Do not represent this skill as the unmodified Claude mod running natively.
