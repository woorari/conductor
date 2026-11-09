import type { Base } from './router'
import type { Ledger, Post, Ruling, Task } from '../types'
import { changed, covers, fileList, normalise, overlap, refused, tidy } from './signals'
import type { Caller, Delivery, Outcome, Raw, RawTask } from './signals'

/**
 * The run's board: what workers tell each other and ask the orchestrator,
 * and what it rules. Each function is a pure edit of the ledger's JSON that
 * also says who is to be told. Nothing is broadcast: a finding goes to the
 * workers whose files it concerns, a question to the orchestrator, a ruling
 * to the workers it binds.
 */

export const ORCHESTRATOR = 'orchestrator'
const POST_MAX = 600
/** How many files a task's worker is remembered to have changed. */
const TOUCHED_MAX = 300
/** How many findings and rulings a briefing or a digest lists. */
const LISTED = 6

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(one => typeof one === 'string') : [])
const next = (all: readonly { id: string }[], letter: string): string =>
  `${letter}${Math.max(0, ...all.map(one => Number(new RegExp(`^${letter}(\\d+)$`).exec(one.id)?.[1] ?? 0))) + 1}`
const isBuilding = (task: RawTask): boolean => task.status === 'building' && typeof task.agentId === 'string'

/** A finding as its readers get it. */
export const findingText = (one: { id: string; from: string; text: string; files?: readonly string[] }): string =>
  `Run board, finding ${one.id} from ${one.from}: ${one.text}${one.files === undefined || one.files.length === 0 ? '' : ` (files: ${one.files.join(', ')})`}`

/** A ruling as its readers get it. */
export const rulingText = (one: { id: string; text: string; answers?: string }): string =>
  `Run board, ruling ${one.id}${one.answers === undefined ? '' : ` (answers ${one.answers})`}: ${one.text}`

const list = (taskIds: readonly string[]): string => taskIds.join(', ')

/**
 * A path as the board compares paths: relative to the repository, whichever
 * worktree of it the worker edits in. A Lore worker's own workspace is a copy
 * of the repository's, so a path in it is relative to that workspace.
 */
