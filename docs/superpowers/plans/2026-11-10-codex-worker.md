# Codex worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a task of a run can be built by Codex instead of Claude: the mod makes the worktree, runs `codex exec` in it, commits, pushes and opens the pull request, and the orchestrator reviews and merges it like any other.

**Architecture:** Every task carries a kind of worker (`claude` or `codex`) with the reason. A new pure module `hooks/codex.ts` holds everything that can be tested without Claude Code: the argv for a turn, the reader for Codex's JSON events, the worker's brief, and the decision after each turn. `hooks/register.tsx` gets a board tool `worker_start` and a runner that keeps the `codex exec` child through `$.process.spawn` (the pattern of `loreLong`), and reuses `gitWorktreeFor`, the check behind `runCheckTool`, `github()` and the `asks` + `wake` path.

**Tech Stack:** TypeScript Claude Code mod (`claude-code` mod API), tests with `claude-code/testing` run by `claude plugin test .`, Codex CLI 0.167.0 or later.

**Spec:** `docs/superpowers/specs/2026-11-10-codex-next-to-claude-design.md` (approved 2026-11-10, revised the same day: the mod runs Codex). Read sections 3.4, 4, 5, 8 and 10 first. This plan covers piece 1 only; the budget line (piece 2) and the Codex seat (piece 3) get their own plans.

## Global Constraints

