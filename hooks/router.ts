import type { Ledger, ModelTier, Task } from '../types'
import { kindOf } from './signals'

/**
 * Which model a new agent runs on in a session bound to a run. Pure: the
 * ledger and what the Agent tool asked for in, a decision out.
 */

/** Cheapest first: a worker's own subagents never run on a dearer tier than the worker. */
const RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 }

/** Agent types that only read, which the orchestrator may start without a task. */
export const HELPER_TYPES: readonly string[] = ['Explore', 'Plan', 'claude-code-guide']

/** How many workers may be building at once when the run does not say (proposed, not measured). */
export const MAX_BUILDING = 3

export type Spawn = {
  /** The agent's `name`, when the call gave one. */
  name?: string
  /** The model the call asked for: an alias or a full id; absent to inherit. */
  model?: string
  subagentType: string
  /** The task whose worker (or worker's subagent) is starting this agent; absent for the orchestrator. */
  parentTaskId?: string
}

export type Route =
  /** A read-only helper of the orchestrator: started as asked. */
  | { kind: 'pass' }
  /** A task's worker: started on its tier, whatever the call asked for; on `base` when it builds on a branch that is not merged yet. */
  | { kind: 'worker'; taskId: string; model: ModelTier; slot: number; base?: Base }
  /** A worker's own subagent: started on `model`. */
  | { kind: 'child'; taskId: string; model: ModelTier }
  | { kind: 'deny'; text: string }

/** A task another one is built on before it is merged: where its change is to be found. */
export type Base = { taskId: string; branch?: string; pr?: number }

/**
 * What still keeps a task from starting, as far as the tasks it waits for go.
 *
 * A task starts once everything it waits for is done or green. Done is
 * merged; green is reviewed with its checks green, which is all a worker needs
 * to build on, so a task in line does not wait for the merges before it.
 *
 * A green task's change is on its branch, not on the base branch, so the
 * worker builds on that branch (`base`). It can build on one such branch only:
 * with two the task waits until all but one are done.
 */
export function readiness(ledger: Ledger, task: Task): { waitsFor: string[]; isForBranches?: true; base?: Base } {
  const open = (task.dependsOn ?? [])
    .flatMap(id => ledger.tasks.find(one => one.id === id) ?? [])
    .filter(one => one.status !== 'done')
  const early = open.filter(one => one.status !== 'green')
  if (early.length > 0) return { waitsFor: early.map(one => one.id) }
  const branches = open
  if (branches.length > 1) return { waitsFor: branches.map(one => one.id), isForBranches: true }
  const base = branches[0]

  return { waitsFor: [], ...(base === undefined ? {} : { base: { taskId: base.id, branch: base.branch, pr: base.pr } }) }
}

/** The queued tasks that wait for `taskId` and could start now, each with the task it would be built on. */
export function unlocked(ledger: Ledger, taskId: string): { id: string; base?: Base }[] {
  return ledger.tasks
    .filter(one => one.status === 'queued' && (one.dependsOn ?? []).includes(taskId))
    .map(one => ({ id: one.id, ready: readiness(ledger, one) }))
    .filter(one => one.ready.waitsFor.length === 0)
    .map(one => ({ id: one.id, ...(one.ready.base === undefined ? {} : { base: one.ready.base }) }))
}

/** The tier a model alias or id belongs to, or undefined for one this version does not know. */
export function familyOf(model: string | undefined): ModelTier | undefined {
  const name = model?.toLowerCase() ?? ''

  return (['opus', 'sonnet', 'haiku'] as const).find(tier => name.includes(tier))
}

const overlap = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

/** The files two tasks are both expected to change. */
export const shared = (a: readonly string[] = [], b: readonly string[] = []): string[] =>
  a.filter(file => b.some(other => overlap(file, other)))

/** Whether `task` waits for `other`, directly or through other tasks. */
function waitsOn(ledger: Ledger, taskId: string, otherId: string, seen: ReadonlySet<string> = new Set()): boolean {
  const task = ledger.tasks.find(one => one.id === taskId)
  if (task === undefined || seen.has(taskId)) return false
  const after = task.dependsOn ?? []

  return after.includes(otherId) || after.some(id => waitsOn(ledger, id, otherId, new Set([...seen, taskId])))
}

/**
 * What is wrong with a plan before anything starts: two tasks that could run
 * at the same time on the same file, and a task that names no files (nobody
 * can then be told what concerns it).
 */
export function preflight(ledger: Ledger): string[] {
  const open = ledger.tasks.filter(task => task.status !== 'done')
  const issues: string[] = []
  open.forEach((task, at) => {
    for (const other of open.slice(at + 1)) {
      const both = shared(task.files, other.files)
      if (both.length === 0 || waitsOn(ledger, task.id, other.id) || waitsOn(ledger, other.id, task.id)) continue
      issues.push(`${task.id} and ${other.id} could run at once and both change ${both.join(', ')}: order them with dependsOn, or split the files.`)
    }
    if ((task.files ?? []).length === 0) issues.push(`${task.id} names no files: say what it is expected to change.`)
  })

  return issues
}

