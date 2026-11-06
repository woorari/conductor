/**
 * Linear: issue keys, and the requests its GraphQL API takes. Pure: the hooks
 * module sends the requests.
 */

import { LINEAR_KEY } from './ledger'

export { LINEAR_KEY }

/** The Linear issue a word names: its key (`ABC-12`), or a link to it on linear.app. */
export function linearKeyOf(word: string): string | undefined {
  if (LINEAR_KEY.test(word)) return word
  const linked = /^https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8})(?:[/#?]\S*)?$/.exec(word)?.[1]

  return linked
}