- Test-first: every task writes its failing test before the code, and after the change proves the test can fail.
- `claude plugin validate . && claude plugin test .` stays green and `tsc -p .` stays clean. The existing 694 tests pass **untouched**; `tests/world.ts` changes only additively.
- Off by default: without `"workers": { "codex": true }` nothing changes. The tool list, the planning text, the board and the ledger of such a run are byte-for-byte today's.
- The sandbox is never widened: every Codex argv carries `-s workspace-write` and `-c sandbox_workspace_write.network_access=false`. No `danger-full-access`, no `--dangerously-*` flag, no bypass of hook trust, anywhere in code, tests or docs.
- Codex's own sub-agents are off (`-c agents.enabled=false`), and so is every MCP server of the owner's Codex config that the project's `workers.mcp` does not name.
- The brief reaches Codex on stdin (`input`), never as an argv element.
- No login, token or key is written to the ledger, the board, a ticket, a pull request or a log. Codex's last message is cut to 20,000 characters before it is stored or posted.
- A Codex task counts toward `maxParallel` like any worker, and every rule of the router (approval, pause, dependencies, stacking) holds for it unchanged.
- `$` reaches only functions declared in `hooks/register.tsx`; `hooks/codex.ts` is pure.
- The repository is public: no private names in code, docs, tests or fixtures.
- Commit after each task on `claude/codex-subscription-integration-b2e3f7`, with the trailer `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Never push.
- Task 1 gates shipping, not building: tasks 2 to 10 may be built before it, but the branch is not merged until both proofs of task 1 pass (spec 3.4, 10).

## Review Focus

1. **A JSON event split across two pieces of the stream, or a line that is not JSON** (Codex prints warnings on stdout at times): the reader buffers the half line and skips the bad one; no event is lost and nothing throws. Test in task 5.
2. **The owner's `~/.codex/config.toml` turns network on, or names MCP servers with quotes or dots** (`[mcp_servers."my.server"]`): the argv still forces network off and switches each one off by its exact name. Test in task 5.
3. **Codex ends well but changed nothing** (it answered in prose, or wrote only ignored files): no empty commit, no pull request; the task is `failed` with Codex's last words. Test in task 7.
4. **`worker_start` twice for the same task, or the orchestrator moving the task out of `building` mid-run:** the second start is refused inside the write queue, and a task that leaves `building` by another hand ends its child. Tests in tasks 6 and 8.
5. **The pull request already exists** (the session closed after the push and before the number was recorded): GitHub answers 422; the runner finds the open pull request of that head and takes it over. Test in task 7.

---

### Task 1: The two proofs (owner-assisted)

Spec 3.4 names two things nothing has proven. Neither can run inside `claude plugin test`: the first needs a live Claude Code session, so the owner's session runs it.

**Files:**
- Create: `docs/superpowers/proofs/2026-11-10-codex-worker.md` (what was run, the output, pass or fail)
- Create (scratch, not committed): a throwaway mod under the scratchpad with one command `/codex-proof`

- [ ] **Step 1: No network in the sandbox.** In a scratch clone of a GitHub repository with `gh` signed in, run it once as below and once as a second turn (`codex exec resume --json -c 'sandbox_mode="workspace-write"' … <thread id> -` from inside the clone), since a resumed turn sets its sandbox differently:

```bash
codex exec -C <clone> -s workspace-write -c sandbox_workspace_write.network_access=false -c agents.enabled=false --json - <<'EOF'
Run these three commands one by one and report each exit code and the last line of output verbatim. Do not try anything else.
1. curl -sS -m 10 https://api.github.com/zen
2. gh pr list
3. git push --dry-run origin HEAD
EOF
```

Pass: all three fail for want of network, and the repository on GitHub is unchanged. Run it a second time with `network_access=true` in a scratch `CODEX_HOME` config and the same `-c` override, to show the override wins.

- [ ] **Step 2: A long run kept by `$.process.spawn`.** The scratch mod's `/codex-proof` spawns `codex exec` (same flags) with the brief "Run `sleep 300` thirteen times; after each, append one line with the time to `proof.log`", reads the stream as `loreLong` does, and writes each event's arrival time to the mod's log. While it runs, the owner takes at least five ordinary turns in the session, one of them with a subagent. Pass: 65 minutes later the child's exit code arrives, every `item.completed` was logged within seconds of its time in `proof.log`, and no turn of the session waited on it.

- [ ] **Step 3: Record both results** in the proofs file and commit it. If step 1 fails, stop: piece 1 does not ship until a trusted Codex hook is shown to refuse `gh pr merge` and a push to the base branch (spec 3.4). If step 2 fails, stop and bring the carrier design back to the owner (spec 8). Do not work around either.

### Task 2: The `workers` settings

**Files:**
- Modify: `types/index.d.ts` (`ProjectConfig`, `Place`), `hooks/project.ts` (`parseConfig`, `TOP`, `PLACE`, `homeConfigProblem`, `placeConfig`)
- Test: `tests/project.test.ts`

**Interfaces:**
- Produces, in `types/index.d.ts`:

```ts
type WorkerKind = 'claude' | 'codex'
type WorkerNote = { kind: WorkerKind; for: string; proven: boolean }
type Workers = {
  codex?: boolean
  notes?: WorkerNote[]
  models?: Partial<Record<ModelTier, { model: string; effort?: 'low' | 'medium' | 'high' }>>
  mcp?: string[]            // Codex MCP servers a Codex worker may keep
}
// ProjectConfig gains  workers?: Workers
// Place gains          workers?: { notes?: WorkerNote[] }
```

- [ ] **Step 1: Write the failing tests** in `tests/project.test.ts`:

```ts
test('workers: the switch, notes, models and servers are read', () => {
  const text = JSON.stringify({ workers: { codex: true, mcp: ['blender'],
    models: { sonnet: { model: 'gpt-5.1-codex', effort: 'medium' } },
    notes: [{ kind: 'codex', for: '3D work: Blender scenes, meshes, materials', proven: false }] } })
  expect(parseConfig(text)).toEqual({ config: JSON.parse(text) })
})
test('workers: a wrong value is refused by name', () => {
  const bad = (workers: unknown) => (parseConfig(JSON.stringify({ workers })) as { error: string }).error
  expect(bad({ codex: 'yes' })).toContain('workers.codex')
  expect(bad({ notes: [{ kind: 'gemini', for: 'x', proven: true }] })).toContain('workers.notes[0].kind')
  expect(bad({ notes: [{ kind: 'codex', for: '', proven: true }] })).toContain('workers.notes[0].for')
  expect(bad({ models: { best: { model: 'x' } } })).toContain('workers.models.best')
  expect(bad({ sandbox: 'danger-full-access' })).toContain('workers.sandbox')
})
test('folder home: the home notes apply to a place, the place notes on top', () => {
  const home = { workers: { codex: true, notes: [{ kind: 'codex', for: 'tests', proven: true }] } }
  const place = { folder: 'game/art', teams: ['ABC'], workers: { notes: [{ kind: 'codex', for: '3D work', proven: false }] } }
  expect(placeConfig(place, 'ABC', home).workers).toEqual({ codex: true,
    notes: [{ kind: 'codex', for: 'tests', proven: true }, { kind: 'codex', for: '3D work', proven: false }] })
})
test('folder home: a place cannot switch Codex on or off by itself', () => {
  const text = JSON.stringify({ places: [{ folder: 'a', teams: ['ABC'], workers: { codex: true } }] })
  expect((parseConfig(text) as { error: string }).error).toContain('places[0].workers.codex')
})
```

- [ ] **Step 2: Run** `claude plugin test .` — expected: the four new tests FAIL (`workers` is an unknown key today).
- [ ] **Step 3: Implement.** Add `'workers'` to `TOP` and `PLACE`; a `checkWorkers(json, where, inPlace: boolean)` beside `checkCheck`, refusing unknown keys through `keysOf`; `placeConfig(place: Place, team: string, home?: ProjectConfig): ProjectConfig` gains the third parameter (today's two-argument calls keep their result) and its caller in `register.tsx` passes the home config. `homeConfigProblem` lets `workers` stand at the top of a folder home.
- [ ] **Step 4: Run** again — the whole suite PASSES.
- [ ] **Step 5: Commit** `config: workers settings (the Codex switch, notes, models, servers)`.

### Task 3: A task's kind of worker, in the ledger

**Files:**
- Modify: `types/index.d.ts` (`Task`, `Ledger['run']`), `hooks/ledger.ts` (`task`, the run parser), `hooks/signals.ts`, `hooks/plan.ts` (`RunMore`)
- Test: `tests/ledger.test.ts`, `tests/signals.test.ts`

**Interfaces:**
- Consumes: `WorkerKind`, `WorkerNote`, `Workers` (task 2).
- Produces, on `Task`: `kind?: WorkerKind` (absent means `claude`), `kindReason?: string`, `kindWhy?: 'owner' | 'note' | 'trial' | 'design' | 'spread'`, `thread?: string` (Codex's thread id), `turns?: number` (Codex turns run since the last start), `lastWords?: string`.
- Produces, on `Ledger['run']`: `codex?: { ready: boolean; why?: string; servers?: string[] }` (set at `/conduct`, task 9; absent means Codex is off). `RunMore` gains `'codex'`.
- Produces, in `hooks/signals.ts`:

```ts
export const KINDS = ['claude', 'codex'] as const
export const kindOf = (task: { kind?: WorkerKind }): WorkerKind => task.kind ?? 'claude'
// Decides a new or changed kind. kindNote is the 1-based index into run.config.workers.notes.
export function rekind(raw: Raw, task: RawTask, caller: Caller,
  kind: WorkerKind, reason: string | undefined, kindNote: number | undefined): string | undefined  // a refusal text, or undefined
