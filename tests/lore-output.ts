// Real output of lore 0.12.0+1967, from docs/superpowers/plans/2026-11-06-lore-outputs.txt.
// The server is renamed lore.example.test; nothing else is changed.

export const REV_MAIN = 'cc15628114af5f4e7aee07e0a99a54af1c6693360dbac442cf1d88458e547efd'
export const REV_T1 = '53f36f46d397c857021153a9cfb67ea7122d263d45f2d347088fdc416c582aaa'
export const REV_T2 = '7dc1ead21fef369b9a51fac838168962d0349980fcbd3856fa552fadb499c8f3'
export const REV_RUN = '33bd575ba4252770aa7ddc25c1ddc5d5dd53bc1cf3c1d1f14c8357e8c290e22f'
export const REV_ON_MAIN = 'f8e27cef89404cecc4b071b12de342aa899fe52eed9fad7e820fc302c3003e68'
export const ZEROS = '0'.repeat(64)

export const REPOSITORY_INFO = `conductor-spike (01a1b056c981721b88ecc4b6b66d6f45)

Throwaway repo for conductor Lore spikes

Remote URL: lores://lore.example.test:41337
Default branch: main (e726318bbc3fd75ac8733a7e030cc35b)
Creator: <unknown>
Created: Fri, 6 Nov 2026 10:10:40 +0000
Instance: 01a1b056ccb5739b90b2a9717ed6f5da
`

export const BRANCH_CREATE = `Created branch conductor/S-1-spike/t1 at revision ${REV_MAIN}
`

export const BRANCH_INFO_PUSHED = `Branch conductor/S-1-spike/t1
  ID: 01a1b056ff7174b1841d5932e6e467f1
  Latest: ${REV_T1}
  Remote Latest: ${REV_T1}
  Parent: conductor/S-1-spike at ${REV_MAIN}
          main at ${REV_MAIN}
  Created: Fri, 6 Nov 2026 10:10:55 +0000
`

export const BRANCH_INFO_NEW = `Branch conductor/S-1-spike
  ID: 01a1b056f6bb701783e7a1beb2aa49a0
  Latest: ${REV_MAIN}
  Remote Latest: ${ZEROS}
  Parent: main at ${REV_MAIN}
  Created: Fri, 6 Nov 2026 10:10:51 +0000
`

export const BRANCH_INFO_MAIN_UNSYNCED = `Branch main
  ID: e726318bbc3fd75ac8733a7e030cc35b
  Latest: ${ZEROS}
  Remote Latest: ${REV_ON_MAIN}
  Creator: <unknown>
  Created: Fri, 6 Nov 2026 10:10:40 +0000
`

export const BRANCH_LIST = `Local branches:
* conductor/S-1-spike
  conductor/S-1-spike/t2
  conductor/S-1-spike/t1
  main
Remote branches:
  conductor/S-1-spike/t2
  conductor/S-1-spike
  main
  conductor/S-1-spike/t1
`

export const PUSH_FIRST = `Creating branch conductor/S-1-spike/t1 at ${REV_MAIN}
Pushing 1 fragment(s)
Pushed 1 fragment(s), 261 bytes
Pushing ${REV_T1} to branch conductor/S-1-spike/t1
Pushed revision 2 -> ${REV_T1} to branch conductor/S-1-spike/t1
`

export const PUSH_PROTECTED = `Local branch is 1 revision(s) ahead of remote, pushing all revisions
Repository 01a1b056c981721b88ecc4b6b66d6f45
Pushing 19bdb02e179e7c693d5ca14a97a65703224e0bb6425780110b91e679dbccb63b to branch main
[Error] Not authorized to access repository
  at lore-transport/src/error.rs:34:46
  at lore-revision/src/branch/push.rs:1938 - pushing branch to remote
`

export const PUSH_DIVERGED = `Revision is already pushed and remote has moved forward
[Error] Branch has diverged, sync to merge remote changes
  at lore-revision/src/branch/push.rs:1047:24
`

export const PUSH_NOTHING = `Revision is already pushed and at remote latest
`

export const STATUS_CLEAN = `Repository 01a1b056c981721b88ecc4b6b66d6f45
On branch conductor/S-1-spike/t1 revision 2 -> ${REV_T1}
Remote revision 2 -> ${REV_T1}
Local branch in sync with remote
No tracked changes
`

export const STATUS_UNTRACKED = `On branch conductor/S-1-spike revision 3 -> ${REV_RUN}
Remote revision 3 -> ${REV_RUN}
Local branch in sync with remote
Untracked files:
A untracked.txt
Tracked changes: 1 added
`

export const STATUS_MERGING = `Repository 01a1b056c981721b88ecc4b6b66d6f45
On branch conductor/S-1-spike revision 3 -> ${REV_RUN}
Remote revision 3 -> ${REV_RUN}
Local branch in sync with remote
Pending merge, incoming revision ${REV_T2}
Changes staged for commit:
A dir/c.txt (M)
Changes in conflict:
M  a.txt (M)!
`

export const MERGE_CLEAN = `Starting merge of branch 01a1b056ff7174b1841d5932e6e467f1 revision ${REV_T1}
Merged files, 1 updated, 0 deleted, 0 merged, 0 conflicted
Staged merged repository state 87d256054b5adc53a5d22385d0394fcfb4fdc9869d60757a3f64a116acaac658
Fragmenting files and updating tree hashes
Stored history for 5 nodes
Committed merged repository state 3 -> ${REV_RUN}
`

export const MERGE_CONFLICT = `Starting merge of branch 01a1b057635c768db883b14edaff63d4 revision ${REV_T2}
Merged files, 1 updated, 0 deleted, 0 merged, 1 conflicted
Staged merged repository state f0bc69f9e6a682f7f7f329418380551ca098ef30d8e51e42cbb7c1f1a4bb8c9f
Files in conflict:
a.txt
`

export const MERGE_ABORT = `Merge abort from staged revision f0bc69f9e6a682f7f7f329418380551ca098ef30d8e51e42cbb7c1f1a4bb8c9f to current revision ${REV_RUN}
Merge abort reverted changes
`

export const PROTECTED = `Branch main protected
`

export const UNPROTECTED = `Branch main unprotected
`

export const MERGE_INTO_PROTECTED = `Found 1 files and/or directories potentially affected by merge into
a.txt
Fragmenting files and updating tree hashes
Stored history for 5 nodes
Query 5 fragment(s)
Pushed 5 fragment(s)
[Error] Not authorized to access repository
  at lore-transport/src/error.rs:34:46
  at lore-revision/src/branch/merge.rs:4717 - pushing branch
`

export const MERGE_INTO_DONE = `Found 1 files and/or directories potentially affected by merge into
a.txt
Fragmenting files and updating tree hashes
Stored history for 5 nodes
Query 3 fragment(s)
Pushed 2 fragment(s)
Revision  : 4
Signature : ${REV_ON_MAIN}
`

export const BRANCH_SWITCH = `Switching branch to conductor/S-1-spike, using current remote latest revision ${REV_MAIN}
Calculating deltas 2 -> 1
Verifying 1 changes with local file system
Switched to branch conductor/S-1-spike revision ${REV_MAIN}
`

/** A push of the run branch after a merge into it (same shape as PUSH_FIRST, on an existing branch). */
export const PUSH_RUN = `Pushing 6 fragment(s)
Pushed 6 fragment(s), 595 bytes
Pushing ${REV_RUN} to branch conductor/S-1-spike
Pushed revision 3 -> ${REV_RUN} to branch conductor/S-1-spike
`
