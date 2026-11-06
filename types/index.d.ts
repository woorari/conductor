/**
 * The model a task's worker runs on. The orchestrator tags it when it slices
 * the work: architecture and design are `opus`, challenging development is
 * `sonnet`, easy jobs are `haiku`.
 */
export type ModelTier = 'opus' | 'sonnet' | 'haiku'

/**
 * Where a task stands.
 *
 * `queued`: not started. `building`: a worker is on it. `returned`: the
 * worker's turn ended and the orchestrator has not judged the hand-back yet.
 * `review`: its PR is open and CI or review is pending. `green`: CI is green
 * and it is reviewed, ready to merge. `done`: its pull request is merged into
 * the base branch. A task with no PR is done when the orchestrator says so.
 * `blocked`: waits on a ruling or something outside the run. `failed`: given
 * up, needs a decision.
 */
export type TaskStatus = 'queued' | 'building' | 'returned' | 'review' | 'green' | 'done' | 'blocked' | 'failed'

/** What a worker was last seen doing: written by the mod from the worker's own tool calls. */
export type Activity = {
  /** ISO 8601. */
  at: string
  text: string
}

export type Task = {
  /** Unique in the run, e.g. `t515-2`. */
  id: string
  title: string
  tier: ModelTier
  /** One line: why the task has this tier. The orchestrator gives it when it tags the task. */
  tierReason?: string
  /** `owner` once the person set the tier: the orchestrator then leaves it alone. */
  tierBy?: 'owner'
  status: TaskStatus
  /** The issue the task belongs to. */
  ticket?: number
  /** Ids of tasks that must be `done` before this one starts. */
  dependsOn?: string[]
  /** What the task is expected to change: files or folders, relative to the repository. */
  files?: string[]
  /** The files its worker has changed so far, as the mod saw them: relative to the repository. */
  touched?: string[]
  /** The worker's agent name. */
  worker?: string
  /** The worker's agent id: what still reaches it after the session restarted and its name no longer resolves. */
  agentId?: string
  /** The model the worker runs on, as the engine resolved it when it started. */
  model?: string
  /**
   * The task whose branch this one's worker started from, when that task was
   * green and not merged yet: this task's pull request holds its commits too
   * until it is merged.
   */
  builtOn?: string
  /** The worker's number among those building at once, from 1: what its private database and scratch folder are named by. */
  slot?: number
  activity?: Activity
  /** How many tokens the worker's last model request held: its context, as the engine reported it. */
  contextTokens?: number
  branch?: string
  /** The pull request on GitHub. */
  pr?: number
  /** When a worker started on it. ISO 8601. */
  startedAt?: string
  /** When the worker's turn last ended, or when the task was marked done; absent while a worker is on it. ISO 8601. */
  finishedAt?: string
  /** One line: what it is doing now, or why it is blocked. */
  note?: string
  /** The commit its pull request's merge made on the base branch, and when. */
  mergeCommit?: string
  mergedAt?: string
}

/**
 * A merge in flight: from the moment the mod claims it until GitHub has said
 * whether the pull request merged. One at a time; gone once it is settled.
 */
export type Merge = {
  task: string
  pr: number
  /** The pull request's head the checks were green on, which the merge was pinned to. */
  head: string
  /** Claimed: the merge call is out, and its answer is not settled yet. */
  state: 'merging'
  /** ISO 8601. */
  startedAt: string
  /** The sessions the orchestrator said it told before merging: recorded, not checked. */
  told?: string[]
  /** The issues this merge was meant to close. */
  closes?: number[]
}

export type ProblemSeverity = 'blocker' | 'warning' | 'note'

export type Problem = {
  /** Unique in the run, e.g. `P3`. */
  id: string
  text: string
  severity: ProblemSeverity
  status: 'open' | 'resolved'
  /** The task that found it or that it holds up. */
  taskId?: string
  /**
   * The task of this run that deals with it: one added for the problem, or one
   * the run already conducts (found by its id or by its ticket). Never a task
   * outside the run, so a problem is not parked where nobody conducts it.
   */
  addressedBy?: string
  /** ISO 8601. */
  foundAt?: string
  /**
   * When the orchestrator was last asked to look at it again, by the periodic
   * look at problems nobody deals with. ISO 8601.
   */
  askedAt?: string
  /** How it was settled, once `resolved`. */
  resolution?: string
}