export function ownerSetsKind(raw: Raw, taskId: string, kind: string): Outcome
```

`rekind` rules, each with its refusal text:
- only for a `queued` task: "… has started; its kind of worker is fixed."
- `codex` while `run.codex?.ready` is not true: "Codex workers are off for this run" plus `run.codex.why` when there is one.
- the orchestrator needs `reason`; the owner does not, and the owner's choice sets `kindWhy = 'owner'`, after which the orchestrator's `rekind` on that task is refused ("the owner chose …"), as `tierBy: 'owner'` does for the tier.
- `kindNote` must name an existing note of the same `kind`; then `kindWhy` is `'note'` when it is proven, `'trial'` when not.
- no `kindNote`: an `opus` task asked for `codex` is refused ("architecture and design stay on Claude unless a suitability note says otherwise"); an `opus` task on `claude` gets `'design'`; anything else `'spread'`.
- `addTask` and `updateTask` take `kind`, `kindReason`, `kindNote` from their input and call `rekind`. While `run.codex?.ready` is true, `addTask` without `kind` is refused: "say which kind of worker builds it: claude or codex, with kindReason". While it is not, a missing `kind` stays absent and nothing else changes.
- `retier` to `opus` on a `codex` task whose `kindWhy` is `'spread'` is refused the same way as above.

- [ ] **Step 1: Write the failing tests.** `tests/ledger.test.ts`: a ledger whose task has `kind: 'codex', kindReason: 'r', kindWhy: 'trial', thread: 'th-1', turns: 1, lastWords: 'done'` and whose run has `codex: { ready: true, servers: ['pencil'] }` parses to the same values; `kind: 'gemini'` and `kindWhy: 'because'` are refused naming the field. `tests/signals.test.ts` (with `LEDGER`, `withTask` from `tests/fixture.ts`; `ready` is the ledger with `run.codex = { ready: true }` and the note of task 2 as note 1):

```ts
test('kind: the orchestrator needs a reason, the owner does not', () => {
  expect(addTask(ready, ORCH, { id: 'a', title: 't', tier: 'sonnet', tierReason: 'r', kind: 'codex' })).toMatchObject({ refused: expect.stringContaining('kindReason') })
  expect(ownerSetsKind(withTask(ready, { id: 'a', status: 'queued' }), 'a', 'codex')).toMatchObject({ changed: expect.any(String) })
})
test('kind: why a task has its kind is recorded', () => {
  const why = (input: object) => taskOf(addTask(ready, ORCH, { id: 'a', title: 't', tier: 'sonnet', tierReason: 'r', kindReason: 'k', ...input }), 'a').kindWhy
  expect(why({ kind: 'codex' })).toBe('spread')
  expect(why({ kind: 'codex', kindNote: 1 })).toBe('trial')
  expect(why({ kind: 'claude', tier: 'opus' })).toBe('design')
})
test('kind: an opus task goes to Codex only on a note', () => {
  expect(addTask(ready, ORCH, { id: 'a', title: 't', tier: 'opus', tierReason: 'r', kind: 'codex', kindReason: 'k' })).toMatchObject({ refused: expect.stringContaining('stay on Claude') })
})
test('kind: without Codex, a task without a kind is added as today', () => {
  expect(taskOf(addTask(LEDGER, ORCH, { id: 'a', title: 't', tier: 'sonnet', tierReason: 'r' }), 'a').kind).toBeUndefined()
  expect(addTask(LEDGER, ORCH, { id: 'a', title: 't', tier: 'sonnet', tierReason: 'r', kind: 'codex', kindReason: 'k' })).toMatchObject({ refused: expect.stringContaining('off for this run') })
})
test('kind: fixed once started, and the owner\'s choice stands', () => { /* building → refused 'has started'; owner then orchestrator → refused 'the owner chose' */ })
```

(`ORCH` and `taskOf` are the caller and the reader the file already uses under its own names; keep those.)

- [ ] **Step 2: Run** `claude plugin test .` — the new tests FAIL.
- [ ] **Step 3: Implement** the fields in the parser (`oneOf`, `optionalText`, `optionalNumber`) and `rekind`, `ownerSetsKind`, `kindOf` as specified.
- [ ] **Step 4: Run** — PASS; whole suite green.
- [ ] **Step 5: Commit** `ledger: a task's kind of worker and why it has it`.

### Task 4: Choosing the kind: the tools, `/worker`, and the planning text

**Files:**
- Modify: `hooks/register.tsx` (schemas of `task_add` and `task_update`, a `listCommand` and handler for `worker` beside `tier`, `pickKind` beside `pick`), `hooks/plan.ts` (`planning`), `hooks/board.ts` (`detail`), `hooks/dashboard.ts` (the lines that show `task.tier`)
- Test: `tests/routing.test.ts`, `tests/plan.test.ts`, `tests/board.test.ts`, `tests/dashboard.test.ts`

**Interfaces:**
- Consumes: `rekind`, `ownerSetsKind`, `kindOf` (task 3).
- Produces: `task_add` and `task_update` accept `kind` (`enum: KINDS`), `kindReason` (string), `kindNote` (integer ≥ 1) — added to the schema **only** when `run.codex?.ready`; `/worker <task> claude|codex`; `planning(id, source, title?, workers?: Workers)` appends, only when `workers?.codex`, one paragraph (below) and the numbered notes.
- Planning paragraph, exact copy:

> Workers: Codex builds next to Claude in this run. Give every task a kind of worker, `claude` or `codex`, with `kindReason`. Spread the work: unless a note below or the task itself speaks for one side, give about half of the buildable tasks to each. Architecture and design tasks (opus) stay on Claude unless a note says otherwise. A note is a hint, not a rule; when you follow one, pass its number as `kindNote`. A task that follows a note marked "not proven" is a trial: say so in the plan. A Codex worker cannot ask you anything while it builds and has no board tools, so give it tasks whose brief stands on its own.

Each note is one line: `1. codex: 3D work: Blender scenes, meshes, materials (not proven)`.

- The board and the dashboard show the kind after the tier only when it is `codex`: `sonnet · codex`, and `sonnet · codex · trial` when `kindWhy` is `'trial'`. A `claude` task's line is unchanged.

- [ ] **Step 1: Write the failing tests.** `tests/plan.test.ts`: `planning('r1', 'src')` equals today's text; with `{ codex: true, notes: [note] }` it contains the paragraph's first sentence and the note line above. `tests/board.test.ts`: `detail` of a `codex` trial task contains `sonnet · codex · trial`; of a task without `kind` it is unchanged (compare with the existing expectation). `tests/routing.test.ts`, in the file's style (`bound`, `call`, `command`):

