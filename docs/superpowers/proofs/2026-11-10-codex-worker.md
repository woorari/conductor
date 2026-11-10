# Codex worker: the two proofs of task 1

Record of the two proofs that spec 3.4 asks for before the Codex worker (piece 1) is built on. Both PASSED.

- Plan: `docs/superpowers/plans/2026-11-10-codex-worker.md`, task 1 ("The two proofs").
- Spec: `docs/superpowers/specs/2026-11-10-codex-next-to-claude-design.md`, sections 3.4 and 10.
- Both files live on branch `claude/codex-subscription-integration-b2e3f7`, not yet on `main`.
- Ticket: STU-164. Codex CLI 0.167.0. All times UTC.

## Proof 1: no network in the Codex sandbox

### Baseline, outside the sandbox

- `curl -sS -m 10 https://api.github.com/zen`: exit 0.
- `gh pr list`: exit 0, no open pull requests.
- `git push --dry-run origin HEAD`: exit 0, "Everything up-to-date".

### Runs inside the sandbox

The repository is a scratch clone of `woorari/conductor`, at `main` 7f06bba. The brief, given on stdin, was:

```
Run these three commands one by one and report each exit code and the last line of output verbatim. Do not try anything else.
1. curl -sS -m 10 https://api.github.com/zen
2. gh pr list
3. git push --dry-run origin HEAD
```

Run A (first turn):

```
codex exec -C <clone> -s workspace-write -c sandbox_workspace_write.network_access=false -c agents.enabled=false --json -
```

Run B (second, resumed turn, in the same thread as A, run from inside the clone):

```
codex exec resume --json -c 'sandbox_mode="workspace-write"' -c sandbox_workspace_write.network_access=false -c agents.enabled=false 01a1c56f-7aa3-7562-8d13-fc07bbb9ed40 -
```

Run C: the argv of run A, with `CODEX_HOME` set to a scratch directory whose `config.toml` says `[sandbox_workspace_write]` `network_access = true`. The `-c ...network_access=false` flag on the command line is the override under test.

Run C2 (contrast): the same scratch `CODEX_HOME`, network on in the config, no override, and only the curl line in the brief.

| Run | curl | gh pr list | git push --dry-run | Verdict |
|---|---|---|---|---|
| A | exit 6: `curl: (6) Could not resolve host: api.github.com` | exit 1 (last line: `check your internet connection or https://githubstatus.com`) | exit 128: `Could not resolve host: github.com` | PASS |
| B | exit 6, same line | exit 1, same line | exit 128, same line | PASS |
| C | exit 6, same line | exit 1, same line | exit 128, same line | PASS |
| C2 (contrast) | exit 0: `Half measures are as bad as nothing at all.` | not run | not run | network is on when there is no override |

The failure is DNS, not a permission prompt: the sandbox cannot resolve any host, and Codex ran each command without hesitation. `git ls-remote origin` before and after the runs gave identical output, so GitHub was not changed.

Nothing was widened: no `danger-full-access`, no `--dangerously-*` flag.

Verdict: PASS. The argv flag `network_access=false` holds in a first turn, in a resumed turn, and against a config that turns network on.

## Proof 2: a 65-minute run kept by `$.process.spawn`

### The setup

- A scratch mod, `/codex-proof`, not committed to this repository. Its command starts a `codex exec` child through `$.process.spawn`, reads the child's stream as `loreLong` does (a half line waits for its rest, a line that is not JSON is skipped and counted), and writes each event's arrival time to the mod's log. A heartbeat is written every five minutes.
- The child argv:

```
codex exec -C <work> -s workspace-write -c sandbox_workspace_write.network_access=false -c agents.enabled=false --json -
```

- The brief, on stdin:

```
Run `sleep 300` thirteen times; after each, append one line with the time to `proof.log`.
Rules: run each sleep as its own separate shell command, so thirteen commands in all, one sleep each, never chained into one command and never in the background. In the same command, right after the sleep, append the line with `date -u +%Y-%m-%dT%H:%M:%SZ >> proof.log`. Wait for each command to finish before the next. Do nothing else, and say nothing more than "done" at the end.
```

- Deviation from the plan's brief, stated here: the plan's brief does not say that each sleep is its own command and writes its time line in that same command. With the bare brief, Codex chained the sleeps into one command, which would have left the check nothing to match. The added rules only make the sleeps separate commands; they widen nothing.
- A smoke run (`sleep 5` three times) passed before the long run, with the same wiring.
- While the child ran, the owner's session took ordinary turns, including the planning of another run and a subagent worker of that run. No turn waited on the child.

### The result

- Mod log: started 12:52:45.415Z; exit line `code=0 signal=none skipped_lines=0` at 13:57:55.131Z.
- Total: 65.2 minutes. 13 heartbeats. Longest gap between two events: 5.0 minutes.
- Mod log: `<scratch>/codex-proof.log`. Proof file written by the child: `<scratch>/work/proof.log`.

The check, `node <scratch>/check.mjs`, output:

```
mod log:   <scratch>/codex-proof.log (54 events, mode long)
proof.log: <scratch>/work/proof.log

line  1  2026-11-10T12:57:51Z  -> item.completed 0.1s later
line  2  2026-11-10T13:02:51Z  -> item.completed 0.2s later
line  3  2026-11-10T13:07:51Z  -> item.completed 0.2s later
line  4  2026-11-10T13:12:51Z  -> item.completed 0.3s later
line  5  2026-11-10T13:17:51Z  -> item.completed 0.4s later
line  6  2026-11-10T13:22:51Z  -> item.completed 0.4s later
line  7  2026-11-10T13:27:51Z  -> item.completed 0.5s later
line  8  2026-11-10T13:32:51Z  -> item.completed 0.5s later
line  9  2026-11-10T13:37:51Z  -> item.completed 0.6s later
line 10  2026-11-10T13:42:51Z  -> item.completed 0.7s later
line 11  2026-11-10T13:47:51Z  -> item.completed 0.7s later
line 12  2026-11-10T13:52:51Z  -> item.completed 0.8s later
line 13  2026-11-10T13:57:51Z  -> item.completed 0.8s later

exit line: code=0 signal=none skipped_lines=0 at 2026-11-10T13:57:55.131Z
total duration: 65.2 minutes
events: 40; longest gap between two events: 5.0 minutes; worst lag: 0.8s

PASS
```

Result: 13 of 13 lines matched, lag 0.1 to 0.8 s, 0 skipped lines, exit code 0 delivered. Each `item.completed` arrived within seconds of its time, so the events came live, not in a lump at the end.

Verdict: PASS.

## Consequence

Both gates of spec 3.4 are met, so neither stop rule of task 1 applies: the Codex sandbox has no network, and a `codex exec` child kept by `$.process.spawn` streams live for over an hour. Piece 1 is not stopped by either proof.

Piece 1 still does not ship until the other conditions of spec 10, "Checks before each piece ships", are met: one real run with at least one Codex task and one Claude task, merged; and the owner's look at OpenAI's consumer terms for automated use of a subscription (spec 3.3), which is not checked here.
