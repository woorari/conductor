# Codex next to Claude: design

Date: 2026-11-10. Status: draft, waiting for the owner's approval.

Marks used below: **(owner)** is something the owner said or confirmed. **(my call)** is a choice the author made to fill a gap; the owner can overturn it. **(unproven)** is something no trial has shown yet.

## 1. Why

A conductor run is one Claude orchestrator plus one Claude worker per task. All of them draw on the same Claude subscription. When that subscription's limit is reached in the middle of a run, the run stops and the owner waits for the window to reset.

The owner also holds a Codex (ChatGPT) subscription that sits idle during those runs. In their words: "I had to wait, and i would wish that either the work is handed over and even better from the beginning more distributed. by that my limits last longer."

A second reason is fit. The owner suspects Codex does some kinds of work better, 3D work first of all, but: "3D needs to be proven so it's not a fixed rule but we should have something where we can say that they are better suited for certain type of work."

## 2. Goals, non-goals, anti-goals

Goals, in the order they are built **(owner)**:

1. **Codex as a worker.** A task of a run can be built by Codex instead of a Claude worker. Work is spread over both subscriptions from the start of a run, so Claude's limit lasts longer.
2. **The budget line.** conductor knows how much of each subscription is used and acts on it. Claude is never run fully dry: "ideally we left a headroom of 5% with claude and it never runs fully dry and is able to do the handover."
3. **Codex in the orchestrator's seat.** When Claude reaches the line, Codex takes over the run: "codex keep working to finish all other tasks." That includes merging into the base branch **(owner)**.

Across all three:

- **Suitability notes.** The owner can write down which kind of worker suits which kind of work. The notes are hints the orchestrator reads when it plans, never fixed rules, and they can be marked as not proven yet. 3D work for Codex starts as such an unproven hint **(owner)**.
- **Off unless switched on (my call).** The switch is `workers.codex: true` in the project's `config.json`. Without it, also on a machine where Codex is installed and signed in, a project behaves exactly as today. All existing tests pass untouched.

Non-goals:

- **No API keys.** This uses the owner's subscription login on their own machine. Paying per token is a different feature.
- **No other providers.** Only Claude and Codex. Nothing is built as a general "any agent" layer; if a third one ever comes, that is a new design.
- **No Codex cloud tasks.** Codex runs locally, in the run's worktrees.
- **No cross-review.** Codex doesn't review Claude's work or the other way round. It may be a good idea; nobody asked for it.
- **No learning by itself.** conductor records how tasks went per kind of worker (see 5.4) but never rewrites the suitability notes. The owner does.
- **No handover of planning.** Codex in the seat finishes a plan the owner already approved. It doesn't start a new run and doesn't put a new plan up for approval.
- **No Lore runs under Codex in this version (my call).** Codex workers and the Codex seat cover git workspaces with GitHub. A run in a Lore workspace stays all Claude and pauses at the line as described in 6.4. Lore's merge and `/approve-main` path is enough extra surface to deserve its own step once the git path has proven itself.

Anti-goals (things this must never do):

- **Never drain Claude to zero.** Without headroom nobody is left to hand over.
- **Never loosen conductor's rules for Codex.** Whatever a Claude orchestrator or worker is refused, Codex is refused too: merging by hand, merging on red checks, two merges at once, touching another task's files, starting before `/approve`.
- **Never widen Codex's sandbox to get past a refusal.** No `danger-full-access`, no `--dangerously-*` flags, no bypass of Codex's hook trust. If Codex can't do something inside `workspace-write`, conductor does that step for it or the step isn't done.
- **Never two orchestrators at once.** At any moment exactly one of Claude and Codex holds the seat, and the board says which.
- **Never store a login.** No token, key or account detail of either subscription is written to the ledger, the board, a ticket or a log.

## 3. What is known

### 3.1 From the trial on 2026-11-10 (Codex CLI 0.167.0, the owner's login, plan reported as `prolite`)

