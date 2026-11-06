# A conductor home that is not a repository: design

Date: 2026-11-06. Status: approved by the owner on 2026-11-06.

## 1. Why

Today conductor's home is the repository the session is in. The mod finds a git repository or a Lore workspace by walking up from the session's folder, and switches on only when that root holds `.claude/conductor/`. The root then serves as four things at once: the place for config and brief, the place for the run ledgers, the code the run works on, and the copy the workers come from.

Some owners keep several projects side by side under one folder that is neither git nor Lore. For example: a git repository for a studio's own tools, and a game whose engine code and art sit in separate Lore workspaces. A session started in that parent folder registers nothing, so `/conduct` is unknown there. The owner wants one place to conduct from. They give `/conduct ABC-4` from anywhere under that folder, and conductor works out which project the ticket belongs in.

conductor is a tool to manage work, so its home doesn't have to be a repository. This change separates three things that are joined today:

1. **The home:** a folder with `.claude/conductor/`, which holds the config, the brief, the board and the run ledgers.
2. **The tickets:** GitHub or Linear, as today.
3. **The workspace:** the git or Lore root a run works in, chosen per run.

## 2. Goals, non-goals, anti-goals

Goals:

- A folder that holds `.claude/conductor/` and is neither a git nor a Lore root becomes a home. This document calls it a **folder home**. Its config, brief, board and run ledgers live in it.
- A session started anywhere at or below a folder home finds it, so `/conduct` works there. A nearer home wins (see 5.1).
- The folder home's config lists **places**. A place is a folder inside the home, with the Linear teams whose tickets may land there and a short line about what belongs there.
- `/conduct ABC-4` reads the ticket, and the run works in one **workspace**: a git or Lore root inside one of that team's places. If there is only one candidate, it is fixed at once. If there are several, the orchestrator reads the ticket and picks one before it plans. The plan names it, so the owner sees it at `/approve`.
- Each kind of workspace keeps what it has today: its own isolation for workers, its merge, its way into the base branch, and its command guard. For git, that is worktrees and pull requests on GitHub. For Lore, it is copy-on-write workspaces, a run branch, `/approve-main` and the `loreByHand` guard.
- A repository with its own `.claude/conductor/` behaves exactly as today. All existing tests pass untouched.

Non-goals:

- **No runs in folders without version control.** A run never edits a folder that isn't inside a git or Lore workspace. When a ticket's work lies outside every workspace, conductor says which folder has to go into Lore or git first. The owner adds it, then starts the run again. (An earlier idea, a "none" workspace kind with a single worker and no rollback, is dropped: the owner would rather add the folder to Lore.)
- **No GitHub issue numbers in a folder home.** `#12` names an issue only within one repository. In a folder home, tickets are Linear. A GitHub issue is run from a session in its own repository, as today.
- **No run across two workspaces.** A ticket that needs both engine code and an art asset becomes two tickets (or two sub-issues), each with its own run.
- **No brief per place.** The home's `brief.md` applies to every run. A repository's own `CLAUDE.md` still reaches workers, because a worker's workspace is a copy of it.
- conductor does not create Lore repositories or workspaces, and it does not change any project's version-control setup.

Anti-goals (a failure even if everything else works):

- A run reads or writes outside the home, or outside its chosen workspace, because of a config path, a `..` or a symlink.
- A repository home that behaves differently from today.
- A worker edits the owner's own checkout of a git repository or the owner's own Lore workspace.
- Private names in this public repository's code, docs, tests or fixtures.

## 3. Constraints

- **Claude Code outside git:** the engine cannot make a worker's worktree, and it asks for a WorktreeCreate hook instead. The mod's own `classic.WorktreeCreate` answers only when a WorktreeCreate *command* hook is declared in the **project** settings, `.claude/settings.json` or `.claude/settings.local.json`. A hook in the mod's `hooks.json` breaks git repositories (spike of 2026-11-06, Lore design §7). Project settings come from the folder the session started in.
- **No repository for the session:** in a folder home, `$.session.repo()` finds nothing. A git workspace's owner and name on GitHub must come from that workspace's own `origin` remote.
- **The mod API:** files go through `$.fs` (`exists`, `list`, `read`, `stat`, `write`) and programs through `$.process.run`. There is no real-path call, so symlinks are resolved by running a program.
- The Lore facts of the Lore and Linear design (§7 there) still hold.

