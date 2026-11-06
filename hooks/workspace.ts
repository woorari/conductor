/**
 * Where a Lore run's work lives: its branches and its workers' workspaces.
 * Pure: the hooks module makes them.
 */

import { linearKeyOf } from './linear'

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