```ts
test('/worker sets the kind of a queued task, and the orchestrator cannot undo it', async () => {
  const $ = await bound(world, codexReady)                       // a run with run.codex.ready and task t1 queued
  await command($, 'worker', 't1 codex')
  expect(board($).tasks.t1).toMatchObject({ kind: 'codex', kindWhy: 'owner' })
  expect(await call($, 'task_update', { task: 't1', kind: 'claude', kindReason: 'x' })).toContain('the owner chose')
})
test('/worker: usage on a wrong word; refused when Codex is off', async () => {
  expect(await command(await bound(world, codexReady), 'worker', 't1 gemini')).toContain('/worker <task> claude|codex')
  expect(await command(await bound(world, plain), 'worker', 't1 codex')).toContain('off for this run')
})
test('without Codex, task_add has no kind in its schema', async () => {
  expect(Object.keys(schemaOf(await bound(world, plain), 'task_add').properties)).not.toContain('kind')
})
```

- [ ] **Step 2: Run** the four files — the new tests FAIL.
- [ ] **Step 3: Implement.** `pickKind($, taskId, kind)` mirrors `pick` (inside `mutate`). The `/conduct` handler passes `config.workers` to `planning` only when the run's `codex.ready` is true.
- [ ] **Step 4: Run** — PASS; whole suite green.
- [ ] **Step 5: Commit** `plan and board: the kind of worker, /worker, and the suitability notes`.

### Task 5: `hooks/codex.ts`, the pure part

**Files:**
- Create: `hooks/codex.ts`
- Test: `tests/codex.test.ts`

**Interfaces:**
- Consumes: `forTask` and the `brief.md` filling used by `briefing` in `hooks/posts.ts` (export what is needed; do not copy it).
- Produces:

```ts
export const LAST_WORDS_MAX = 20_000
export type CodexTurn = { cwd: string; servers: readonly string[]; model?: string; effort?: string; thread?: string }
export function codexArgv(turn: CodexTurn): string[]
export function serversIn(toml: string | undefined): string[]            // names under [mcp_servers.<name>]
export function serversOff(found: readonly string[], kept: readonly string[] | undefined): string[]
export type CodexEvent =
  | { is: 'thread'; id: string }
  | { is: 'files'; paths: string[] }          // absolute, as Codex gives them
  | { is: 'said'; text: string }              // an agent_message
  | { is: 'ran'; command: string }            // a command_execution, started or completed
  | { is: 'ended'; ok: boolean; error?: string }   // turn.completed / turn.failed / error
export function reader(): { feed(text: string): CodexEvent[]; rest(): CodexEvent[] }
export function codexBrief(ledger: Ledger, task: Task, project?: { brief: string; slot: number }): string
export function again(why: { error?: string; check?: string; rulings?: string }): string   // the second turn's prompt
export type After = 'again' | 'open' | 'fail'
export function after(turn: { number: 1 | 2; ok: boolean; check: 'passed' | 'failed' | 'none'; changed: boolean }): After
```

- `codexArgv` without a thread: `['codex','exec','-C',cwd,'-s','workspace-write','--json','-c','sandbox_workspace_write.network_access=false','-c','agents.enabled=false', …one '-c','mcp_servers.<name>.enabled=false' per server…, …'-m',model…, …'-c','model_reasoning_effort=<effort>'…, '-']`. With a thread: `['codex','exec','resume','--json','-c','sandbox_mode="workspace-write"', …the same `-c` and `-m` options…, thread, '-']`: `codex exec resume` (0.167.0) takes neither `-C` nor `-s`, so the folder is the child's `cwd` and the sandbox is set by `-c`. The runner always spawns with `cwd` the worktree, for both forms. A server name that is not `[A-Za-z0-9_-]+` is written as a quoted TOML key: `mcp_servers."my.server".enabled=false`.
- `after`: not ok or check failed → `'again'` on turn 1, `'fail'` on turn 2; ok and check not failed → `'open'` when `changed`, else `'fail'`.
- `codexBrief` says, in this order: which task of which run it builds and that it works alone in this folder; what it must not do (commit, push, open a pull request, touch anything outside the folder: the conductor does those when it ends); to read `CLAUDE.md` at the root when there is one, as the project's instructions; the task's title, files, rulings and findings (through `forTask`); the project's `brief.md` filled as for a Claude worker; and to end with a short report of what it changed and what it could not do, which becomes the pull request's description.

- [ ] **Step 1: Write the failing tests** in `tests/codex.test.ts`:

