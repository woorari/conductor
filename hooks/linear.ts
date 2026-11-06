/**
 * Linear: issue keys, and the requests its GraphQL API takes and what it
 * answers. Pure: the hooks module sends the requests.
 *
 * The request shapes are those of a client proven against Linear's API: a
 * POST to `LINEAR_API` with the key as the bare `Authorization` value (no
 * `Bearer`), `issue(id:)` taking an issue's key, a team's states with their
 * type and position.
 */

import { LINEAR_KEY } from './ledger'

export { LINEAR_KEY }

export const LINEAR_API = 'https://api.linear.app/graphql'

/** The Linear issue a word names: its key (`ABC-12`), or a link to it on linear.app. */
export function linearKeyOf(word: string): string | undefined {
  if (LINEAR_KEY.test(word)) return word
  const linked = /^https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8})(?:[/#?]\S*)?$/.exec(word)?.[1]

  return linked
}

/** The key the person set in the mod's Linear API key option, trimmed; empty when none. */
export function apiKeyOf(options: unknown): string {
  const given = typeof options === 'object' && options !== null ? (options as Record<string, unknown>).linearApiKey : undefined

  return typeof given === 'string' ? given.trim() : ''
}

const STATES = 'states { nodes { id name type position } }'
const ISSUE_FIELDS = `id identifier title description url state { name type } parent { identifier } children { nodes { identifier title state { name type } } } comments(last: 20) { nodes { body createdAt user { displayName } } } team { id key ${STATES} }`

export const Q_ISSUE = `query ConductorIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`
export const Q_TEAM = `query ConductorTeam($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key ${STATES} } } }`
export const M_CREATE = 'mutation ConductorIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }'
export const M_UPDATE = 'mutation ConductorIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }'

export type LinearStateView = { id: string; name: string; type: string; position: number }
export type TeamView = { id: string; key: string; states: LinearStateView[] }

export type IssueView = {
  id: string
  key: string
  title: string
  description: string
  url: string
  state: { name: string; type: string }
  parent?: string
  children: { key: string; title: string; state: { name: string; type: string } }[]
  comments: { author: string; at: string; body: string }[]
  team: TeamView
}

type Json = Record<string, unknown>
const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')
const nodes = (value: unknown): unknown[] => (isJson(value) && Array.isArray(value.nodes) ? value.nodes : [])
const stateOf = (value: unknown): { name: string; type: string } => (isJson(value) ? { name: textOf(value.name), type: textOf(value.type) } : { name: '', type: '' })

function teamFrom(value: unknown): TeamView | undefined {
  if (!isJson(value) || typeof value.id !== 'string' || typeof value.key !== 'string') return undefined
  const states = nodes(value.states).flatMap(one =>
    isJson(one) && typeof one.id === 'string' ? [{ id: one.id, name: textOf(one.name), type: textOf(one.type), position: typeof one.position === 'number' ? one.position : 0 }] : [],
  )

  return { id: value.id, key: value.key, states }
}

/** What the issue query's `data` holds, as a view; undefined when there is no such issue. */
export function issueOf(data: unknown): IssueView | undefined {
  const found = isJson(data) ? data.issue : undefined
  if (!isJson(found) || typeof found.id !== 'string' || typeof found.identifier !== 'string') return undefined
  const team = teamFrom(found.team)
  if (team === undefined) return undefined
  const parent = isJson(found.parent) && typeof found.parent.identifier === 'string' ? found.parent.identifier : undefined

  return {
    id: found.id,
    key: found.identifier,
    title: textOf(found.title),
    description: textOf(found.description),
    url: textOf(found.url),
    state: stateOf(found.state),
    ...(parent === undefined ? {} : { parent }),
    children: nodes(found.children).flatMap(one => (isJson(one) && typeof one.identifier === 'string' ? [{ key: one.identifier, title: textOf(one.title), state: stateOf(one.state) }] : [])),
    comments: nodes(found.comments).flatMap(one =>
      isJson(one) ? [{ author: isJson(one.user) ? textOf(one.user.displayName) || 'someone' : 'someone', at: textOf(one.createdAt), body: textOf(one.body) }] : [],
    ),
    team,
  }
}

/** What the orchestrator reads of an issue. */
export function issueText(view: IssueView): string {
  return [
    `${view.key}: ${view.title} (${view.state.name})`,
    view.url,
    ...(view.parent === undefined ? [] : [`Parent: ${view.parent}`]),
    ...(view.children.length === 0 ? [] : ['Sub-issues:', ...view.children.map(one => `- ${one.key} ${one.title} (${one.state.name})`)]),
    'Description:',
    view.description.trim() === '' ? '(none)' : view.description.trim(),
    ...(view.comments.length === 0 ? [] : [`Comments (the last ${view.comments.length}):`, ...view.comments.map(one => `- ${one.author}, ${one.at}: ${one.body}`)]),
  ].join('\n')
}

/** A team found by its key in the team query's `data`. */
export const teamOf = (data: unknown): TeamView | undefined => (isJson(data) ? teamFrom(nodes(data.teams)[0]) : undefined)

/** The state of a type a team puts first: the lowest position. Each team names its states its own way, so a state is found by type. */
export function stateFor(states: readonly LinearStateView[], type: 'started' | 'completed'): string | undefined {
  return [...states].filter(one => one.type === type).sort((a, b) => a.position - b.position)[0]?.id
}

/** The issue an `issueCreate` made. */
export function createdOf(data: unknown): { key: string; url: string } | undefined {
  const made = isJson(data) && isJson(data.issueCreate) ? data.issueCreate : undefined
  if (made?.success !== true || !isJson(made.issue) || typeof made.issue.identifier !== 'string') return undefined

  return { key: made.issue.identifier, url: textOf(made.issue.url) }
}

/** Whether an `issueUpdate` went through. */
export const updatedOf = (data: unknown): boolean => isJson(data) && isJson(data.issueUpdate) && data.issueUpdate.success === true

/** What a GraphQL answer's `errors` say, joined; undefined when it has none. */
export function errorsOf(json: unknown): string | undefined {
  if (!isJson(json) || !Array.isArray(json.errors) || json.errors.length === 0) return undefined

  return json.errors.map(one => (isJson(one) ? textOf(one.message) : '')).filter(one => one !== '').join('; ') || 'Linear answered with an error'
}