export function route(ledger: Ledger, spawn: Spawn): Route {
  const run = ledger.run.id
  if (spawn.parentTaskId !== undefined) {
    const parent = ledger.tasks.find(task => task.id === spawn.parentTaskId)
    if (parent === undefined) return { kind: 'pass' }
    const asked = familyOf(spawn.model)
    // Asked for nothing: named anyway, so an agent type that pins a dearer model cannot bring it in.
    const model = asked !== undefined && RANK[asked] <= RANK[parent.tier] ? asked : parent.tier

    return { kind: 'child', taskId: parent.id, model }
  }

  const task =
    spawn.name === undefined
      ? undefined
      : (ledger.tasks.find(one => one.id === spawn.name) ?? ledger.tasks.find(one => one.worker === spawn.name))
  if (task === undefined) {
    if (HELPER_TYPES.includes(spawn.subagentType)) return { kind: 'pass' }

    return {
      kind: 'deny',
      text: `conductor: this session is bound to run ${run}, where every worker is a task. Add the task with mcp__conductor__task_add (id, title, tier and why), then start the agent with the task's id as its name. Read-only helpers of type ${HELPER_TYPES.join(', ')} start without a task.`,
    }
  }
  if (kindOf(task) === 'codex') {
    return { kind: 'deny', text: `conductor: \`${task.id}\` is built by Codex: start it with worker_start, not with the Agent tool.` }
  }

  return workerRoute(ledger, task)
}

/** The start gates and slot allocation shared by both kinds of worker. */
function workerRoute(ledger: Ledger, task: Task): Extract<Route, { kind: 'worker' | 'deny' }> {
  const run = ledger.run.id
  if (ledger.run.plan === 'draft' || ledger.run.plan === 'proposed') {
    return {
      kind: 'deny',
      text:
        ledger.run.plan === 'draft'
          ? `conductor: the plan of run ${run} is still a draft. Finish it, call mcp__conductor__run_plan, and wait for the owner's /approve: no worker starts before that.`
          : `conductor: the plan of run ${run} waits for the owner's approval (/approve). No worker starts before that.`,
    }
  }
  // The owner's hold: what is under way finishes, nothing new starts.
  if (ledger.run.pausedAt !== undefined) {
    return {
      kind: 'deny',
      text: `conductor: run ${run} is paused by the owner since ${ledger.run.pausedAt}. No worker starts until they type /unpause; workers that are building finish and hand back.`,
    }
  }
  if (task.status === 'done') return { kind: 'deny', text: `conductor: ${task.id} is done; a finished task gets no new worker.` }
  if (task.status === 'building') {
    return {
      kind: 'deny',
      text: `conductor: ${task.id} is already being built by ${task.worker ?? 'a worker'}. If that worker is gone, set the task to returned with mcp__conductor__task_update first.`,
    }
  }
  const ready = readiness(ledger, task)
  if (ready.waitsFor.length > 0) {
    const stands = ready.waitsFor.map(id => `${id} (${ledger.tasks.find(one => one.id === id)?.status ?? 'unknown'})`).join(', ')

    return {
      kind: 'deny',
      text:
        ready.isForBranches === true
          ? `conductor: ${task.id} waits for ${ready.waitsFor.join(', ')}, which are green but not merged: a worker builds on one unmerged branch only. Start it once all but one of them are done.`
          : `conductor: ${task.id} waits for ${stands}. A task starts once what it waits for is green (reviewed, its checks green) or done.`,
    }
  }
  const limit = ledger.run.maxParallel ?? MAX_BUILDING
  const building = ledger.tasks.filter(one => one.status === 'building').length
  if (building >= limit) {
    return {
      kind: 'deny',
      text: `conductor: ${building} workers are building, the most this run allows at once. Start ${task.id} after a hand-back.`,
    }
  }

  // Two workers never build on the same file at once: the later one waits, or the files are split.
  const clash = ledger.tasks
    .filter(one => one.status === 'building' && one.id !== task.id)
    .map(one => ({ id: one.id, on: shared(task.files, one.files) }))
    .find(one => one.on.length > 0)
  if (clash !== undefined) {
    return {
      kind: 'deny',
      text: `conductor: ${task.id} and ${clash.id}, which is building, both change ${clash.on.join(', ')}. Start ${task.id} after ${clash.id} is done, or split the files.`,
    }
  }
  const taken = new Set(ledger.tasks.filter(one => one.status === 'building').map(one => one.slot))
  let slot = 1
  while (taken.has(slot)) slot += 1

  return { kind: 'worker', taskId: task.id, model: task.tier, slot, ...(ready.base === undefined ? {} : { base: ready.base }) }
}

/** A Codex task starts through the board tool, with exactly the same gates as a Claude worker. */
export function routeCodex(ledger: Ledger, taskId: string): { is: 'start'; slot: number; base?: Base } | { is: 'deny'; text: string } {
  const task = ledger.tasks.find(one => one.id === taskId)
  if (task === undefined) return { is: 'deny', text: `conductor: there is no task ${taskId} in run ${ledger.run.id}. Add it with mcp__conductor__task_add first.` }
  if (kindOf(task) !== 'codex') return { is: 'deny', text: `conductor: \`${task.id}\` is built by Claude: start its worker with the Agent tool.` }
  if (ledger.run.codex?.ready !== true) {
    return { is: 'deny', text: `conductor: Codex workers are off for this run${ledger.run.codex?.why === undefined ? '.' : `: ${ledger.run.codex.why}`}` }
  }
  const decided = workerRoute(ledger, task)

  return decided.kind === 'deny'
    ? { is: 'deny', text: decided.text }
    : { is: 'start', slot: decided.slot, ...(decided.base === undefined ? {} : { base: decided.base }) }
}
