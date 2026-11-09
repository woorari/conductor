import type { Ledger } from '../types'
import { RUN_ID } from './ledger'
import { linearKeyOf } from './linear'
import { FILES_PER_TASK, tidy } from './signals'

/** What `/conduct` was asked to start. */
export type Conducting = {
  /** The run's id: the issue's number or Linear key, the spec file's name, or the name given with `id=`. */
  id: string
  /** What the run starts from, as the orchestrator is told it: `#12`, `ABC-12`, or the spec's path. */
  source: string
  kind: 'issue' | 'linear' | 'spec'
  /** What the owner called the run, when they did. */
  title?: string
}

export const CONDUCT_USAGE =
  'Say what the run starts from: /conduct #12 for a GitHub issue, /conduct ABC-12 for a Linear issue, or /conduct <spec path> for a spec document. Any other words name the run: /conduct #12 Retry the flaky upload.'

const TITLE_MAX = 120

/** The words of a command line; a quoted stretch is one word, and a quote left open is dropped. */
const words = (args: string): string[] =>
  [...args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
    .map(found => (found[1] ?? found[2] ?? (found[3] ?? '').replace(/^["']+|["']+$/g, '')).trim())
    .filter(one => one !== '')

/** The issue a word names: `#12`, or a link to it on GitHub. */
function issueOf(word: string): number | undefined {
  const found = /^#(\d{1,9})$/.exec(word) ?? /^https?:\/\/\S+\/issues\/(\d{1,9})(?:[/#?]\S*)?$/.exec(word)
  const number = found === null ? 0 : Number(found[1])

  return number >= 1 ? number : undefined
}

const isPath = (word: string): boolean => word.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(word)

/** A spec file's name as a run id: without its folder and ending, every other character a hyphen. */
const named = (path: string): string =>
  (path.split('/').pop() ?? '')
    .replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|-+$/g, '')
    .slice(0, 64)

/**
 * Reads what was typed after `/conduct`. The run starts from the first issue
 * named (`#12`, a link to it, or a bare number in first place), or else from
 * the first word that is a path. Every other word is the run's title, in
 * whatever order (measured 2026-10-09: the owner typed the title first, and
 * the first word of it became the run's id). The id is the issue's number or
 * the spec file's name unless `id=<run id>` gives one.
 */
export function conducting(args: string): Conducting | { error: string } {
  const all = words(args)
  const given = all.find(one => /^id=/i.test(one))
  const rest = all.filter(one => one !== given)
  const explicit = given?.slice(3)
  if (explicit !== undefined && !RUN_ID.test(explicit)) {
    return { error: `"${explicit}" is no run id: letters, digits, _ and -, at most 64, a letter or digit first.` }
  }
  let at = rest.findIndex(one => issueOf(one) !== undefined)
  const linearAt = at === -1 ? rest.findIndex(one => linearKeyOf(one) !== undefined) : -1
  if (linearAt !== -1) at = linearAt
  if (at === -1 && /^\d{1,9}$/.test(rest[0] ?? '') && Number(rest[0]) >= 1) at = 0
  const linear = linearAt === -1 ? undefined : linearKeyOf(rest[at] ?? '')
  const issue = at === -1 || linear !== undefined ? undefined : (issueOf(rest[at] ?? '') ?? Number(rest[at]))
  if (issue === undefined && linear === undefined) at = rest.findIndex(isPath)
  const from = rest[at]
  if (from === undefined) return { error: CONDUCT_USAGE }
  const title = tidy(rest.filter((_, index) => index !== at).join(' ')).slice(0, TITLE_MAX)
  const id = explicit ?? linear ?? (issue === undefined ? named(from) : String(issue))
  if (!RUN_ID.test(id)) {
    return { error: `The name of ${from} gives no run id. Name the run yourself: /conduct ${from} id=<run id> (letters, digits, _ and -).` }
  }

  return {
    id,
    source: linear ?? (issue === undefined ? from : `#${issue}`),
    kind: linear !== undefined ? 'linear' : issue === undefined ? 'spec' : 'issue',
    ...(title === '' ? {} : { title }),
  }
}

/** What a new run keeps beyond its source: where its tickets are, the project's config, and its Lore branch. */
export type RunMore = Pick<Ledger['run'], 'tickets' | 'config' | 'lore' | 'workspace' | 'candidates'>

/** A new run's ledger: nothing in it yet, and no worker may start before its plan is approved. */
export const newRun = (id: string, source: string, at: string, title?: string, more: RunMore = {}): Ledger => ({
  version: 1,
  run: {
    id,
    title: title ?? `Run ${id}`,
    source,
    startedAt: at,
    plan: 'draft',
    ...(more.tickets === undefined ? {} : { tickets: more.tickets }),
    ...(more.config === undefined ? {} : { config: more.config }),
    ...(more.lore === undefined ? {} : { lore: more.lore }),
    ...(more.workspace === undefined ? {} : { workspace: more.workspace }),
    ...(more.candidates === undefined ? {} : { candidates: more.candidates }),
  },
  tasks: [],
  problems: [],
  posts: [],
  rulings: [],
})

/**
 * What the orchestrator is told when the owner starts a run. The owner reads
 * this line in the conversation too, so it says what happened; how a run is
 * planned is `PLANNING`, part of the orchestrator's standing instructions.
 */
export const planning = (id: string, source: string, title?: string): string =>
  `Run board: the owner started run \`${id}\` from ${source}${title === undefined ? '' : `, and calls it "${title}"`}. Plan it; start no worker yet.`

/** How a run is planned: plan first, dispatch nothing. */
export const PLANNING = [
  'Planning a run, in this order:',
  '  1. Read the source. For a ticket: the parent issue, every sub-ticket it lists and the spec they link. For a spec document: read it, and draft the tickets it needs (short, each linking the spec). Do not file them yet.',
  `  2. Slice the work into tasks with mcp__conductor__task_add. One task is one change a single worker can finish and hand back as one pull request without filling its context: one concern, at most ${FILES_PER_TASK} files or folders. Give each its ticket, the files it is expected to change, what it depends on, and a tier with the reason.`,
  '  3. No two tasks that could run at the same time may change the same file: order them with dependsOn, or split the files. mcp__conductor__board_read lists what is still wrong under "Plan check".',
  '  4. Call mcp__conductor__run_plan with a title for the run. Then tell the owner the plan in a few lines and stop. For a run from a spec, their approval is also the go-ahead to file the drafted tickets, before any worker starts; record each number with mcp__conductor__task_update.',
].join('\n')

export const APPROVED = 'Run board: the owner approved the plan.'

/** Words an approving reply may lead with, and the words it may add after approving: to start, and nothing else. */
const YES = new Set(['yes', 'ok', 'okay'])
const GO = new Set(['it', 'the', 'plan', 'and', 'start', 'now', 'go', 'ahead', 'please'])

/**
 * Whether a reply of the owner's is an explicit approval of the plan, as
 * /approve: a button such as "Approve, start now". It says only to approve,
 * and maybe to start; a question, a condition, a negation or anything else
 * named is not one.
 */
export function isApproval(text: string): boolean {
  if (text.includes('?')) return false
  const words = text.toLowerCase().replace(/[.,!;:]/g, ' ').trim().split(/\s+/)
  const first = words.findIndex(word => !YES.has(word))
  if (first < 0 || (words[first] !== 'approve' && words[first] !== 'approved')) return false

  return words.slice(first + 1).every(word => GO.has(word))
}
