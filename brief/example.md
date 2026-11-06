# How to work in this repository

The mod appends this file to every worker's briefing. Copy it to `.claude/conductor/brief.md` in your repository and make it yours. Three names are filled in for each worker:

- `{task}`: the task's id in lower case, every other character an underscore (`t12_1`), so it can name a database or a folder.
- `{slot}`: the worker's number among those building at once (1, 2, 3).
- `{run}`: the run's id.

---

- **Your own branch.** Branch from `origin/main`, unless your briefing above names another branch to build on: then from that one. Commit small and push after every green step: only what is pushed survives a stopped session.
- **Your own resources.** Use the test database `app_{task}_test` and the scratch folder `tmp/{task}/`. Never touch another worker's.
- **Tests.** Run `npm test` before you hand back, and fix what fails, whether or not you broke it. Skip nothing.
- **The pull request.** Open it against `main`. Write `Closes #N` as plain text on a line of its own, and only when your task finishes the issue; otherwise write `Part of #N`. Then set your task to review with its `pr` and `branch`, and hand back.
- **Never** merge, push to `main`, or change files your task does not name without saying so on the board first.