```ts
test('argv: the sandbox is fixed and the brief is not in it', () => {
  const argv = codexArgv({ cwd: '/work/w 1', servers: ['pencil', 'my.server'], model: 'gpt-5.1-codex', effort: 'medium' })
  expect(argv.slice(0, 6)).toEqual(['codex', 'exec', '-C', '/work/w 1', '-s', 'workspace-write'])
  expect(argv).toContain('sandbox_workspace_write.network_access=false')
  expect(argv).toContain('agents.enabled=false')
  expect(argv).toContain('mcp_servers.pencil.enabled=false')
  expect(argv).toContain('mcp_servers."my.server".enabled=false')
  expect(argv.at(-1)).toBe('-')
  expect(argv.join(' ')).not.toMatch(/danger|bypass/)
})
test('argv: a second turn resumes the thread', () => {
  const argv = codexArgv({ cwd: '/w', servers: [], thread: 'th-1' })
  expect(argv.slice(0, 3)).toEqual(['codex', 'exec', 'resume'])
  expect(argv.slice(-2)).toEqual(['th-1', '-'])
  expect(argv).toContain('sandbox_mode="workspace-write"')
  expect(argv).toContain('sandbox_workspace_write.network_access=false')
  expect(argv).not.toContain('-C'); expect(argv).not.toContain('-s')
})
test('servers: read from the config, the kept ones left on', () => {
  const toml = '[mcp_servers.pencil]\ncommand = "x"\n[mcp_servers."my.server".env]\nA = "1"\n[mcp_servers.blender]\n'
  expect(serversIn(toml)).toEqual(['pencil', 'my.server', 'blender'])
  expect(serversOff(serversIn(toml), ['blender'])).toEqual(['pencil', 'my.server'])
  expect(serversIn(undefined)).toEqual([])
})
test('reader: events across pieces, and lines that are not events', () => {
  const read = reader()
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/w/a.ts', kind: 'update' }] } })
  expect(read.feed('warning: something\n' + line.slice(0, 20))).toEqual([])
  expect(read.feed(line.slice(20) + '\n{"type":"thread.started","thread_id":"th-1"}\n')).toEqual([
    { is: 'files', paths: ['/w/a.ts'] }, { is: 'thread', id: 'th-1' }])
  expect(read.feed('{"type":"turn.completed","usage":{}}')).toEqual([])
  expect(read.rest()).toEqual([{ is: 'ended', ok: true }])
})
test('reader: a failed turn carries its error', () => {
  expect(reader().feed('{"type":"turn.failed","error":{"message":"usage limit reached"}}\n')).toEqual([{ is: 'ended', ok: false, error: 'usage limit reached' }])
})
test('after: one more turn, once', () => {
  expect(after({ number: 1, ok: false, check: 'none', changed: true })).toBe('again')
  expect(after({ number: 1, ok: true, check: 'failed', changed: true })).toBe('again')
  expect(after({ number: 2, ok: true, check: 'failed', changed: true })).toBe('fail')
  expect(after({ number: 1, ok: true, check: 'passed', changed: true })).toBe('open')
  expect(after({ number: 1, ok: true, check: 'none', changed: false })).toBe('fail')
})
test('brief: what a Codex worker is told', () => {
  const text = codexBrief(withRuling, task, { brief: 'Task {task}, slot {slot}.', slot: 2 })
  expect(text).toContain('`t1`'); expect(text).toContain('Do not commit'); expect(text).toContain('CLAUDE.md')
  expect(text).toContain('Task t1, slot 2.'); expect(text).toContain(rulingText(theRuling))
  expect(text).not.toContain('mcp__conductor__')
})
```

- [ ] **Step 2: Run** `claude plugin test .` — FAIL: the module does not exist.
- [ ] **Step 3: Implement** `hooks/codex.ts` to these signatures.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `codex: the argv, the event reader, the brief and the decision after a turn`.

### Task 6: `worker_start`, and the Agent tool on a Codex task

