# GitHub checks and merging

Complete-delivery plan approval includes reviewed PR merges into its recorded base. No per-PR approval is needed. Explicit review-only restrictions and legacy runs without a full-delivery grant retain their individual merge-approval path. Workers never merge. The adapter uses authenticated `gh api` without reading/logging tokens; prefer connectors for ordinary PR reads and creation.

1. Review the task's actual change and checks, then `task_update` it to `green` with its `pr` number and `branch` recorded.
2. Run `merge_check` with `{"task":"id","closes":[12]}`. `closes` must exactly match the PR's closing statements; use `[]` if none. It checks the current PR head, combined check runs and statuses, mergeability, base target, red base CI, dependencies, pause, open problems, and other merge claims. No checks or unread pages never count as green.
3. Under complete-delivery approval, proceed directly with `merge` using `{"task":"id","closes":[],"head":"full-sha-from-merge-check","told":[],"method":"merge"}`. Review-only/legacy runs need `approve_merge --caller owner` for this head unless consent already exists. Never invent owner authority. `onRedMain:true` is reserved for a task repairing the failing base.
4. The adapter repeats live checks under its repository lock, claims the merge persistently and pins it to the checked SHA. A changed head needs another code review and checks, not another owner prompt within the approved outcome. A different base needs actual authorization. Protection rules remain authoritative.

5. If the write outcome is uncertain, do not retry the merge. Run `reconcile`, which only reads GitHub and adopts a confirmed merge. If GitHub still reports the PR unmerged, inspect it and use `reconcile` with `{"release":true}` only after the original request has settled (at least two minutes). A stale claim is never automatically cleared in the current run.
6. After a confirmed merge, read the base branch's checks and keep checking in this task until they settle. Report a failure as a blocker; do not call the run done until warnings/blockers are addressed. There is no background watcher after the chat stops.

The adapter serializes its own writes across runs in this project, but cannot lock other tools or external actors. GitHub's pinned head protects the PR revision, not a moving base branch. Protection rules should enforce any required up-to-date-base policy.
