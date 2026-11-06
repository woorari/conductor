# How to work in this Lore workspace

The mod appends this file to every worker's briefing. Copy it to `.claude/conductor/brief.md` at your workspace's root and make it yours. Three names are filled in for each worker: `{task}`, `{slot}` and `{run}` (see `example.md`).

---

- **Your own workspace and branch.** The mod made both for you: your working directory is your workspace, on your task's branch. Run `lore status --scan` first. Commit small and push after every green step (`lore stage --scan <paths>`, `lore commit "<task id>: <what>"`, `lore push`): only what is pushed survives a stopped session.
- **Binary assets.** `.uasset` and `.umap` files cannot be merged. Take a file's lock with `lore lock acquire <file>` before you change it, and change it only through the editor or a commandlet, never by hand.
- **Building.** Build with the project's own build script, writing into `Intermediate/` and `Binaries/` of your own workspace only. Use the scratch folder `Saved/Workers/{task}/` for anything temporary.
- **Hand-back.** When your change builds and its tests pass, set your task to review with the revision you pushed (`lore branch info` shows it as Remote Latest), and hand back.
- **Never** merge, switch or create branches, push another branch, or touch the owner's workspace.