- `codex exec` runs unattended on the saved subscription login, and three ran at once on one login without a sign-in clash.
- A Codex worker in `workspace-write` edits files in the folder it is given and nothing outside.
- **It cannot commit in a git worktree.** The worktree's index lives under the main repository's `.git`, outside the writable folder. The only way that made a commit work was `--approve-for-me --add-dir <repo>/.git` without `-s`, which gives Codex more freedom than `workspace-write`. This design doesn't use that (see 4.3).
- Codex can call tools of an MCP server passed on the command line (`-c mcp_servers.<name>...`), in exec mode, without asking.
- When Codex was refused a step, it stopped and reported the refusal. It did not work around it. It also skipped the steps after it, including reporting back. **A Codex run that ends without a proper report is a normal case, not an error path.**
- `codex exec --json` gives one JSON event per line (`thread.started`, `turn.completed`, `turn.failed`, items for messages, commands and file changes), `-o` writes the last message to a file, the exit code is 0 on success and 1 on error. `codex exec resume <thread id>` continues a thread.
- Codex's budget is readable through `codex app-server` (`account/rateLimits/read`): percent used, window length, reset time. The owner's plan has one weekly window and no 5-hour window. OpenAI marks the app-server as experimental.

### 3.2 From the mod API (read in `.claude-plugin/types/claude-code/index.d.ts`)

- `$.session.usage()` and the `session.measure` event give Claude's rate limits: `five_hour` and `seven_day`, each with `percentUsed` and `resetsAt`. The event fires after each main-thread turn and whenever a window moves a whole point.
- `$.process.run` is one shot and ends after ten minutes at most. A Codex task takes longer than that, so the mod cannot simply run `codex exec` and wait.
- The mod's timers and hooks run in the Claude Code process. They cost no Claude budget and keep running while the Claude session sits idle.

### 3.3 From the documentation (not tried here)

- When Claude's limit is hit, background workers are marked failed with partial output and don't resume by themselves. The interactive main session continues at reset.
- Codex has hooks shaped like Claude Code's (`PreToolUse`, deny by decision). A hook the user hasn't reviewed and trusted inside Codex doesn't run, and OpenAI calls hooks "a useful guardrail, not a complete enforcement boundary".
- Codex reads `AGENTS.md`, not `CLAUDE.md`.
- OpenAI recommends API keys for automation and calls the subscription login the advanced path, for trusted private machines and not for public repositories. **The consumer terms for automated use of a subscription were not checked.** That check is the owner's, before piece 1 ships.

### 3.4 Unproven, to be shown by the first build step of the piece that needs it

- A Claude worker can keep a `codex exec` running for longer than ten minutes and be woken when it ends (piece 1).
- A board tool that refuses (for example `merge` on red checks) makes a Codex orchestrator stop and wait instead of trying another way (piece 3). The trial's board server had such a tool, but the run never reached it.
- A Codex hook can refuse a shell command (piece 3). The trial didn't run this, because it would have needed a flag that bypasses hook trust. The proper way is that the owner reviews and trusts the hook once inside Codex.
- In `workspace-write` Codex has no network, so it can't push or call `gh` by hand (piece 1: without this a Codex worker could merge by hand, unseen by conductor's guards). And an MCP server Codex starts runs outside the sandbox and does have network (piece 3).
- The mod can start a process that outlives the ten-minute limit of `$.process.run`, detached, and watch it through a file (piece 3).

If one of these turns out false, the builder stops and brings it back; section 8 says what the fallback would be.

## 4. Piece 1: Codex as a worker

### 4.1 What the owner sees

- Each task on the board carries, next to its tier, a **kind of worker**: `claude` or `codex`, with one line saying why. The orchestrator sets it when it adds the task. The plan shows it, so the owner sees the split at `/approve`.
- The owner can change it for a task that hasn't started, the same way `/tier` changes a tier **(my call)**: `/worker <task> claude|codex`. A kind the owner set is left alone by the orchestrator afterwards, as with `tierBy: 'owner'`.
- The ledger keeps **why** a task has its kind, not only what it is: the owner set it, a suitability note asked for it (and whether that note is proven), it is an architecture task kept on Claude (4.2), or it is the plain default. Sections 6.3 and 7.4 depend on this.
- A task whose kind is `codex` goes through the same statuses as any other, ends in a pull request, and is merged by the same rules.
- If the switch is on but Codex isn't installed or isn't signed in when a run starts, conductor says so once and every task is `claude`. Nothing else changes.

### 4.2 How the orchestrator chooses