**Files:**
- Modify: `hooks/router.ts`, `hooks/register.tsx` (a `listTool` and handler for `worker_start`; the `agent.spawn` hook; the orchestrator's standing instructions), `tests/world.ts`
- Test: `tests/router.test.ts`, `tests/codex-start.test.ts` (new)

**Interfaces:**
- Consumes: `kindOf` (task 3); `reserved`, `released` from `hooks/signals.ts`; `gitWorktreeFor`.
- Produces, in `hooks/router.ts`: `export function routeCodex(ledger: Ledger, taskId: string): { is: 'start'; slot: number; base?: Base } | { is: 'deny'; text: string }` — the same `readiness` and `preflight` as a Claude worker. `route` denies a spawn that names a `codex` task: "`t1` is built by Codex: start it with worker_start, not with the Agent tool."
- Produces, in `register.tsx`: tool `worker_start` `{ task: string }`, registered only when `run.codex?.ready`, for the orchestrator only. Refusals: a `claude` task ("`t1` is built by Claude: start its worker with the Agent tool."); whatever `routeCodex` denies; a task whose run is already in the module's `runs` ("`t1` is already running."). On success it claims the task inside `mutate` (`reserved`, status `building`), makes the worktree with `gitWorktreeFor` (branch and path as for a folder-home git worker), hands over to `codexWork($, taskId)` **without awaiting it**, and answers "Codex is building `t1` in `<path>`. You are woken when it ends." If the worktree cannot be made, the claim is released and the error returned.
- Produces, in `register.tsx`: `const runs = new Map<string, { stop(): void }>()` at module level; `codexWork` is a stub in this task that registers itself in `runs` and returns (task 7 fills it).
- `tests/world.ts`, additively: `state.codex: { version: string | false; login: boolean; toml?: string; turns: Array<{ events: object[]; code: number; writes?: string[]; holds?: boolean }>; inputs: string[] }`. The faked `process.run` answers `codex --version` and `codex login status` from it; the faked `process.spawn` for `argv[0] === 'codex'` records `input` in `inputs`, plays the next turn's events as stdout lines, marks `writes` as changed files of the worktree for the faked `git status --porcelain`, and ends with `code` (a turn with `holds` ends only when the stream is returned). A helper `codexRun(on, more?)` gives a started world whose run has `codex.ready` and a queued `codex` task `t1` beside a queued `claude` task `t2`.

- [ ] **Step 1: Write the failing tests.** `tests/router.test.ts`: `route` on a codex task denies with `worker_start` in the text; `routeCodex` denies an unapproved run, a paused run, a task with an unfinished dependency, and a fourth task when three are building, with the texts `route` gives a Claude worker for the same. `tests/codex-start.test.ts`:

```ts
test('worker_start claims the task and makes its worktree', async () => {
  const $ = await codexRun(on, { turns: [{ events: [], code: 0, holds: true }] })
  expect(await call($, 'worker_start', { task: 't1' })).toContain('Codex is building `t1`')
  expect(board($).tasks.t1).toMatchObject({ status: 'building', kind: 'codex' })
  expect(state($).calls.some((c) => c.argv.slice(0, 3).join(' ') === 'git worktree add')).toBe(true)
})
test('worker_start twice: the second is refused', async () => {
  const $ = await codexRun(on, { turns: [{ events: [], code: 0, holds: true }] })
  const [a, b] = await Promise.all([call($, 'worker_start', { task: 't1' }), call($, 'worker_start', { task: 't1' })])
  expect([a, b].filter((text) => text.includes('Codex is building'))).toHaveLength(1)
})
test('each kind has its own way to start', async () => {
  const $ = await codexRun(on)
  expect(await call($, 'worker_start', { task: 't2' })).toContain('Agent tool')
  expect((await spawn($, { name: 't1' })).deny).toContain('worker_start')
})
test('only the orchestrator starts a Codex worker', async () => { /* call with a worker's agentId → the refusal the other orchestrator tools give */ })
test('without Codex there is no worker_start', async () => { expect(state(await start(on)).registered).not.toContain('worker_start') })
```

- [ ] **Step 2: Run** `claude plugin test .` — FAIL.
- [ ] **Step 3: Implement** as specified. In the orchestrator's standing instructions, add (only when `run.codex?.ready`): "A task whose kind is codex is started with `worker_start`, not with the Agent tool. It cannot be messaged; a ruling reaches it only if it needs a second turn. It ends by itself: you are woken with its pull request, or with why it failed."
- [ ] **Step 4: Run** — PASS; whole suite green.
- [ ] **Step 5: Commit** `worker_start: the orchestrator starts a Codex worker through the router`.

### Task 7: The runner

**Files:**
- Modify: `hooks/register.tsx` (`codexWork`; a `runCheck($, cwd, check)` taken out of `runCheckTool` if it is not already separate)
- Test: `tests/codex-run.test.ts` (new)

**Interfaces:**
- Consumes: `codexArgv`, `serversOff`, `reader`, `codexBrief`, `again`, `after`, `LAST_WORDS_MAX` (task 5); `touch` and `relative` from `hooks/posts.ts`; `acted`, `updateTask` paths in `hooks/signals.ts`; `runProgram`, `github`, `keeper`, `asks`.
- Produces: `async function codexWork($: Mod, taskId: string): Promise<void>` — never throws; every way out ends in exactly one of the two endings below, and removes the task from `runs`.

What it does, in order (spec 4.3, steps 4 to 8):
1. Spawn, with `cwd` the worktree, `codexArgv({ cwd, servers: serversOff(run.codex.servers, config.workers.mcp), model, effort, thread: task.thread })` with `input` the brief (`codexBrief`, or, when `task.thread` is set because the session was restarted, `again({})` naming the rulings since). `model` and `effort` come from `config.workers.models[task.tier]`.
2. For each event: `thread` → `task.thread`, written at once; `files` → `touch` with paths made relative to the worktree, at once; `said` → kept as the last message; every event → `acted`, but at most one ledger write per 30 seconds for activity alone.
3. When the child ends: `ok` is exit 0 and no failed `ended` event. If ok and the project has a `check`, run it in the worktree. `changed` is: `git status --porcelain` is not empty, or the branch is ahead of its start.
4. `after(...)`: `'again'` → `turns = 1`, spawn once more with `thread` and `again({ error, check: the check's output cut to 4,000 characters, rulings })`; then back to 2.
5. `'open'` → `git add -A`, `git commit -m "<taskId>: <title>"`, `git push -u origin <branch>`, then `POST /pulls` `{ title: "<taskId>: <title>", head: branch, base, body: last message + the 🤖 line naming Codex }`. A 422 that says a pull request exists → `GET /pulls?head=<owner>:<branch>&state=open` and take the first. Task: `status: 'review'`, `pr`, `branch`, `lastWords`. Ask: "Run board: Codex finished `t1`: pull request #N. Review it as you would a worker's."
6. `'fail'`, or any step of 5 failing → if there are changes, commit and push them (no pull request); task `status: 'failed'`, `lastWords`, `note` the one-line cause (`Codex: <error>`, `the check failed twice`, `Codex changed nothing`, `push failed: …`). Ask: "Run board: Codex could not finish `t1`: <cause>. Its last words: <first 600 characters>. Its work so far is on `<branch>`." 
7. Both endings go through `asks`, so `wake($)` submits them from the timer.

- [ ] **Step 1: Write the failing tests** in `tests/codex-run.test.ts` (world of task 6; `ended($)` waits until `t1` left `building`):

```ts
const thread = { type: 'thread.started', thread_id: 'th-1' }
const wrote = { type: 'item.completed', item: { type: 'file_change', changes: [{ path: `${WORKTREE}/src/a.ts`, kind: 'update' }] } }
const said = (text: string) => ({ type: 'item.completed', item: { type: 'agent_message', text } })
const done = { type: 'turn.completed', usage: {} }

test('a clean run ends in review with a pull request', async () => {
  const $ = await started({ turns: [{ events: [thread, wrote, said('Added a.'), done], code: 0, writes: ['src/a.ts'] }] })
  await ended($)
  expect(board($).tasks.t1).toMatchObject({ status: 'review', pr: 1, thread: 'th-1', touched: ['src/a.ts'], lastWords: 'Added a.' })
  expect(state($).forge.asked).toContain(`POST ${API}/repos/${REPO}/pulls`)
  expect(state($).woke.at(-1)).toContain('pull request #1')
  expect(state($).codex.inputs[0]).toContain('Do not commit')
})
test('a failed check gets one more turn on the same thread', async () => {
  const $ = await started({ check: 'fails-once', turns: [turnOk, turnOk] })
  await ended($)
  expect(spawned($).map((c) => c.argv.slice(0, 3).join(' '))).toEqual(['codex exec -C', 'codex exec resume'])
  expect(state($).codex.inputs[1]).toContain('the check failed')
  expect(board($).tasks.t1.status).toBe('review')
})
test('a second failure ends the task, with what there is pushed and no pull request', async () => {
  const $ = await started({ check: 'fails', turns: [turnOk, turnOk] })
  await ended($)
  expect(board($).tasks.t1).toMatchObject({ status: 'failed', note: 'the check failed twice' })
  expect(spawned($)).toHaveLength(2)
  expect(gitCalls($)).toContain('push'); expect(state($).forge.asked.filter((a) => a.startsWith('POST'))).toEqual([])
  expect(state($).woke.at(-1)).toContain('could not finish `t1`')
})
test('Codex changed nothing: no commit, no pull request', async () => {
  const $ = await started({ turns: [{ events: [thread, said('Nothing to do.'), done], code: 0 }] })
  await ended($)
  expect(board($).tasks.t1).toMatchObject({ status: 'failed', note: 'Codex changed nothing', lastWords: 'Nothing to do.' })
  expect(gitCalls($)).not.toContain('commit')
})
test('Codex out of budget: its error is the cause', async () => {
  const failed = { type: 'turn.failed', error: { message: 'usage limit reached' } }
  const $ = await started({ turns: [{ events: [thread, failed], code: 1 }, { events: [failed], code: 1 }] })
  await ended($)
  expect(board($).tasks.t1.note).toBe('Codex: usage limit reached')
})
test('the pull request already exists: it is taken over', async () => {
  const $ = await started({ turns: [turnOk], forge: { createAnswers: 422, pulls: { 7: { head: BRANCH, state: 'open' } } } })
  await ended($)
  expect(board($).tasks.t1).toMatchObject({ status: 'review', pr: 7 })
})
test('last words are cut, and no token reaches the ledger or the pull request', async () => {
  const $ = await started({ turns: [{ events: [thread, wrote, said('x'.repeat(30_000)), done], code: 0, writes: ['src/a.ts'] }] })
  await ended($)
  expect(board($).tasks.t1.lastWords).toHaveLength(LAST_WORDS_MAX)
  expect(JSON.stringify(board($)) + JSON.stringify(state($).forge)).not.toContain(TOKEN.slice(4))   // the Authorization header aside
})
test('the argv of every turn keeps the sandbox', async () => { /* every spawned codex argv contains '-s','workspace-write' or sandbox_mode, and network_access=false */ })
test('the activity of a busy run is written at most every 30 seconds', async () => { /* 200 'ran' events in one piece → ledger writes ≤ 3 */ })
```

Extend the fake forge additively for `createAnswers` and the `GET /pulls?head=` listing.

- [ ] **Step 2: Run** `claude plugin test .` — FAIL.
- [ ] **Step 3: Implement `codexWork`** following the stream handling of `loreLong` (`keeper()`, `stream.return()` on the way out). The `stop()` it registers in `runs` returns the stream and marks the run as stopped, so that the ending is skipped (task 8 says who calls it).
- [ ] **Step 4: Run** — PASS; whole suite green.
- [ ] **Step 5: Commit** `codex: the runner, from the first turn to the pull request`.

### Task 8: Stopping, restarting and stalls

**Files:**
- Modify: `hooks/register.tsx` (the `task_update` handler; where the mod first reads a run after it loads; the pause path), `hooks/signals.ts` (`sayStalls`)
- Test: `tests/codex-run.test.ts`, `tests/restart.test.ts`, `tests/stall.test.ts`

**Interfaces:**
- Consumes: `runs`, `codexWork` (tasks 6, 7); `stallsDue`, `STALL_MIN`.
- Produces: `function orphans(ledger: Ledger, running: ReadonlySet<string>): string[]` in `hooks/codex.ts` — the `codex` tasks that are `building` and not in `running`.

Rules:
- A `codex` task that leaves `building` by `task_update` (to `queued`, `returned`, `failed`, `blocked`) has its child ended through `runs.get(id)?.stop()`; the runner writes nothing after that.
- When the mod loads into a session with a run (reload, restart of Claude Code), every task of `orphans(ledger, new Set(runs.keys()))` is set `returned` with the note "its Codex run ended with the session; start it again with worker_start to continue", and one ask tells the orchestrator which. A later `worker_start` reuses the worktree (`gitWorktreeFor` already does) and resumes `task.thread`; `turns` starts at 0 again.
- A paused run (`pausedAt`) starts no Codex worker (the router) and does not end a running one: it finishes its turn and its ending waits in `asks` like any other.
- The stall warning for a `codex` task says: "`t1` (Codex) has shown no sign of life for 30 minutes. It cannot be messaged: wait, or set it `returned` to end the run and start it again." instead of the text for a Claude worker.

- [ ] **Step 1: Write the failing tests:**

```ts
test('a task taken out of building ends its Codex run', async () => {
  const $ = await started({ turns: [{ events: [thread], code: 0, holds: true }] })
  await call($, 'task_update', { task: 't1', status: 'returned' })
  expect(state($).stopped).toContain('codex')
  expect(board($).tasks.t1.status).toBe('returned')            // and stays so: the runner wrote nothing after
  expect(state($).forge.asked).toEqual([])
})
test('after a restart, a building Codex task is returned and can continue its thread', async () => {
  const $ = await start(on, ledgerWith({ id: 't1', kind: 'codex', status: 'building', thread: 'th-1' }))
  expect(board($).tasks.t1).toMatchObject({ status: 'returned', thread: 'th-1' })
  expect(state($).woke.at(-1)).toContain('worker_start')
  await call($, 'worker_start', { task: 't1' })
  expect(spawned($)[0].argv.slice(0, 3)).toEqual(['codex', 'exec', 'resume'])
})
test('orphans: only building Codex tasks that are not running', () => { /* claude building, codex review, codex building+running → [] ; codex building → ['t1'] */ })
test('a stalled Codex task is not told to be messaged', () => { expect(sayStalls(stalledCodex)).toContain('cannot be messaged') })
```

- [ ] **Step 2: Run** `claude plugin test .` — the new tests FAIL.
- [ ] **Step 3: Implement** the rules above.
- [ ] **Step 4: Run** — PASS; whole suite green.
- [ ] **Step 5: Commit** `codex: stop with the task, return after a restart, a stall text of its own`.

### Task 9: Is Codex there? Decided at `/conduct`, said once

**Files:**
- Modify: `hooks/register.tsx` (the `/conduct` handler, and the workspace pick of a folder home), `hooks/codex.ts`
- Test: `tests/codex-conduct.test.ts` (new)

**Interfaces:**
- Consumes: `serversIn` (task 5); `runProgram`, `githubToken`; `newRun`'s `RunMore.codex` (task 3).
- Produces, in `hooks/codex.ts`: `export function codexState(facts: { wanted: boolean; workspace: 'git' | 'lore' | 'none'; github: boolean; token: boolean; version: string | undefined; login: boolean; toml: string | undefined }): Ledger['run']['codex'] | undefined` — `undefined` when not wanted. Reasons, first that applies, exact copy:
  - `Codex workers need a git workspace on GitHub.` (Lore, or git without a GitHub remote)
  - `Codex workers need a GitHub token to open pull requests.`
  - `Codex is not installed (no \`codex\` on the PATH).`
  - `Codex is not signed in: run \`codex login\`.`
- In `register.tsx`: `/conduct` (and, in a folder home, the moment the workspace is picked) gathers the facts (`codex --version`, `codex login status` with a 15 second limit each; `~/.codex/config.toml` through `$.fs`, a missing file being fine), stores `run.codex`, and when it is not ready adds **one** line to what `/conduct` tells the owner and one to the planning text: "Codex workers are off for this run: <why> Every task is built by Claude." Nothing repeats it later; `rekind` (task 3) carries the reason for anyone who asks for `codex`.

- [ ] **Step 1: Write the failing tests:**

```ts
test('codexState: each reason, in order', () => {
  const all = { wanted: true, workspace: 'git', github: true, token: true, version: 'codex-cli 0.167.0', login: true, toml: '[mcp_servers.pencil]\n' } as const
  expect(codexState(all)).toEqual({ ready: true, servers: ['pencil'] })
  expect(codexState({ ...all, wanted: false })).toBeUndefined()
  expect(codexState({ ...all, workspace: 'lore' })).toEqual({ ready: false, why: 'Codex workers need a git workspace on GitHub.' })
  expect(codexState({ ...all, token: false })?.why).toContain('GitHub token')
  expect(codexState({ ...all, version: undefined })?.why).toContain('not installed')
  expect(codexState({ ...all, login: false })?.why).toContain('codex login')
})
test('/conduct with the switch on and Codex signed in: the plan asks for kinds', async () => {
  const $ = await conducted(on, { config: { workers: { codex: true } }, codex: { version: 'codex-cli 0.167.0', login: true } })
  expect(board($).run.codex).toMatchObject({ ready: true })
  expect(state($).briefs.at(-1)).toContain('Give every task a kind of worker')
})
test('/conduct with the switch on and no Codex: said once, and every task is Claude\'s', async () => {
  const $ = await conducted(on, { config: { workers: { codex: true } }, codex: { version: false, login: false } })
  expect(board($).run.codex).toEqual({ ready: false, why: 'Codex is not installed (no `codex` on the PATH).' })
  expect(said($).filter((line) => line.includes('Codex workers are off'))).toHaveLength(1)
  expect(state($).registered).not.toContain('worker_start')
})
test('/conduct without the switch never runs codex', async () => {
  const $ = await conducted(on, {})
  expect(state($).calls.some((c) => c.argv[0] === 'codex')).toBe(false)
  expect(board($).run.codex).toBeUndefined()
})
```

- [ ] **Step 2: Run** `claude plugin test .` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; whole suite green.
- [ ] **Step 5: Commit** `conduct: whether Codex can work in this run, decided once and said once`.

### Task 10: How each kind did, the README and the release

**Files:**
- Modify: `hooks/board.ts` and `hooks/dashboard.ts` (the end-of-run summary), `README.md`, `.claude-plugin/plugin.json` (version `0.5.0`)
- Test: `tests/board.test.ts`, `tests/dashboard.test.ts`

**Interfaces:**
- Produces, in `hooks/board.ts`: `export function byKind(ledger: Ledger): string | undefined` — `undefined` when no task is `codex`; else one line per kind that has finished tasks, e.g. `codex: 3 built · 2 merged · 1 failed · 1 needed a second turn · 1 trial (merged)` and `claude: 4 built · 4 merged`. "Built" counts tasks that reached `review`, `green`, `done` or `failed`; "merged" is `done`; "needed a second turn" is `turns >= 1`; each trial is listed with how it ended, so the owner can set its note to `proven`.

- [ ] **Step 1: Write the failing tests:** `byKind` of a ledger with the tasks of the example line gives exactly those two lines; of `LEDGER` gives `undefined`; the finished board and the dashboard contain the lines when there is a Codex task and are unchanged without one.
- [ ] **Step 2: Run** `claude plugin test .` — the new tests FAIL.
- [ ] **Step 3: Implement** `byKind` and show it where the board sums up a finished run.
- [ ] **Step 4: README.** A section "Codex next to Claude" after the settings: the switch and the full `workers` block; what a Codex worker is (the mod runs it, in the sandbox, without network; the mod commits, pushes and opens the pull request); `/worker`; suitability notes and trials; the limits copied from spec 4.3 (Claude Code must stay open; rulings reach only a second turn; no board tools; git on GitHub with a token only; no Lore); and one sentence that the use of a ChatGPT subscription through the Codex CLI falls under OpenAI's terms, which the owner checks for themself.
- [ ] **Step 5: Run** `claude plugin validate . && claude plugin test . && tsc -p .` — all green. Commit `release: 0.5.0, Codex as a worker`.

### Task 11: One real run

Spec 10 asks for it before piece 1 counts as done; it is the owner's session that runs it.

- [ ] **Step 1:** In a scratch GitHub repository with `"workers": { "codex": true }`, `/conduct` a ticket that plans at least one Codex and one Claude task. Check: the plan shows the kinds and reasons; `worker_start` starts the Codex task while the Claude worker builds; the Codex pull request is opened by the mod, reviewed and merged by the orchestrator; the finished board shows the line per kind.
- [ ] **Step 2:** Close Claude Code while a Codex task builds, open it again: the task is `returned`, `worker_start` continues its thread.
- [ ] **Step 3:** Add both results to `docs/superpowers/proofs/2026-11-10-codex-worker.md` and commit. Anything that differs from this plan goes back to the owner before the pull request for piece 1 is opened.