export function relative(path: string, root: string, workspace?: string): string {
  const own = workspace !== undefined && path.startsWith(`${workspace}/`) ? path.slice(workspace.length + 1) : undefined
  const inRepo = own ?? (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)

  return normalise(inRepo.replace(/^(?:.*\/)?\.claude\/worktrees\/[^/]+\//, ''))
}

/** Whether what a post concerns touches what a task is expected to change or has changed. */
const concerns = (files: readonly string[], task: RawTask): boolean => {
  const own = [...strings(task.files), ...strings(task.touched)]

  return files.some(file => covers(own, file))
}

/** `board_post`: a finding for the workers it concerns, or a worker's question to the orchestrator. */
export function post(raw: Raw, at: string, caller: Caller, input: Record<string, unknown>): Outcome {
  if (caller.kind !== 'orchestrator' && caller.kind !== 'worker') return refused('Only the orchestrator and a task’s own worker post on the board.')
  if (input.kind !== 'finding' && input.kind !== 'question') {
    return refused('kind is finding (a fact other workers may need) or question (a decision you need from the orchestrator).')
  }
  if (typeof input.text !== 'string' || tidy(input.text) === '') return refused('Say it in text: {"kind": "...", "text": "..."}.')
  const text = tidy(input.text)
  if (text.length > POST_MAX) return refused(`text is at most ${POST_MAX} characters; this one has ${text.length}.`)
  const files = input.files === undefined ? [] : fileList(input.files)
  if (files === undefined) return refused('files is a list of files or folders, relative to the repository.')
  const from = caller.kind === 'worker' ? caller.taskId : ORCHESTRATOR
  const posts = (raw.posts ??= [])

  if (input.kind === 'question') {
    if (caller.kind !== 'worker') {
      return refused('A question on the board is a worker’s question to the orchestrator. Ask the owner in the conversation.')
    }
    const id = next(posts, 'Q')
    posts.push({ id, kind: 'question', text, from, at, ...(files.length > 0 ? { files } : {}) })

    return {
      ...changed(`${id} asked; the orchestrator is told. Go on with what does not depend on the answer, or set your task blocked and stop.`),
      wake: `Run board: ${from} asks ${id}: ${text}`,
      asks: id,
    }
  }

  const id = next(posts, 'F')
  const readers = raw.tasks.filter(task => task.id !== from && isBuilding(task) && concerns(files, task)).map(task => task.id)
  const finding = { id, kind: 'finding', text, from, at, ...(files.length > 0 ? { files } : {}), ...(readers.length > 0 ? { for: readers } : {}) }
  posts.push(finding)
  const deliveries: Delivery[] = readers.map(taskId => ({ taskId, text: findingText(finding), source: { list: 'posts', id } }))
  const where =
    readers.length > 0
      ? `for ${list(readers)}, who ${readers.length === 1 ? 'reads' : 'read'} it at the next step`
      : files.length > 0
        ? 'no worker is on those files now; it is on the board for the next one'
        : 'it names no files, so it is on the board and goes to nobody'

  return { ...changed(`${id} posted; ${where}.`), deliveries }
}

/** `board_rule`: the orchestrator's numbered decision, sent to every worker it binds. */
export function rule(raw: Raw, at: string, caller: Caller, input: Record<string, unknown>): Outcome {
  if (caller.kind !== 'orchestrator') return refused('Only the orchestrator rules. Ask with board_post, kind question.')
  if (typeof input.text !== 'string' || tidy(input.text) === '') return refused('Say what is decided: {"text": "..."}.')
  const text = tidy(input.text)
  if (text.length > POST_MAX) return refused(`text is at most ${POST_MAX} characters; this one has ${text.length}.`)
  const named = input.tasks === undefined ? [] : fileList(input.tasks)
  if (named === undefined) return refused('tasks is a list of task ids.')
  const stranger = named.find(id => !raw.tasks.some(task => task.id === id))
  if (stranger !== undefined) return refused(`There is no task ${stranger} in this run.`)
  const question = input.answers === undefined ? undefined : (raw.posts ?? []).find(one => one.id === input.answers)
  if (input.answers !== undefined) {
    if (question === undefined || question.kind !== 'question') return refused(`There is no question ${String(input.answers)} on the board.`)
    if (question.answeredBy !== undefined) return refused(`${question.id} was answered by ${String(question.answeredBy)}.`)
  }

  const rulings = (raw.rulings ??= [])
  const id = next(rulings, 'R')
  const bound = [...new Set([...named, ...(question === undefined ? [] : [String(question.from)])])]
  // A ruling that names tasks or answers a question is for those workers even when they have stopped;
  // one that names nobody is for the workers building now.
  const readers = raw.tasks.filter(
    task => typeof task.agentId === 'string' && task.status !== 'done' && (bound.length > 0 ? bound.includes(task.id) : isBuilding(task)),
  )
  if (question !== undefined) question.answeredBy = id
  const ruling = {
    id,
    text,
    at,
    ...(question === undefined ? {} : { answers: question.id }),
    ...(named.length > 0 ? { tasks: named } : {}),
    ...(readers.length > 0 ? { for: readers.map(task => task.id) } : {}),
  }
  rulings.push(ruling)
  const deliveries: Delivery[] = readers.map(task => ({ taskId: task.id, text: rulingText(ruling), source: { list: 'rulings', id } }))
  const running = readers.filter(isBuilding).map(task => task.id)
  const stopped = readers.filter(task => !isBuilding(task)).map(task => task.id)
  // The mod starts nobody: a stopped worker reads the ruling when it runs again, and starting it is the orchestrator's own act.
  const where = [
    running.length > 0 ? `for ${list(running)}, who ${running.length === 1 ? 'reads' : 'read'} it at the next step` : '',
    stopped.length > 0
      ? `${list(stopped)} ${stopped.length === 1 ? 'has' : 'have'} stopped and ${stopped.length === 1 ? 'reads' : 'read'} it on running again: send ${stopped.length === 1 ? 'it' : 'each'} a message to start ${stopped.length === 1 ? 'it' : 'them'}`
      : '',
  ].filter(one => one !== '')
  const answers = question === undefined ? '' : ` (answers ${question.id})`

  return {
    ...changed(`${id} recorded${answers}; ${where.length > 0 ? where.join('; ') : 'no worker to read it now'}.`),
    deliveries,
    ...(question === undefined ? {} : { answered: question.id }),
  }
}

/** Whether `taskId` waits for `otherId`, directly or through other tasks: the plan has put the two in order. */
function waitsOn(raw: Raw, taskId: string, otherId: string, seen: ReadonlySet<string> = new Set()): boolean {
  const task = raw.tasks.find(one => one.id === taskId)
  if (task === undefined || seen.has(taskId)) return false
  const after = strings(task.dependsOn)

  return after.includes(otherId) || after.some(id => waitsOn(raw, id, otherId, new Set([...seen, taskId])))
}

/** A worker is on the task right now: it started, and its turn has not ended (or it was started again). */
const isAtWork = (task: RawTask): boolean => typeof task.startedAt === 'string' && task.finishedAt === undefined

/**
 * A worker changed files. They are remembered as the task's, and when another
 * open task changes or is expected to change one of them, the board records
 * it once and tells both workers and the orchestrator.
 *
 * Not for two tasks of which one waits for the other: that they change the
 * same file is why the plan put them in order, and the later one builds on
 * the earlier one's change. In the first real run all 55 of these warnings
 * were for such pairs, each resolved by hand (measured 2026-10-09). The one
 * case that is worth saying for an ordered pair is kept: both workers at work
 * at once, which happens when the earlier task is sent back and changed again
 * while the later one is being built on it.
 */
export function touch(raw: Raw, at: string, taskId: string, files: readonly string[]): Outcome {
  const task = raw.tasks.find(one => one.id === taskId)
  if (task === undefined || task.status === 'done') return { isChanged: false, isError: false, text: '' }
  const known = new Set(strings(task.touched))
  const fresh = [...new Set(files.map(normalise))].filter(file => file !== '' && !known.has(file))
  if (fresh.length === 0) return { isChanged: false, isError: false, text: '' }
  task.touched = [...known, ...fresh].slice(-TOUCHED_MAX)

  const problems = (raw.problems ??= [])
  const deliveries: Delivery[] = []
  const told: string[] = []
  for (const file of fresh) {
    const others = raw.tasks.filter(
      other =>
        other.id !== taskId &&
        other.status !== 'done' &&
        (strings(other.touched).includes(file) || covers(strings(other.files), file)) &&
        (isAtWork(other) || !(waitsOn(raw, taskId, other.id) || waitsOn(raw, other.id, taskId))),
    )
    for (const other of others) {
      const text = `${[taskId, other.id].sort().join(' and ')} both change ${file}.`
      if (problems.some(one => one.text === text)) continue
      const id = next(problems, 'P')
      problems.push({ id, text, severity: 'warning', status: 'open', taskId, foundAt: at })
      told.push(`${id}: ${text}`)
      for (const [mine, theirs] of [
        [task, other],
        [other, task],
      ] as const) {
        if (!isBuilding(mine)) continue
        deliveries.push({
          taskId: mine.id,
          text: `Run board: ${theirs.id} also changes ${file} (${id}). Do not overwrite its work. If your change depends on it, ask with mcp__conductor__board_post, kind question.`,
        })
      }
    }
  }

  return {
    isChanged: true,
    isError: false,
    text: '',
    deliveries,
    ...(told.length > 0 ? { tell: `Run board: two tasks change the same file. ${told.join(' ')} Decide their order, or rule who yields.` } : {}),
  }
}

const bindsTask = (ruling: { tasks?: string[]; answers?: string }, taskId: string, asked: ReadonlySet<string>): boolean =>
  ruling.tasks === undefined ? ruling.answers === undefined || asked.has(ruling.answers) : ruling.tasks.includes(taskId)

/**
 * What still waits for its reader: every finding and ruling meant for a
 * worker that has not been handed it. From the ledger alone, so a reload of
 * the mod forgets nothing.
 */
export function waiting(ledger: Ledger): Delivery[] {
  const finished = new Set(ledger.tasks.filter(one => one.status === 'done').map(one => one.id))
  const open = (one: Post | Ruling): string[] =>
    (one.for ?? []).filter(taskId => !(one.deliveredTo ?? []).includes(taskId) && !finished.has(taskId))

  return [
    ...ledger.posts
      .filter(one => one.kind === 'finding')
      .flatMap(one => open(one).map((taskId): Delivery => ({ taskId, text: findingText(one), source: { list: 'posts', id: one.id } }))),
    ...ledger.rulings.flatMap(one => open(one).map((taskId): Delivery => ({ taskId, text: rulingText(one), source: { list: 'rulings', id: one.id } }))),
  ]
}

/** What a task's worker should know from the board: the rulings that bind it and the findings on its files. */
function forTask(ledger: Ledger, task: Task): string[] {
  const own = [...(task.files ?? []), ...(task.touched ?? [])]
  const asked = new Set(ledger.posts.filter(one => one.kind === 'question' && one.from === task.id).map(one => one.id))
  const rulings = ledger.rulings.filter(one => bindsTask(one, task.id, asked)).slice(-LISTED)
  const findings = ledger.posts
    .filter(one => one.kind === 'finding' && one.from !== task.id && (one.files ?? []).some(file => covers(own, file)))
    .slice(-LISTED)
  const open = ledger.posts.filter(one => one.kind === 'question' && one.from === task.id && one.answeredBy === undefined)

  return [
    ...rulings.map(one => `- Ruling ${one.id}${one.answers === undefined ? '' : ` (answers ${one.answers})`}: ${one.text}`),
    ...findings.map(one => `- Finding ${one.id} from ${one.from} (${(one.files ?? []).join(', ')}): ${one.text}`),
    ...open.map(one => `- Your question ${one.id} is not answered yet: ${one.text}`),
  ]
}

/** `board_read` for a worker: the rulings that bind it, the findings on its files, its open questions. */
export function digest(ledger: Ledger, caller: Caller): string {
  if (caller.kind !== 'worker') return 'Only the orchestrator and a task’s own worker read the board.'
  const task = ledger.tasks.find(one => one.id === caller.taskId)
  const lines = task === undefined ? [] : forTask(ledger, task)

  return lines.length === 0 ? `Nothing on the board concerns ${caller.taskId} yet.` : [`The board, for ${caller.taskId}:`, ...lines].join('\n')
}

/**
 * What a worker is told as it starts, after the orchestrator's own words:
 * which task it has, how it reports, and what the board already holds for it.
 */
export function briefing(ledger: Ledger, task: Task, project?: { brief: string; slot: number }, base?: Base): string {
  const files = task.files ?? []
  // A worker started again, or one whose context was compacted, is on a branch that was started from another task's.
  const was = task.builtOn === undefined ? undefined : ledger.tasks.find(one => one.id === task.builtOn && one.status !== 'done')
  const on = base ?? (was === undefined ? undefined : { taskId: was.id, branch: was.branch, pr: was.pr })
  const where = on === undefined ? '' : on.branch === undefined ? `the head branch of pull request ${on.pr ?? '?'}` : `the branch \`${on.branch}\``
  const known = forTask(ledger, task)
  // The project's own rules for a worker, with the names that are this worker's alone filled in.
  const rules =
    project === undefined || project.brief.trim() === ''
      ? []
      : [
          '',
          project.brief
            .trim()
            .replaceAll('{task}', task.id.toLowerCase().replace(/[^a-z0-9]+/g, '_'))
            .replaceAll('{slot}', String(project.slot))
            .replaceAll('{run}', ledger.run.id),
        ]

  // In a Lore run the worker builds in a workspace the mod made, on a branch the mod named, and hands back a revision.
  const runLore = ledger.run.lore
  const own = runLore === undefined ? undefined : `${runLore.branch}/${task.id}`
  const locks = ledger.run.config?.lore?.lockPatterns ?? []
  const loreLines =
    own === undefined
      ? undefined
      : [
          '- Say where you stand with mcp__conductor__task_update: a note of what you are doing; review with the revision you pushed (task_update with revision; lore branch info shows it as Remote Latest) once your change is pushed; blocked or failed when you cannot go on. You cannot mark your task done: the orchestrator judges your hand-back.',
          `- You work in your own Lore workspace, your working directory, on your branch ${own}, which the mod made for you. Never change the owner's workspace or another worker's. Commit and push your branch at every green step, because only what is pushed survives: lore status --scan, lore stage --scan <paths>, lore commit "<message>", lore push. lore diff <file> shows a change. You never merge, switch or create branches, and never push another branch: merging is the orchestrator's, through the board.`,
          ...(locks.length === 0
            ? []
            : [`- Binary files cannot be merged. Before you change a file matching ${locks.join(', ')}, take its lock with lore lock acquire <file>, and keep it: the mod lets it go once your task is merged.`]),
        ]

  return [
    '',
    '---',
    `Run board (conductor). You are the worker for task \`${task.id}\` ("${task.title}") of run \`${ledger.run.id}\`, on the ${task.tier} tier.`,
    ...(loreLines === undefined ? ['- Say where you stand with mcp__conductor__task_update: a note of what you are doing; review with pr and branch when your pull request is open; blocked or failed when you cannot go on. You cannot mark your task done: the orchestrator judges your hand-back.'] : [loreLines[0]!]),
    '- A problem you find: mcp__conductor__problem_report. A fact another worker may need: mcp__conductor__board_post, kind finding, with the files it concerns. A decision you need: board_post, kind question; go on with what does not depend on the answer, or set your task blocked and stop. mcp__conductor__board_read shows what the board holds for you.',
    ...(loreLines === undefined ? ['- You never merge and never push to the base branch. When your pull request is open, set your task to review and hand back: merging is the orchestrator\'s, through the board.'] : loreLines.slice(1)),
    ...(on === undefined
      ? []
      : task.startedAt === undefined && own !== undefined
        ? [`- Your branch was started from ${where} (${on.taskId}'s change, judged green but not merged yet), not from the run branch, because your task needs it. Keep it so.`]
        : task.startedAt === undefined
        ? [
            `- Build on ${where}, not on main. It holds ${on.taskId}'s change, which is reviewed and has green checks but is not merged yet, and your task needs it. After a fetch, start your own branch from ${on.branch === undefined ? 'that branch' : `\`origin/${on.branch}\``}: this takes the place of any rule below that says to branch from main. Your pull request still targets main, and until ${on.taskId} is merged it shows that task's commits too. Do not rebase. Merge origin/main into your branch only if you need something from main that ${where} lacks, and say so in your task's note.`,
          ]
        : [`- This task is built on ${where} (${on.taskId}'s change, not merged yet): its branch was started from there. Keep it so: do not rebase, and do not start over from main.`]),
    files.length > 0
      ? `- Your task is expected to change: ${files.join(', ')}. The board sees which files you change; if another task changes one of them too, both of you are told.`
      : '- The board sees which files you change; if another task changes one of them too, both of you are told.',
    ...(task.startedAt === undefined
      ? []
      : [
          `- A worker was on this task before you${task.branch === undefined ? '' : `, on the branch ${task.branch}`}${task.note === undefined ? '' : `; its last note: ${task.note}`}. Go on from where it stopped: read the branch and its commits first, and do not start over.`,
        ]),
    // A worker the orchestrator took back may have left work that nobody committed.
    ...((task.retired ?? []).length === 0
      ? []
      : [
          `- The worker before you was stopped before it handed back, so what it did may not be committed or pushed: start with ${own === undefined ? 'git status and git diff' : 'lore status --scan and lore diff in your workspace'}, keep what serves the task, and commit and push it.`,
        ]),
    ...(known.length > 0 ? ['- From the board, for you:', ...known.map(line => `  ${line}`)] : []),
    ...rules,
  ].join('\n')
}

export { overlap }