- The default is to **spread the work (owner)**. With no note pointing either way, the orchestrator splits tasks between both kinds, leaning towards whichever subscription has more left (piece 2 gives it the numbers; before piece 2 exists, it alternates sensibly and says why).
- The suitability notes (5) can pull a task to one side.
- Architecture and design tasks, what today is tagged `opus` for that reason, stay with Claude unless a note says otherwise **(my call)**. The first runs should not test Codex on the tasks where a mistake costs most.
- The tier still means something for a Codex task: project settings map each tier to a Codex model and reasoning effort. Without a mapping, every tier uses Codex's default **(my call)**.

### 4.3 How a Codex worker runs (my call)

A Codex task still gets a Claude worker, on the cheapest tier, that does no building itself. This document calls it the **carrier**. It:

1. gets its worktree and slot from the router exactly as any worker does;
2. starts `codex exec` in that worktree with `-s workspace-write`, the task's brief, the findings and rulings that bind the task, and a pointer to the project's `CLAUDE.md` and rules;
3. waits for it to end, without polling in a way that burns tokens;
4. reads what Codex changed and its last message, runs the project's checks, commits, pushes, opens the pull request and reports to the board as any worker would;
5. if Codex ended without finishing, gives it one more turn with `codex exec resume` and what was missing; after that it reports the task as failed with Codex's last words.

Why this way and not the mod running Codex directly:

- The mod cannot wait on a long process (3.2), and conductor's rule is that the mod starts no agent by itself.
- Everything conductor already does for a worker keeps working untouched: the worktree, the slot, the files it touched, the stall warning, the command guards, hand-back, `returned`.
- Codex keeps the tight sandbox. It can't commit or push (3.1), so the carrier does both, and the commands that do it pass through conductor's existing guards.

What it costs: a few thousand Claude tokens per Codex task for the carrier's turns. That is small next to building the task, but not zero, and it means **piece 1 alone doesn't work while Claude is dry.** That is what piece 3 is for.

The carrier writes Codex's thread id and the step it is at (Codex running, checking, committing) to the task on the ledger. A seat change needs that (7.5).

Limits of piece 1, stated so nobody is surprised:

- A ruling or finding posted while Codex is mid-run reaches it only at its next turn, if there is one. The carrier applies it when it checks the result.
- Codex's own sub-agents are switched off for workers (`agents.enabled=false`). One task, one Codex.
- MCP servers from the owner's own Codex config are switched off for workers unless project settings name them. A 3D task will need one (Blender); the settings carry that list.

### 4.4 The parallel limit

Codex tasks count towards `maxParallel` like any other. No separate limit for now **(my call)**; three at once worked in the trial.

## 5. Suitability notes

5.1 They live in the project's `config.json` under `.claude/conductor/`, as a short list **(my call on the shape)**:

```json
"workers": {
  "notes": [
    { "kind": "codex", "for": "3D work: Blender scenes, meshes, materials", "proven": false },
    { "kind": "claude", "for": "anything that changes conductor's own rules", "proven": true }
  ]
}
```

5.2 The orchestrator reads them when it plans. A note is a hint: it may go against one and says why in the task's reason line.

5.3 `proven: false` means "try this and watch". The orchestrator follows such a note but the plan marks the task as a trial, so the owner knows which tasks are the experiment.

5.4 To make proving possible, each finished task keeps on the ledger which kind built it and how it went: green at first try, sent back, failed, handed to the other kind. At the end of a run the board shows that per kind. Whether a note gets promoted to `proven: true`, changed or deleted is the owner's edit.

5.5 In a folder home the notes can sit in the home's config and apply to all its places; a place's own notes come on top **(my call)**.

## 6. Piece 2: the budget line

### 6.1 What conductor reads

- Claude: both windows from `session.measure`, kept on the board with their reset times.
- Codex: its windows through the app-server, read at the start of a run, before each Codex task starts, and about every few minutes while one runs. If the read fails (the interface is experimental), the board shows "unknown" and Codex counts as available until a Codex run fails with a limit error.
- The dashboard shows one line per subscription: percent used per window, when it resets.

### 6.2 The line (owner)

At **95% used** in either of Claude's windows, Claude stops taking on work and hands over. The number is a run setting (`claudeHandoverAt`, default 95), because 5% may prove too thin: running Claude workers keep drawing on the same budget while the handover happens.

### 6.3 Before the line (my call)