## 4. Decided by the owner

- The home is separate from the repository, in the three layers of §1.
- Runs start from a Linear ticket (`/conduct ABC-4`). Tickets don't name a department or a folder, so conductor reads the ticket and picks.
- One team may have several places. For example, a game team has one place for engine code and another for 3D art.
- A place is a folder, not a single workspace. It may hold several workspaces, now and later, and conductor finds them.
- One run works in one workspace.
- The plan names the workspace, and the owner approves it with the plan. A wrong pick is caught before any worker starts.
- A session anywhere under the home finds it. Starting in the parent folder, in a game's folder or in a repository inside the home all work.
- Work outside every workspace is not done. The folder goes into Lore first.
- A repository with its own `.claude/conductor/` stays its own home and is unchanged, so existing users of the public mod see no difference.

## 5. How it works

### 5.1 Finding the home

The mod walks up from the session's folder. At each folder:

- If it is the root of a git repository or a Lore workspace and holds `.claude/conductor/`, it is a **repository home**. Everything works as today, with that root as home and workspace both.
- If it is the root of a repository without `.claude/conductor/`, the walk goes on above it. (Today the mod stops there and registers nothing.)
- If it holds `.claude/conductor/` and is no repository root, it is a **folder home**. The one exception is a folder inside a repository that is not the repository's root: there, as today, `.claude/conductor/` means nothing and the walk goes on.
- The user's own home folder is never a conductor home: its `.claude/` belongs to Claude Code itself.

The nearest home wins. A repository with its own `.claude/conductor/` inside a folder home stays its own home for sessions started inside it.

A git repository's root is found as today (`$.session.repo()`). A Lore root is a folder that holds `.lore`.

### 5.2 The config of a folder home

```json
{
  "places": [
    { "folder": "studio", "teams": ["ABC"], "about": "the studio's own tools", "check": { "argv": ["npm", "test"], "timeoutMin": 20 } },
    { "folder": "game/code", "teams": ["DEF"], "about": "engine and game code", "lore": { "branchPrefix": "conductor/" } },
    { "folder": "game/art", "teams": ["DEF"], "about": "3D art and source assets" }
  ]
}
```

- `places` is required in a folder home and refused in a repository home.
- Each place has:
  - `folder` (required): a path relative to the home.
  - `teams` (required): one or more Linear team keys.
  - `about` (required): one line the orchestrator reads when it picks.
  - `lore` and `check` (optional): the same shape and checks as today's top-level keys, applied to runs in that place.
  - `base` (optional): the base branch of the place's workspaces. It falls back to the mod's `base` option, as today. Repositories side by side may name their base differently.
- In a folder home, the top-level `lore`, `check` and `linear` keys are refused with a message that says to move them into a place. `tickets` is Linear: it may be left out, and `"github"` is refused.
- **Path rules, failing closed.** `parseConfig` refuses a `folder` that:
  - is empty, `.` or absolute;
  - starts with `~`;
  - has a `..` segment, a backslash or a NUL;
  - names the same folder as another place, or lies inside or above another place.

  At `/conduct`, the mod resolves the real path of the home and of each place it uses. A place whose real path is not strictly inside the home's real path is refused, and so is a place that does not exist, is no folder, or whose real path cannot be read. This catches a symlinked place, or a symlinked folder above it, that leads out of the home.

### 5.3 Workspaces inside a place

A place's workspaces are found when they are needed, never configured. They are:

- the place itself, if it is a git root (`.git`) or a Lore root (`.lore`);
- each of its direct subfolders that is a git or Lore root.

A folder that has both counts as git, as today. Every workspace's real path must lie inside its place's real path. One that doesn't is left out, and the board says so.

### 5.4 Choosing the workspace for a run

- `/conduct ABC-4`: the team is the key before the dash. The places of that team are the candidates' places.
  - No place takes the team: refused, saying to add the team to a place.
  - Those places hold no workspace: refused, saying that the work's folder has to go into Lore or git first.
