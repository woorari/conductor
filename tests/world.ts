import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Ledger } from '../types'

export const ROOT = '/repo'
export const RUNS = `${ROOT}/.claude/conductor/runs`
export const PANE = {
  plugin: 'conductor',
  component: 'Pane',
  requestId: 'conductor-board',
  props: {
    title: 'Run board',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const
export const SURFACES = ['terminal', 'desktop'] as const

export type Files = Record<string, { text: string; mtimeMs: number }>

export const HOME = '/home/owner'
/** Stands in for the person's GitHub token: a test asserts it is written nowhere. */
export const TOKEN = 'github-token-for-tests'
/** The repository on GitHub a test's checkout is a clone of. */
export const REPO = 'acme/widgets'
export const API = `https://api.github.com/repos/${REPO}`
/** The repository's `origin` as a clone from GitHub has it. */
export const ORIGIN = `git@github.com:${REPO}.git`
/** The `origin` of a repository that is not on GitHub. */
export const OTHER_ORIGIN = 'https://gitlab.com/acme/widgets.git'
/** The check runs every test's commits get unless it says otherwise. */
export const JOBS = ['build', 'test'] as const
/** The base branch's head before anything is merged in a test. */
export const MAIN = 'a'.repeat(40)
/** The commit pretend GitHub makes when it merges a pull request. */
export const mergeCommit = (pr: number): string => String(pr).padStart(40, 'c')

/** One check run on a commit, as GitHub lists it. */
export type CheckRun = { name: string; status: string; conclusion: string | null }

/**
 * Check runs with one state each: a conclusion (`success`, `failure`,
 * `skipped`, ...) for runs that completed, or `null` for runs still going.
 */
export const ci = (conclusion: string | null, jobs: readonly string[] = JOBS): CheckRun[] =>
  jobs.map(name => (conclusion === null ? { name, status: 'in_progress', conclusion: null } : { name, status: 'completed', conclusion }))

export type PullRequest = {
  state: string
  merged: boolean
  mergeable: boolean | null
  mergeable_state: string
  draft: boolean
  title: string
  body: string
  head: { sha: string }
  base: { ref: string }
  merge_commit_sha: string | null
}

/** A test merge's commit, which GitHub names before a pull request is merged: never the merge's own. */
export const TEST_MERGE = 'f'.repeat(40)

/** An open pull request into main that GitHub would merge now. */
export const pull = (head: string, more: Partial<PullRequest> = {}): PullRequest => ({
  state: 'open',
  merged: false,
  mergeable: true,
  mergeable_state: 'clean',
  draft: false,
  title: 'A change',
  body: '',
  head: { sha: head },
  base: { ref: 'main' },
  merge_commit_sha: TEST_MERGE,
  ...more,
})

/** The pretend GitHub a test steers. */
export type Forge = {
  pulls: Record<number, PullRequest>
  /** Each commit's check runs; a commit not listed has none yet. */
  checks: Record<string, CheckRun[]>
  /** Each commit's commit statuses, which older integrations post; none by default. */
  statuses: Record<string, { context: string; state: string }[]>
  /** How many check runs GitHub says a commit has, when more than it lists: a commit not listed here has as many as are listed. */
  totals: Record<string, number>
  /** The base branch's head. */
  main: string
  /** The base branch moves to this commit right after the next read of its head: another push landing between two looks. */
  movesTo?: string
  /** GitHub cannot be reached at all. */
  isDown: boolean
  /** The token GitHub takes; any other is refused with 401. */
  accepts: string
  /** How a merge call is answered: done, done and then GitHub goes away, or refused with this status. */
  onMerge: 'merge' | 'merge and go down' | number
  /** Every merge call that reached GitHub. */
  merges: { pr: number; body: unknown }[]
  /** Every request, as `METHOD url`. */
  asked: string[]
}

/** One scripted answer of the pretend Lore CLI. */
export type LoreAnswer = {
  match: (argv: readonly string[], cwd?: string) => boolean
  answer: { exitCode: number; stdout: string; stderr?: string }
}

/** What the world hands back for the engine's side of things a test wants to steer or read. */
export type World = {
  /** The agent ids the next spawns are given, in order. */
  agentIds: string[]
  /** When set, the engine starts no agent and says this instead. */
  noStart: string | undefined
  /** No file can be written: the disk is full, or the folder is not the session's to write. */
  isReadOnly: boolean
  /** Every tool call that reached the engine: the mod's own tools never do. */
  ran: { tool: string; agentId?: string }[]
  /** Every agent the engine was asked to start, as the request reached it: a refused one never does. */
  spawns: { name?: string; model?: string; subagentType: string }[]
  /** The prompt each started agent was given, in the same order. */
  briefs: string[]
  /** Every prompt the mod queued to wake the main conversation. */
  woke: string[]
  /** Tools the engine refuses to run. */
  refuses: Set<string>
  /** How full the main conversation's context is, in percent, as the engine reports it. */
  percent: number | undefined
  /** Every compaction that reached the engine, as it was asked for. */
  compactions: { trigger: string; instructions?: string; agentId?: string }[]
  /** When set, the engine skips a compaction for this reason. */
  skips: string | undefined
  /** When set, the engine refuses a compaction a mod asks for, with this reason: the call rejects. */
  refusal: string | undefined
  /** The session is one the desktop app or an SDK host runs: a mod has no compaction call there, only the command. */
  isSdkHost: boolean
  /** How the built-in /compact behaves when a mod runs it: it compacts, it runs and changes nothing, or it cannot be run. */
  compactCommand: 'compacts' | 'changes nothing' | 'cannot be run'
  /** Every built-in command a mod ran as if the person had typed it. */
  commands: { command: string; args: string }[]
  /** The usage the engine reports for the next model request of a turn. */
  stepTokens: number
  /** Whether the repository has a `.claude/conductor` folder: where the mod works at all. */
  isHome: boolean
  /** The repository's `origin`: the GitHub clone's unless a test says otherwise; null for a repository with none. */
  origin: string | null
  /** The environment variables a token may come from: GH_TOKEN holds the test token unless a test says otherwise. */
  env: { GH_TOKEN?: string; GITHUB_TOKEN?: string; LINEAR_API_KEY?: string; LORE_BIN?: string }
  /** What `gh auth token` answers: by default gh is not signed in. */
  gh: { exitCode: number; stdout: string }
  /** Every command the mod ran on the host, as its argument vector. */
  processes: string[][]
  /** How `lore` answers: the first entry that matches a call answers it; a call none matches is a program that is not there. */
  lore: LoreAnswer[]
  /** Every `lore` call (any binary named lore), with the folder it ran in. */
  loreCalls: { argv: string[]; cwd?: string }[]
  /** Folders that exist, for `fs.exists`: a Lore workspace's `.lore`, say. */
  dirs: string[]
  /** The session's working directory, as `$.session.cwd()` answers it. */
  cwd: string
  /** Every command and tool the mod registered. */
  registered: string[]
  /** What each registered tool takes, by its name: the schema the engine holds a call to before the mod sees it. */
  schemas: Record<string, unknown>
  /** The model the engine resolves a request to: by default the family asked for, sonnet for none. */
  resolve: (asked: string | undefined) => string
  toasts: string[]
  forge: Forge
  /** The mod's own store: what it keeps between sessions. A test may fill it before the session starts. */
  store: Record<string, unknown>
  /** The store takes nothing more: a write is refused, as the engine refuses one past its size limit. */
  isStoreFull: boolean
  /** The session's id: the same after a restart of the app. */
  sessionId: string
  /**
   * Command names the engine keeps for itself and refuses a mod. `/run` is one
   * (measured on 2.1.293: `"/run" refused: it is the built-in /run`); the rest
   * are commands every build has had. A test may add one to see a refusal.
   */
  builtins: Set<string>
}

/**
 * The world beneath the mod: one repository, the files given (which the mod
 * may rewrite), a pane that is up, and an engine that starts agents and runs
 * tools. Each hook answers a call on `$` as the engine would: `{ value }`, or
 * `{ deny }` where the engine's own call rejects (a file that is not there).
 */
export function world(on: On, files: Files, repo: { root: string } | null = { root: ROOT }): World {
  const state: World = {
    agentIds: [],
    noStart: undefined,
    isReadOnly: false,
    ran: [],
    spawns: [],
    briefs: [],
    woke: [],
    refuses: new Set(),
    percent: 20,
    compactions: [],
    skips: undefined,
    refusal: undefined,
    isSdkHost: false,
    compactCommand: 'compacts',
    commands: [],
    stepTokens: 0,
    isHome: true,
    origin: ORIGIN,
    env: { GH_TOKEN: TOKEN },
    gh: { exitCode: 1, stdout: '' },
    processes: [],
    lore: [],
    loreCalls: [],
    dirs: [],
    cwd: repo?.root ?? ROOT,
    registered: [],
    schemas: {},
    resolve: asked => (asked === undefined ? 'claude-sonnet-5-5' : asked.startsWith('claude') ? asked : `claude-${asked}-5-5`),
    toasts: [],
    store: {},
    isStoreFull: false,
    sessionId: 'session-1',
    builtins: new Set(['run', 'help', 'clear', 'compact', 'config', 'model', 'memory', 'review', 'init', 'login', 'logout', 'status', 'resume', 'cost', 'exit', 'plugin', 'agents', 'mcp', 'hooks', 'permissions', 'doctor']),
    forge: {
      pulls: {},
      checks: { [MAIN]: ci('success') },
      statuses: {},
      totals: {},
      main: MAIN,
      isDown: false,
      accepts: TOKEN,
      onMerge: 'merge',
      merges: [],
      asked: [],
    },
  }
  on('env.get', (_$, e) => ({
    value: e.name === 'HOME' ? HOME : e.name === 'GH_TOKEN' || e.name === 'GITHUB_TOKEN' || e.name === 'LINEAR_API_KEY' || e.name === 'LORE_BIN' ? state.env[e.name] : undefined,
  }))
  on('process.run', (_$, e) => {
    state.processes.push([...e.argv])
    const isTokenAsked = e.argv.join(' ') === 'gh auth token'
    const cwd = e.init?.cwd
    if (/(^|\/)lore$/.test(e.argv[0] ?? '')) {
      state.loreCalls.push({ argv: [...e.argv], ...(cwd === undefined ? {} : { cwd }) })
      const scripted = state.lore.find(one => one.match(e.argv, cwd))?.answer
      if (scripted !== undefined) {
        return { value: { exitCode: scripted.exitCode, stdout: scripted.stdout, stderr: scripted.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
      }
    }

    return {
      value: isTokenAsked
        ? { exitCode: state.gh.exitCode, stdout: state.gh.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        : { exitCode: 127, stdout: '', stderr: `${e.argv[0] ?? ''}: not found`, isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('session.id', () => ({ value: state.sessionId }))
  on('store.get', (_$, e) => ({ value: state.store[e.key] }))
  on('store.set', (_$, e) => {
    if (state.isStoreFull) return { deny: 'the store is over 4 MiB' }
    state.store[e.key] = JSON.parse(JSON.stringify(e.value)) as unknown

    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete state.store[e.key]

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(state.store) }))
  on('http.fetch', (_$, e) => {
    const { forge } = state
    const method = e.init?.method ?? 'GET'
    forge.asked.push(`${method} ${e.url}`)
    const answer = (status: number, text: string) => ({ value: { status, ok: status >= 200 && status < 300, headers: {}, text } })
    const json = (status: number, body: unknown) => answer(status, JSON.stringify(body))
    if (forge.isDown) return { deny: 'getaddrinfo ENOTFOUND api.github.com' }
    if (!e.url.startsWith(API)) return json(404, { message: 'Not Found' })
    if (e.init?.headers?.Authorization !== `Bearer ${forge.accepts}`) return json(401, { message: 'Bad credentials' })
    const path = e.url.slice(API.length)
    const pulled = /^\/pulls\/(\d+)(\/merge)?$/.exec(path)
    if (pulled !== null) {
      const number = Number(pulled[1])
      const found = forge.pulls[number]
      if (found === undefined) return json(404, { message: 'Not Found' })
      if (pulled[2] === undefined) return json(200, { number, ...found })
      if (method !== 'PUT') return json(404, { message: 'Not Found' })
      const body = JSON.parse(e.init?.body ?? '{}') as { sha?: string }
      forge.merges.push({ pr: number, body })
      if (typeof forge.onMerge === 'number') {
        const message = forge.onMerge === 409 ? 'Head branch was modified. Review and try the merge again.' : forge.onMerge === 405 ? 'Pull Request is not mergeable' : 'Server Error'

        return json(forge.onMerge, { message })
      }
      if (body.sha !== found.head.sha) return json(409, { message: 'Head branch was modified. Review and try the merge again.' })
      Object.assign(found, { state: 'closed', merged: true, merge_commit_sha: mergeCommit(number) })
      forge.main = mergeCommit(number)
      if (forge.onMerge === 'merge and go down') forge.isDown = true

      return json(200, { sha: mergeCommit(number), merged: true, message: 'Pull Request successfully merged' })
    }
    const branch = /^\/branches\/([^/?]+)$/.exec(path)
    if (branch !== null) {
      const sha = forge.main
      if (forge.movesTo !== undefined) {
        forge.main = forge.movesTo
        forge.movesTo = undefined
      }

      return json(200, { name: decodeURIComponent(branch[1] ?? ''), commit: { sha } })
    }
    const checked = /^\/commits\/([0-9a-z]+)\/check-runs\?per_page=100$/.exec(path)
    if (checked !== null) {
      const sha = checked[1] ?? ''
      const list = forge.checks[sha] ?? []

      return json(200, { total_count: forge.totals[sha] ?? list.length, check_runs: list })
    }
    const status = /^\/commits\/([0-9a-z]+)\/status\?per_page=100$/.exec(path)
    if (status !== null) {
      const statuses = forge.statuses[status[1] ?? ''] ?? []

      return json(200, { state: statuses.length === 0 ? 'pending' : 'success', statuses, total_count: statuses.length })
    }

    return json(404, { message: 'Not Found' })
  })
  on('session.repo', () => ({
    value: repo === null ? null : { ...repo, remote: state.origin, internal: false, name: null },
  }))
  on('fs.list', (_$, e) => {
    const runs = Object.keys(files)
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => path.slice(e.path.length + 1).split('/')[0] ?? '')

    return {
      value: [...new Set(runs)].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
    }
  })
  on('fs.stat', (_$, e) => {
    const found = files[e.path]
    if (found === undefined) return { deny: `ENOENT: ${e.path}` }

    return { value: { kind: 'file' as const, size: found.text.length, mtimeMs: found.mtimeMs, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    const found = files[e.path]

    return found === undefined ? { deny: `ENOENT: ${e.path}` } : { value: found.text }
  })
  on('fs.write', (_$, e) => {
    if (state.isReadOnly) return { deny: `EROFS: ${e.path}` }
    files[e.path] = { text: e.text, mtimeMs: (files[e.path]?.mtimeMs ?? 0) + 1 }

    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_$, e) => ({ value: e.path.endsWith('.claude/conductor') ? state.isHome : files[e.path] !== undefined || state.dirs.includes(e.path) }))
  on('session.cwd', () => ({ value: state.cwd }))
  on('command.register', (_$, e) => {
    if (state.builtins.has(e.name)) return { deny: `"/${e.name}" refused: it is the built-in /${e.name}` }
    state.registered.push(`/${e.name}`)

    return { value: { command: e.name } }
  })
  on('tool.register', (_$, e) => {
    state.registered.push(e.name)
    state.schemas[e.name] = (e as { inputSchema?: unknown }).inputSchema

    return { value: { tool: `mcp__conductor__${e.name}` } }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({
    value: [{ id: PANE.requestId, title: PANE.props.title, isShown: true, isFocused: false, isPlaced: true }],
  }))
  on('agent.spawn', (_$, e) => {
    if (state.noStart !== undefined) return { deny: state.noStart }
    state.spawns.push({ name: e.name, model: e.model, subagentType: e.subagentType })
    state.briefs.push(e.prompt)

    return { model: state.resolve(e.model), agentId: state.agentIds.shift() ?? 'unnamed' }
  })
  on('prompt.submit', (_$, e) => {
    state.woke.push(e.text)

    return { text: e.text }
  })
  // A built-in command a mod runs for the person. /compact is a compaction as a turn of its own.
  on('command.run', (_$, e) => {
    state.commands.push({ command: e.command, args: e.args })
    if (e.command !== 'compact') return { text: `Unknown command: /${e.command}` }
    if (state.compactCommand === 'cannot be run') throw new Error('no such command here')
    if (state.compactCommand === 'compacts') state.percent = 12

    return { text: state.compactCommand === 'compacts' ? 'Compacted.' : 'Not enough to compact.' }
  })
  on('ui.toast', (_$, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('tool.call', (_$, e) => {
    const call = e as unknown as { tool: string; agentId?: string }
    state.ran.push({ tool: call.tool, agentId: call.agentId })
    if (state.refuses.has(call.tool)) return { deny: `${call.tool} is not allowed here` }

    return { result: {}, text: 'ran' }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, ...(state.percent === undefined ? {} : { percent: state.percent }) }, rateLimits: [] },
  }))
  on('session.compact', (_$, e) => {
    state.compactions.push({ trigger: e.trigger, instructions: e.instructions, agentId: e.agentId })
    if (state.refusal !== undefined) throw new Error(state.refusal)
    if (state.isSdkHost) throw new Error('not available in a headless (-p / SDK) session yet')
    if (state.skips !== undefined) return { skip: state.skips }
    state.percent = 12

    return { messages: [{ role: 'user' as const, text: 'Summary of the conversation so far.', toolUses: [] }], tokensBefore: 150_000, tokensAfter: 24_000 }
  })
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 1_000, output_tokens: 50, cache_read_input_tokens: state.stepTokens - 1_000, cache_creation_input_tokens: 0 },
    }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))

  return state
}

export const file = (ledger: Ledger, mtimeMs: number) => ({ text: JSON.stringify(ledger), mtimeMs })
export const ledgerPath = (run: string): string => `${RUNS}/${run}/ledger.json`

/** The picture a non-terminal surface draws in the pane right now. */
export const picture$ = async ($: Engine, surface: 'desktop' | 'vscode' | 'mobile') => {
  const ui = await $.ui.mount({ ...PANE, surface })
  const found = await ui.find({ type: 'Svg' })
  await ui.unmount()
  expect(found, `a picture on ${surface}`).toBeDefined()

  return { source: String(found?.props.source), alt: String(found?.props.alt) }
}

/** `/board [run]` as the person typing it in a wide fullscreen terminal. */
export const board = ($: Engine, args = '') =>
  $.command.run({
    command: 'board',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

export const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

/** Starts an agent as the Agent tool does; `parent` makes it a subagent of that agent. */
export const spawn = (
  $: Engine,
  name: string | undefined,
  parent?: string,
  more: { subagentType?: string; model?: string; fork?: boolean } = {},
) =>
  $.agent.spawn({
    tool_use_id: `spawn-${name ?? 'anonymous'}-${parent ?? 'main'}-${more.model ?? 'inherit'}`,
    prompt: 'Do the task.',
    description: 'worker',
    subagentType: more.subagentType ?? 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: more.fork ?? false,
    ...(more.model === undefined ? {} : { model: more.model }),
    ...(name === undefined ? {} : { name }),
    ...(parent === undefined ? {} : { parentAgentId: parent }),
  })
