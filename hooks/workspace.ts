/**
 * Where a Lore run's work lives: its branches and its workers' workspaces.
 * Pure: the hooks module makes them.
 */

import { linearKeyOf } from './linear'
import { isIgnored } from './lore'
import type { IgnoreRule } from './lore'

/** A title as part of a branch name: lowercase letters and digits joined by hyphens, at most 40 characters. */
export const slugOf = (title: string): string =>
  (title.toLowerCase().match(/[a-z0-9]+/g) ?? []).join('-').slice(0, 40).replace(/-+$/, '')

/**
 * A run's own branch: the project's prefix, the run's Linear key (or its id),
 * and a short slug of its title: `conductor/ABC-12-retry-the-flaky-upload`.
 */
export function runBranchOf(prefix: string, source: string, id: string, title: string | undefined): string {
  const name = linearKeyOf(source) ?? id
  const slug = title === undefined ? '' : slugOf(title)

  return `${prefix}${name}${slug === '' ? '' : `-${slug}`}`
}

/** A task's branch: under its run's branch, named by the task. */
export const taskBranchOf = (runBranch: string, taskId: string): string => `${runBranch}/${taskId}`

/** The folder a run's workspaces live in: the project's choice, else beside the owner's workspace, never inside it. */
export function workspacesOf(root: string, configured?: string): string {
  if (configured !== undefined && configured.trim() !== '') return configured.replace(/\/+$/, '')
  const at = root.lastIndexOf('/')

  return `${root.slice(0, at)}/${root.slice(at + 1)}.conductor`
}

/** A run's or a task's id as part of a folder's path: a plain name, never a way out of the folder above it. */
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/
function plain(name: string): string {
  if (!PLAIN.test(name)) throw new Error(`"${name}" is no plain name, so it gives no workspace`)

  return name
}

export const workspaceOf = (base: string, runId: string, taskId: string): string => `${base}/${plain(runId)}/${plain(taskId)}`

/** The run's own workspace, on the run branch: where the mod merges. */
export const runWorkspaceOf = (base: string, runId: string): string => `${base}/${plain(runId)}/_run`

/** The run's check workspace: the mod's own, put at each judged revision before its check runs. */
export const checkWorkspaceOf = (base: string, runId: string): string => `${base}/${plain(runId)}/_check`

/** Whether a path lies strictly inside a folder, with no `..` or `.` part on the way: what alone may be removed. */
export const isInside = (base: string, path: string): boolean =>
  path.startsWith(`${base}/`) && path.slice(base.length + 1).split('/').every(part => part !== '' && part !== '.' && part !== '..')

/** Whether a path is one the project carries into a worker's copy, or lies in one. */
export const isCarried = (carry: readonly string[], path: string): boolean =>
  carry.some(one => {
    const kept = one.replace(/^\/+|\/+$/g, '')

    return path === kept || path.startsWith(`${kept}/`)
  })

/** The top-level entries of the owner's workspace a copy takes: what is not ignored, and what the project carries. */
export function topLevel(entries: readonly { name: string; isDir: boolean }[], rules: readonly IgnoreRule[], carry: readonly string[]): string[] {
  return entries.filter(one => !isIgnored(rules, one.name, one.isDir) || isCarried(carry, one.name)).map(one => one.name)
}

/**
 * What comes out of a fresh copy: the paths `.loreignore` ignores and the
 * project does not carry. `listing` is the copy's paths relative to it, one to
 * a line, a folder ending in `/`. Each answer is the outermost such path once:
 * what lies in a folder that comes out is not named again.
 */
export function removals(listing: string, rules: readonly IgnoreRule[], carry: readonly string[]): string[] {
  const paths = listing
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map(line => ({ path: line.replace(/^\.\/|\/+$/g, ''), isDir: line.endsWith('/') }))
    // A line that would lead out of the copy is no part of it.
    .filter(one => one.path !== '' && one.path.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const out: string[] = []
  const gone = new Set<string>()
  for (const one of paths) {
    // The copy's own Lore state is the copy: no ignore rule of the project's applies to it.
    if (one.path === '.lore' || one.path.startsWith('.lore/')) continue
    // What lies in a folder that comes out is not named again: its ancestors are looked up, one by one.
    const parts = one.path.split('/')
    let isUnderGone = false
    for (let depth = 1; depth < parts.length && !isUnderGone; depth += 1) isUnderGone = gone.has(parts.slice(0, depth).join('/'))
    if (isUnderGone) continue
    if (isIgnored(rules, one.path, one.isDir) && !isCarried(carry, one.path)) {
      out.push(one.path)
      gone.add(one.path)
    }
  }

  return out
}