/** Something said on the run's board: a fact other workers may need, or a worker's question to the orchestrator. */
export type Post = {
  /** `F3` for a finding, `Q2` for a question. */
  id: string
  kind: 'finding' | 'question'
  text: string
  /** The task whose worker posted it, or `orchestrator`. */
  from: string
  /** ISO 8601. */
  at: string
  /** The files or folders it concerns: who it is delivered to follows from these. */
  files?: string[]
  /** The tasks whose workers it is meant for. */
  for?: string[]
  /** Those of them whose workers have been handed it, with the result of one of their own tool calls. */
  deliveredTo?: string[]
  /** The ruling that answered a question. */
  answeredBy?: string
}

/** A numbered decision of the orchestrator's, sent to every worker it binds. */
export type Ruling = {
  /** `R1`, `R2`, ... */
  id: string
  text: string
  /** ISO 8601. */
  at: string
  /** The question it answers. */
  answers?: string
  /** The tasks it binds; absent for a ruling that binds every task. */
  tasks?: string[]
  /** The tasks whose workers it is meant for. */
  for?: string[]
  /** Those of them whose workers have been handed it. */
  deliveredTo?: string[]
}

/**
 * One run's ledger, `<repo root>/.claude/conductor/runs/<run id>/ledger.json`.
 * Fields this version does not know are kept out of the way, never refused.
 */
export type Ledger = {
  version: 1
  run: {
    id: string
    title: string
    /** What the run started from: `#12`, or a spec's path. */
    source?: string
    /** ISO 8601. */
    startedAt?: string
    /**
     * Where the run's plan stands. `draft`: the orchestrator is slicing the work.
     * `proposed`: it waits for the owner. `approved`: workers may start. Absent
     * means approved: a ledger from before plans had a state.
     */
    plan?: 'draft' | 'proposed' | 'approved'
    /**
     * Since when the owner holds the run with `/pause`: no worker starts and
     * nothing is merged until `/unpause`. Absent while it runs.
     */
    pausedAt?: string
    /** The most workers that may be building at once; 3 when absent. */
    maxParallel?: number
    /**
     * A worker whose context holds this many tokens is asked to hand back at its
     * next green step. Absent, no worker is asked: the mod cannot see how large
     * a worker model's window is, so the number is the run's to set.
     */
    workerHandbackTokens?: number
  }
  /** The orchestrator's own context, and how often it was compacted with a handover. */
  orchestrator?: Orchestrator
  tasks: Task[]
  problems: Problem[]
  posts: Post[]
  rulings: Ruling[]
  /** The merge in flight, if any. */
  merge?: Merge
  /**
   * The base branch's checks are being watched after the run's last merge:
   * since when, that merge's commit, and the failure that was already said,
   * so it is said once.
   */
  main?: { since: string; commit?: string; failed?: string }
}

export type Orchestrator = {
  /** How full the orchestrator's context window was when last measured, in percent. */
  contextPercent?: number
  /** ISO 8601. */
  measuredAt?: string
  /**
   * A compaction that is due and that the engine has refused so far: since
   * when, and the engine's own reason. Gone once one goes through.
   */
  held?: { since: string; reason: string }
  /** How many times the session was compacted with the run's handover. */
  rotations?: number
  /** ISO 8601. */
  rotatedAt?: string
}

/** What the board pane draws from. */
export type BoardState = {
  /** The run on show; null while none is found. */
  runId: string | null
  /** The last ledger that read and validated; kept while a newer read fails. */
  ledger: Ledger | null
  /** Why the newest read failed, or why there is nothing to show. */
  error: string | null
  /** When the ledger on show was last written (its file's time), in ms; absent before a first good read. */
  updatedMs?: number
}

declare module 'claude-code' {
  interface PluginState {
    conductor: {
      board: BoardState
      /** The clock as last ticked, for elapsed times; 0 before the first tick. */
      nowMs: number
      /**
       * The run this session is bound to by `/board <run>`: the one its workers'
       * signals and its tools write. Null only views the newest ledger.
       */
      pinnedRun: string | null
    }
  }
}