From a lower mark (`preferCodexFrom`, default 70% used) conductor tells the orchestrator once, and from then on tasks that haven't started are moved to `codex` where no note and no owner's choice holds them on Claude. This is the "limits last longer" part acting during a run, not only at planning.

Only tasks on Claude by plain default move. A task held by the owner, by a note or as an architecture task stays.

The same holds the other way: Codex has the same two marks as separate settings (`preferClaudeFrom`, default 70, and `codexStopAt`, default 95) **(my call)**. Past the first, new tasks lean to Claude. At the second, no new Codex worker starts; if Codex holds the seat, 7.5 applies and the run then pauses until Claude is back.

### 6.4 At the line

1. The router refuses to start new Claude workers, carriers included.
2. Running Claude workers are told to commit what they have and hand back, with the hand-back conductor already has. Their tasks become `returned`.
3. Running carriers stop their Codex run and hand back as in 7.5. Their tasks become `returned`.
4. The orchestrator writes the handover, as conductor's handover already does, and gives up the seat.
5. With piece 3 built: Codex takes the seat (7). Without piece 3, or in a Lore run, or with Codex unavailable or itself past its own line: the run pauses with conductor's existing pause, says why and when the window resets, and resumes by itself after the reset.

### 6.5 Both dry

The run pauses and says which window resets first. Nothing else.

## 7. Piece 3: Codex in the orchestrator's seat

### 7.1 What the owner sees

- The board says who holds the seat and since when. A handover is one line on the board and, where the run has a ticket, one comment on it.
- Under Codex the run goes on: remaining tasks are built by Codex workers, green pull requests are merged, problems are recorded.
- Anything that needs the owner still waits for the owner: questions, a blocked task, a plan change that would need a new `/approve`.
- When Claude's window has reset, Claude takes the seat back **(my call)**: Codex finishes the step it is on, writes a handover in the same form, and the Claude orchestrator is woken with it. Reason: conductor's rules are enforced most fully on the Claude side, so time under Codex should be the exception.

### 7.2 What has to exist for it

Today the board's tools and rules exist only inside Claude Code. Codex can't reach them. Piece 3 therefore adds **a board server**: a small local program that speaks MCP over stdio, reads and writes the same ledger, and applies the same rules by using the same pure code under `hooks/` (`router`, `ledger`, `merge`, `problems`, `posts`). It is what Codex talks to instead of the mod.

