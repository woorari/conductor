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

export const workspaceOf = (base: string, runId: string, taskId: string): string => `${base}/${runId}/${taskId}`

/** The run's own workspace, on the run branch: where the mod merges. */
export const runWorkspaceOf = (base: string, runId: string): string => `${base}/${runId}/_run`

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
    .filter(one => one.path !== '')
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const out: string[] = []
  for (const one of paths) {
    if (out.some(gone => one.path === gone || one.path.startsWith(`${gone}/`))) continue
    if (isIgnored(rules, one.path, one.isDir) && !isCarried(carry, one.path)) out.push(one.path)
  }

  return out
}