- Exactly one workspace: it is fixed at once.
- Several workspaces: the ledger lists them as candidates, each with its place's `about`. The orchestrator's first job is to read the ticket and pick one with a new tool, `mcp__conductor__run_workspace`, which takes one of the listed paths.
  - Any other path is refused. The candidates are looked up again on each call, so a folder put into Lore after `/conduct` counts, and one that has gone is refused.
  - Until a workspace is picked, `run_plan` is refused.
  - The orchestrator may change its pick until the plan is approved. After that the workspace is fixed for the run's life.
  - If the work lies outside every candidate, the orchestrator says so on the board and proposes no plan.
- `/conduct path/to/spec.md`: the spec must lie inside a workspace of a place, and that workspace is the run's. When workspaces nest (a place that is a root, with a root below it), the nearest root that holds the spec wins. A spec run with Linear tickets files them in the place's first team.
- `/conduct #12` in a folder home is refused: start the session in the issue's own repository, or use the Linear ticket.

Fixing a workspace does what `/conduct` does today for its kind:

- For Lore, the mod reads the repository's info, names the run branch and checks the WorktreeCreate placeholder.
- For git, it reads the `origin` remote for owner and name, and checks the placeholder when the session isn't inside git.

The run's config snapshot (`run.config`, frozen as today) becomes the place's settings in today's shape: `lore`, `check`, `base`, `tickets: "linear"`, and `linear.team` set to the ticket's own team (for a spec run, the place's first team). The run's base branch is the snapshot's, so `byHand`, the merge, the checks and the worktree start all use the base of the run's own workspace. So the code that reads `projectOf(ledger)` stays as it is. The ledger also gets `run.workspace`: `{ kind, root, place }`, plus the candidates while the pick is open.

The board, the `/approve` prompt and the plan name the workspace, relative to the home.

### 5.5 What follows the run's workspace

In a folder home, "where the session works" (the `backend` today) becomes the bound run's workspace. It is read from the run's ledger, and read again when the session binds to another run. A session is bound to one run at a time, as today. Several runs in different workspaces go on side by side in separate sessions. Everything that today asks the backend follows it:

- **Lore:** `prepareWorkspace` copies the run's workspace. Worker workspaces sit beside it as today, under `<root>.conductor/<run>/<task>` or the place's `lore.workspaces`. Pinning a worker's lore commands with `cd -- ws` is unchanged. The `loreByHand` guard and the orchestrator's lore reads run against the run's workspace. Lore merge and `/approve-main` are unchanged.
- **`runsIgnored`:** checked only in a repository home. In a folder home, the ledgers sit in no workspace.
- **`hasPlaceholder`:** in a folder home, it checks the project settings of the session's own folder, because that is where Claude Code reads them. The message names that folder. In a repository home it checks as today.
- **`brief.md`:** the home's `.claude/conductor/brief.md`. The path still comes from the ledger's path, so it is unchanged.
- **The board:** reads the home's ledgers, and shows each run's workspace.
- **The orchestrator's prompt:** says which workspace the run works in, and that the run's commands run there (`cd -- '<root>'` or `git -C '<root>'`).

### 5.6 Git from a folder home

- **Owner and name:** from the workspace's `origin` remote, not from `$.session.repo()`. `isAtForge` and `repoHere` read the run's workspace.
- **Worker worktrees:** the engine can't make them outside git. So in a folder home the mod's `classic.WorktreeCreate` makes the git worktree itself, as it already does for Lore, with `git -C <root> worktree add`.
  - The worktree sits beside the repository, under `<root>.conductor/<run>/<task>`, never inside the owner's checkout.
  - It starts from the base branch as it is on `origin`, after a fetch, on a branch of its own. The worker then commits, pushes and opens its pull request as today.
  - It is removed with `git worktree remove` at the points where Lore removes its copies. WorktreeRemove doesn't fire for a workspace the mod made.
  - A git worker needs no new pinning. Its worktree shares the repository's remotes, and it starts in its worktree, as a worker in a repository home does today.
- **A session inside a different git repository:** a session may start in git repository X under the home while the run works in Y. The mod answers WorktreeCreate with its own worktree for every run of a folder home. The plan checks this against the real engine early, with a throwaway repository, before anything builds on it. If the engine ignores the mod's answer in a git session, the mod refuses such a run and says to start the session in the home folder. The owner is told which way it went.
- **Guards:** `byHand`, which allows no merge or push to the base branch by hand, is unchanged.
- **In a repository home:** everything as today, including `next(e)` for the engine's own worktree.

### 5.7 Words the owner reads

- No place for the team: "No run was started. No place in .claude/conductor/config.json takes team ABC: add ABC to a place's teams."
- No workspace: "No run was started. game/code holds no git or Lore workspace. Put the folder the work needs into Lore or git first, then give /conduct again."
- A folder that leads out: "config.json: places[1].folder must be a folder inside this home, given relative to it."
- No placeholder: the message of today, naming the session's own folder.

## 6. Testing

Test-first. `claude plugin test .` and `claude plugin validate .` stay clean, and the existing 533 tests pass untouched. New tests cover:

- **`parseConfig`:** the shape of `places`. Every `folder` refusal: empty, `.`, absolute, `~`, `..` at any position, a backslash, a NUL, a duplicate, a place nested in another. Team keys and `about`. Per-place `lore` and `check` reuse today's checks. `places` in a repository home, and top-level `lore`, `check`, `linear` or `tickets: "github"` in a folder home, are refused.
- **Symlink escapes:** a place that is a symlink out of the home. A place under a symlinked folder that leads out. A workspace inside a place that is a symlink out of the place. A real path that can't be read. Each fails closed.
- **Finding the home:**
  - a session in the home itself;
  - in a subfolder that is no repository;
  - in a git repository and in a Lore workspace without their own `.claude/conductor/`;
  - a repository with its own home inside a folder home, where the nearer home wins;
  - `.claude/conductor/` in a repository's subfolder, which is ignored;
  - the user's home folder, which is never a home.
- **Choosing the workspace:**
  - one workspace, fixed at `/conduct`;
  - several, where `run_plan` is refused until `run_workspace` picks, and `run_workspace` refuses a path not listed;
  - a changed pick before approval, and a fixed one after;
  - a spec inside a workspace, and one outside;
  - `#12` refused;
  - no place for the team, and a place with no workspace.
- **`runsIgnored`** is not asked in a folder home and is asked in a repository home. **`hasPlaceholder`** reads the session folder's settings in a folder home.
- **`prepareWorkspace`** copies the run's chosen workspace, not the session's folder or the home.
- **The orchestrator's lore reads and `loreByHand`** run against the chosen workspace.
- **Worker pinning** (`cd -- ws`) is unchanged: today's tests pass as they are.
- **`brief.md`** is read from the home.
- **Git in a folder home:** owner and name from the remote. WorktreeCreate runs `git worktree add` with the right folder, branch and start, and removal runs `git worktree remove`.
- **By hand, at the end:** `claude -p "/conduct"` from a folder home, loaded with `--plugin-dir`, answers with the usage text.

## 7. After the merge (the owner's)

- Switch it on in the owner's parent folder: a `config.json` with its places, and the WorktreeCreate placeholder in that folder's `.claude/settings.local.json`.
- An older repository home inside it stays the home for sessions started in that repository, because the nearer home wins. The owner decides whether to keep it or remove it.

## 8. Calls I made (the owner checks these)

- A place lists `teams` and `about`. Its workspaces are found at the place itself and one level down, never deeper.
- A folder that is both git and Lore counts as git, as today.
- Places may not overlap.
- In a folder home, tickets are Linear, and `#12` is refused.
- The run's config snapshot is the place's settings in today's shape, so the existing code reads it unchanged.
- The pick is made with a new tool, `run_workspace`, and `run_plan` waits for it.
- Git worktrees in a folder home sit beside the repository, under `<root>.conductor/`, and start from the base branch on `origin`.
- The user's own home folder is never a conductor home. `.claude/conductor/` inside a repository, below its root, is ignored as today.
- No brief per place.
- A place may set its own `base`. A ticket run files Linear issues in the ticket's own team, and a spec run in the place's first team.
- The candidates are looked up again when the orchestrator picks. For a spec in nested workspaces, the nearest root wins.
- A session is bound to one run at a time, as today.
- A session inside a different git repository is checked against the real engine before anything builds on it, and falls back to a refusal if needed.
- The work happens on the branch `feature/folder-home` of the conductor repository. It is pushed and offered as a pull request only when the owner says so.

## 9. Left to the builder

- How the per-run backend is carried in the code.
- How real paths are resolved (for example by running `realpath` or `pwd -P`).
- The exact shape of `run_workspace` and its result text.
- The board's layout for the workspace line.
- The git worktree's branch name, matching what the worker's flow expects today.