- It offers the Codex orchestrator the board tools an orchestrator has, plus one the Claude side doesn't need: **start a task's worker**. Codex can't start conductor workers itself, so the board server does: it applies the router's rules, makes the worktree, starts `codex exec` for the task and watches it.
- It does for Codex workers what the carrier does in piece 1: checks, commit, push, pull request. Under the Codex seat there are no carriers, since Claude is away.
- It merges only through the same merge code, with the same checks.
- The mod starts the Codex orchestrator at the handover, detached, with the handover note as its prompt and the board server attached, and watches that it is alive. If it dies, the mod starts it again from the board, at most a few times, then pauses the run.
- The board server is a child of the Codex orchestrator and ends with it **(my call)**. Nothing has to survive a seat change except the ledger, the worktrees and the branches (7.5).
- **Two processes now write the ledger**: the mod (the owner's commands, the heartbeat below) and the board server. Ledger writes have to be made safe for that; today only one process writes.
- **It needs Node on the owner's machine (my call).** The repository has no build step today, and the preference is to keep it that way: the board server runs the same TypeScript files. If that proves impossible, a bundle is committed and a test fails when it is out of date. Without Node, piece 3 is unavailable on that machine and the run pauses at the line as in 6.4.
- **The GitHub token (my call).** The mod's stored token is not handed to Codex or put on a command line. The board server takes the token from `GH_TOKEN` in the environment or from `gh auth token`. If neither gives one, piece 3 is unavailable for that install and the run pauses at the line.
- **Linear waits.** The board server makes no Linear calls. State moves for tickets merged under Codex are caught up when Claude takes the seat back.
- **The mod must be alive (my call).** The mod writes a heartbeat to the ledger about every half minute. When the heartbeat is older than a few minutes (Claude Code was closed), the board server starts no worker and merges nothing, and the Codex orchestrator ends at its next step. Nobody merges while nobody watches, and only the mod can hand the seat back.

### 7.3 How the rules hold under Codex

Three layers, strongest first:

1. **The sandbox.** Codex runs in `workspace-write`: no writes outside its folder, no commit in a worktree (3.1), and no network **(unproven, 3.4)**. So pushing, opening and merging pull requests can only happen through the board server.
2. **The board server.** Every board rule is applied there, in the same code as on the Claude side.
3. **Codex hooks**, for by-hand commands the sandbox would still allow. They need the owner's review and trust once inside Codex. conductor ships the hook file and says how to trust it; it never bypasses the trust step.

The seat is a field on the ledger. While Codex holds it, the mod refuses the Claude orchestrator's board writes, and the board server refuses Codex's while Claude holds it.

### 7.4 What Codex in the seat doesn't do

- It doesn't start a run or propose a plan.
- It doesn't use Claude workers. A task that is on Claude by plain default is built by Codex, and the board notes the change. A task held on Claude by the owner, by a proven note, or as an architecture task **waits for Claude's return (my call)**; a task held only by an unproven note moves. So "finish all other tasks" means all tasks nobody fenced off.
- It doesn't run in Lore workspaces (non-goal).

### 7.5 Tasks that are mid-run when the seat changes (my call)

Nothing running is adopted by the other side. In both directions:

1. The side that leaves stops its running workers. For a Codex run that means: stop the process, then commit whatever is in the worktree as work in progress on the task's branch. The carrier does that on the way to Codex, the board server on the way back.
2. Those tasks become `returned`, with the Codex thread id kept on the ledger.
3. The side that arrives starts them again from their branch, as conductor already does for a returned task. A Codex worker restarted on a task that has a thread id continues that thread.

A carrier needs one or two turns for this inside the headroom. That is part of why the line is a setting.

### 7.6 The owner during the Codex seat (my call)

The owner's commands are mod code and cost no Claude budget, so they keep working: `/pause`, `/unpause`, `/tier`, `/worker` and `/merged` write to the ledger, and the board server reads the ledger afresh on every call, so the Codex orchestrator meets a pause at its next step. Answers to questions and anything else typed to the orchestrator wait for Claude's return. That is a real limit: a task blocked on a question stays blocked until then.

## 8. If something unproven turns out false

- **A Claude carrier can't hold a long Codex run:** the carrier runs Codex in turns short enough to fit (`exec`, then `exec resume`), or piece 1 moves onto the board server of piece 3, built early. The builder brings this back before choosing.
- **Codex has network in the sandbox after all (found in piece 1):** piece 1 doesn't ship until a Codex hook, trusted by the owner, is shown to refuse `gh pr merge` and a push to the base branch. If that fails too, it is brought back.
- **The same, or hooks that can't refuse, found in piece 3:** the Codex seat ships without merging. Codex builds and opens pull requests; merging waits for Claude's return. The owner asked for merging under Codex, so this is brought back to them, not decided by the builder.
- **A refused Codex orchestrator doesn't wait but improvises:** same as above.
- **The mod can't keep a detached process:** the owner starts the Codex seat by a command conductor prints at the handover. Less than asked for; brought back.
- **The app-server budget read goes away:** Codex's budget is "unknown" and the run reacts to limit errors only (6.1 already covers this).

## 9. Left to the builder

- Names: the task field for the kind of worker, the settings keys, the command name, the board server's file layout.
- How the carrier waits for Codex and how it is told what to do (its brief).
- The exact prompt a Codex worker and a Codex orchestrator get.
- How tiers map to Codex models by default.
- How the board shows kind, budget and seat.
- How often Codex's budget is read.
- The tests. conductor's rule stands: everything under `hooks/` except `register.tsx` is pure and tested without Claude Code; the board server's own input and output is the only new impure part.
- Each piece gets its own plan and its own pull request, in the order 1, 2, 3. Each is usable without the next.

Not left to the builder: anything in the anti-goals, the 95% default, the order of the pieces, and every "brought back" in section 8.

## 10. Checks before each piece ships

- Piece 1: the no-network proof (3.4). One real run with at least one Codex task and one Claude task, merged. The owner has looked at the terms question (3.3).
- Piece 2: a run driven past both marks with lowered settings (for example 5% and 10%), so the line is seen acting without burning a real window.
- Piece 3: a handover and a return, again with lowered settings, with a task mid-run each time; one merge under Codex; one refused merge under Codex; `/pause` during the Codex seat; Claude Code closed during the Codex seat.
