import type { ProblemSeverity, TaskStatus } from '../types'
import type { Board, TaskRow, Timeline } from './board'
import { elapsedShort, orchestratorLine, problemDetail, summary, thousands, tierLabel } from './board'

/**
 * The run board as one SVG picture, for the surfaces that draw images. Pure:
 * a board and a width in, markup out. Nothing here measures text, so widths
 * are estimated per character and every long line is also clipped by its box.
 */

/** `auto`: the dark palette, switching to the light one where the picture is told the scheme is light. */
export type Theme = 'auto' | 'dark' | 'light'

export type DashboardOptions = {
  /** CSS pixels across. */
  width: number
  /** When the ledger was last written, as a wall-clock time, e.g. `08:26`. */
  updated?: string
  /** True when the session only views this run: nothing its agents do is recorded. */
  isViewOnly?: boolean
  theme?: Theme
  timeline?: Timeline
  /** Whole minutes since the run started. */
  runMinutes?: number
  /** What the run started from, e.g. `#12`. */
  source?: string
}

export type Dashboard = { source: string; alt: string; width: number; height: number }

/** How many rows a section lists before it says how many more there are. */
export const ROWS_SHOWN = 6
export const CHIPS_SHOWN = 8

const DARK = {
  primary: '#ECE9E2',
  secondary: '#A6A299',
  muted: '#918D84',
  line: '#3B3A37',
  strong: '#5C5A55',
  clay: '#D97757',
  green: '#6FA35B',
  amber: '#D9A036',
  red: '#E0655F',
}
const LIGHT: typeof DARK = {
  primary: '#1F1E1D',
  secondary: '#5F5D58',
  muted: '#6F6C66',
  line: '#DEDCD5',
  strong: '#B9B6AD',
  clay: '#C4633F',
  green: '#4F8A3C',
  amber: '#A9740F',
  red: '#C4453E',
}
type Ink = keyof typeof DARK

const SANS = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif`
const MONO = `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace`

/** Estimated advance per character, in px, at the sizes used below. */
const SANS_13 = 6.7
const SANS_12 = 6.2
const SANS_11 = 5.7
const MONO_12 = 7.25
const MONO_11 = 6.65
const MONO_26 = 15.7

const PAD = 2
const TEXT_X = PAD + 22
const GAP = 8
/** The lane labels' column: as wide as the longest worker name shown, within these bounds. */
const LANE_LABEL_MIN = 36
const LANE_LABEL_MAX = 56

const SEVERITY_INK: Record<ProblemSeverity, Ink> = { blocker: 'red', warning: 'amber', note: 'muted' }
const BAR_INK: Record<TaskStatus, Ink> = {
  queued: 'strong',
  building: 'clay',
  returned: 'secondary',
  review: 'green',
  green: 'green',
  done: 'muted',
  blocked: 'amber',
  failed: 'red',
}

const LEGEND_ORDER: readonly TaskStatus[] = ['building', 'returned', 'green', 'review', 'done', 'blocked', 'failed']
const LEGEND_WORD: Record<TaskStatus, string> = {
  queued: 'queued',
  building: 'building',
  returned: 'handed back',
  green: 'ready',
  review: 'in review',
  done: 'done',
  blocked: 'blocked',
  failed: 'failed',
}

const escape = (text: string): string =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const round = (value: number): number => Math.round(value * 10) / 10

/** The text cut to fit `px` at `per` px a character, ending in an ellipsis when cut. */
export function cut(text: string, px: number, per: number): string {
  const room = Math.floor(px / per)
  if (text.length <= room) return text

  return room <= 1 ? '…' : `${text.slice(0, room - 1).trimEnd()}…`
}

/** The end of the text that fits `px`, led by an ellipsis when cut: for a path, whose tail says most. */
export function cutStart(text: string, px: number, per: number): string {
  const room = Math.floor(px / per)
  if (text.length <= room) return text

  return room <= 1 ? '…' : `…${text.slice(text.length - (room - 1))}`
}

/** The text broken at spaces into at most `lines` lines; the first has `firstPx` of room, the rest `px`. */
export function wrap(text: string, firstPx: number, px: number, per: number, lines: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(one => one !== '')) {
    const room = Math.floor((out.length === 0 ? firstPx : px) / per)
    const next = line === '' ? word : `${line} ${word}`
    if (next.length <= room || line === '') {
      line = next
      continue
    }
    out.push(line)
    line = word
    if (out.length === lines) break
  }
  if (out.length < lines && line !== '') out.push(line)
  else if (line !== '' && out.length === lines) {
    const last = out[lines - 1] ?? ''
    out[lines - 1] = `${last.replace(/…$/, '')}…`
  }

  return out.map((one, at) => cut(one, at === 0 ? firstPx : px, per))
}

export function dashboardSvg(board: Board, options: DashboardOptions): Dashboard {
  const width = Math.round(options.width)
  const theme = options.theme ?? 'auto'
  const palette = theme === 'light' ? LIGHT : DARK
  const right = width - PAD
  const parts: string[] = []
  let y = 0

  const fill = (ink: Ink): string => ` class="f-${ink}" fill="${palette[ink]}"`
  const stroke = (ink: Ink): string => ` class="s-${ink}" stroke="${palette[ink]}"`
  const pulse = '<animate attributeName="opacity" values="1;0.4;1" dur="1.8s" repeatCount="indefinite"/>'

  /** A line of text clipped to `[x, x + w]`: an optional mono lead, then the rest in sans. */
  const line = (
    x: number,
    top: number,
    w: number,
    ink: Ink,
    size: 12 | 13,
    text: string,
    lead?: string,
  ): void => {
    const per = size === 13 ? SANS_13 : SANS_12
    const words = lead === undefined ? [] : lead.split(' ')
    const leadPx = lead === undefined ? 0 : words.join('').length * MONO_12 + (words.length - 1) * 4 + 6
    const body = cut(text, Math.max(0, w - leadPx), per)
    const leadSpan =
      words
        .map((word, at) => `<tspan font-family="${MONO}" font-size="12"${at === 0 ? '' : ' dx="4"'}>${escape(word)}</tspan>`)
        .join('') + (lead === undefined ? '' : '<tspan dx="6">')
    parts.push(
      `<svg x="${round(x)}" y="${round(top)}" width="${round(Math.max(1, w))}" height="20">` +
        `<text x="0" y="14" font-size="${size}"${fill(ink)}>${leadSpan}${escape(body)}${lead === undefined ? '' : '</tspan>'}</text></svg>`,
    )
  }
  const mono = (x: number, baseline: number, ink: Ink, text: string, size = 12, anchor = 'end'): void => {
    parts.push(
      `<text x="${round(x)}" y="${round(baseline)}" font-family="${MONO}" font-size="${size}" text-anchor="${anchor}"${fill(ink)}>${escape(text)}</text>`,
    )
  }
  /** Words and figures at the right edge, in the sans face. */
  const side = (baseline: number, ink: Ink, text: string, size: 11 | 12 = 12): void => {
    parts.push(
      `<text x="${right}" y="${round(baseline)}" font-size="${size}" text-anchor="end"${fill(ink)}>${escape(text)}</text>`,
    )
  }
  const label = (text: string, count: string): void => {
    y += 16
    parts.push(`<text x="${PAD}" y="${y + 10}" font-size="11"${fill('muted')}>${escape(text)}</text>`)
    side(y + 10, 'muted', count, 11)
    y += 18
  }
  const dot = (top: number, ink: Ink, opacity = 1, isPulsing = false): void => {
    parts.push(
      `<circle cx="${PAD + 7}" cy="${top + 10}" r="5" opacity="${opacity}"${fill(ink)}>${isPulsing ? pulse : ''}</circle>`,
    )
  }
  const ring = (top: number, ink: Ink, opacity = 1, isPulsing = false): void => {
    parts.push(
      `<circle cx="${PAD + 7}" cy="${top + 10}" r="3.75" fill="none" stroke-width="2.5" opacity="${opacity}"${stroke(ink)}>${isPulsing ? pulse : ''}</circle>`,
    )
  }
  const square = (top: number, ink: Ink): void => {
    parts.push(`<rect x="${PAD + 2}" y="${top + 5}" width="10" height="10" rx="2"${fill(ink)}/>`)
  }
  /** A lane's bar, and its sample in the key: solid while building or ready, hollow in review, thin once done. */
  const swatch = (status: TaskStatus, x: number, top: number, w: number, isPulsing: boolean): string => {
    const ink = BAR_INK[status]
    if (status === 'review' || status === 'returned') {
      return `<rect class="bar s-${ink}" x="${round(x) + 0.75}" y="${top + 0.75}" width="${round(Math.max(1.5, w - 1.5))}" height="8.5" rx="4.25" fill="none" stroke-width="1.5" stroke="${palette[ink]}"/>`
    }
    const thin = status === 'done'

    return `<rect class="bar f-${ink}" x="${round(x)}" y="${top + (thin ? 2 : 0)}" width="${round(w)}" height="${thin ? 6 : 10}" rx="${thin ? 3 : 5}" fill="${palette[ink]}">${isPulsing ? pulse : ''}</rect>`
  }
  /** A row: glyph drawn by the caller, a title line with an optional mono lead and right text, an optional meta line. */
  const row = (
    lead: string,
    title: string,
    rightText: string | undefined,
    rightInk: Ink,
    meta?: string,
    metaInk: Ink = 'secondary',
  ): void => {
    const rightPx = rightText === undefined ? 0 : rightText.length * SANS_12 + GAP + 4
    line(TEXT_X, y, right - TEXT_X - rightPx, 'primary', 13, title, lead)
    if (rightText !== undefined) side(y + 14, rightInk, rightText)
    y += 20
    if (meta !== undefined && meta !== '') {
      line(TEXT_X, y - 3, right - TEXT_X, metaInk, 12, meta)
      y += 16
    }
    y += 2
  }
  const more = (count: number, what: string): void => {
    if (count <= 0) return
    parts.push(`<text x="${TEXT_X}" y="${y + 11}" font-size="11"${fill('muted')}>and ${count} more ${what}</text>`)
    y += 18
  }

  // Header: the run, how far it is, how long it has been going.
  // The source keeps at most two fifths of the line, so a spec's long path cannot push the title out.
  const sourceText = options.source === undefined ? undefined : cutStart(options.source, (right - PAD) * 0.4, MONO_12)
  const sourcePx = sourceText === undefined ? 0 : sourceText.length * MONO_12 + GAP
  parts.push(
    `<svg x="${PAD}" y="0" width="${Math.max(1, right - PAD - sourcePx)}" height="20"><text x="0" y="14" font-size="13" font-weight="600"${fill('primary')}>${escape(cut(board.title, right - PAD - sourcePx, SANS_13 * 1.04))}</text></svg>`,
  )
  if (sourceText !== undefined) mono(right, 14, 'muted', sourceText)
  const done = String(board.done.length)
  parts.push(
    `<text x="${PAD}" y="50" font-family="${MONO}" font-size="26" font-weight="500"${fill('primary')}>${done}</text>`,
    `<text x="${round(PAD + done.length * MONO_26 + 7)}" y="50" font-size="12"${fill('secondary')}>of ${board.total} done</text>`,
  )
  if (options.runMinutes !== undefined) {
    side(50, 'secondary', `${elapsedShort(options.runMinutes)} in`)
  }
  y = 58

  if (board.problems.length > 0) {
    label('Problems', `${board.problems.length} open`)
    for (const one of board.problems.slice(0, ROWS_SHOWN)) {
      square(y, SEVERITY_INK[one.severity])
      const leadPx = one.id.length * MONO_12 + 6
      const lines = wrap(one.text, right - TEXT_X - leadPx, right - TEXT_X, SANS_13, 3)
      lines.forEach((text, at) => {
        line(TEXT_X, y, right - TEXT_X, 'primary', 13, text, at === 0 ? one.id : undefined)
        y += at === lines.length - 1 ? 20 : 17
      })
      line(TEXT_X, y - 3, right - TEXT_X, 'secondary', 12, problemDetail(one))
      y += 18
    }
    more(board.problems.length - ROWS_SHOWN, 'open')
  }

  const waitsForOwner = (board.plan === 'proposed' ? 1 : 0) + (board.pausedAt === undefined ? 0 : 1)
  if (board.plan === 'draft') {
    y += 14
    parts.push(`<text x="${PAD}" y="${y + 10}" font-size="12"${fill('secondary')}>The orchestrator is drafting the plan.</text>`)
    y += 12
  }
  if (board.attention.length + board.questions.length + waitsForOwner > 0) {
    label('Needs a decision', String(board.attention.length + board.questions.length + waitsForOwner))
    if (board.pausedAt !== undefined) {
      dot(y, 'clay')
      row('/unpause', 'The run is paused', undefined, 'secondary', 'no worker starts and nothing merges until then')
    }
    if (board.plan === 'proposed') {
      dot(y, 'clay')
      row('/approve', 'The plan waits for you', undefined, 'secondary', `${board.total} ${board.total === 1 ? 'task' : 'tasks'} · no worker starts before your approval`)
    }
    for (const task of board.attention.slice(0, ROWS_SHOWN)) {
      dot(y, task.status === 'failed' ? 'red' : 'amber')
      row(task.id, task.title, tierLabel(task), 'secondary', task.note === undefined ? task.status : `${task.status} · ${task.note}`)
    }
    more(board.attention.length - ROWS_SHOWN, 'waiting')
    // A worker's question waits for the orchestrator's ruling, not for the person: said so in its second line.
    for (const question of board.questions.slice(0, ROWS_SHOWN)) {
      ring(y, 'amber')
      const lines = wrap(question.text, right - TEXT_X - question.id.length * MONO_12 - 6, right - TEXT_X, SANS_13, 2)
      lines.forEach((text, at) => {
        line(TEXT_X, y, right - TEXT_X, 'primary', 13, text, at === 0 ? question.id : undefined)
        y += at === lines.length - 1 ? 20 : 17
      })
      line(TEXT_X, y - 3, right - TEXT_X, 'secondary', 12, `${question.from} asks the orchestrator`)
      y += 18
    }
    more(board.questions.length - ROWS_SHOWN, 'questions')
  }

  const lanes = options.timeline
  if (lanes !== undefined && lanes.lanes.length > 0) {
    y += 18
    const longest = Math.max(...lanes.lanes.map(lane => lane.worker.length))
    const labelCol = Math.min(LANE_LABEL_MAX, Math.max(LANE_LABEL_MIN, Math.ceil(longest * MONO_12) + 10))
    const trackX = PAD + labelCol
    const trackW = right - trackX
    let lastLabelEnd = trackX - 100
    for (const tick of lanes.ticks) {
      const x = trackX + tick.at * trackW
      const labelPx = tick.label.length * MONO_11
      const from = Math.max(trackX, x - labelPx / 2)
      if (from < lastLabelEnd + 10 || from + labelPx > right - 3 * MONO_11 - 12) continue
      mono(from, y + 10, 'muted', tick.label, 11, 'start')
      lastLabelEnd = from + labelPx
    }
    mono(right, y + 10, 'muted', 'now', 11)
    y += 17
    // The axis starts with a rule of its own unless a tick already stands within a few pixels of it.
    const firstTick = lanes.ticks[0]?.at ?? 1
    for (const at of [...(firstTick * trackW < 14 ? [] : [0]), ...lanes.ticks.map(tick => tick.at)]) {
      const x = round(trackX + at * trackW)
      parts.push(
        `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + lanes.lanes.length * 18}" stroke-width="1"${stroke('line')}/>`,
      )
    }
    for (const lane of lanes.lanes) {
      mono(PAD, y + 13, lane.isBuilding ? 'primary' : 'secondary', cut(lane.worker, labelCol - 6, MONO_12), 12, 'start')
      for (const bar of lane.bars) {
        const x = Math.min(trackX + bar.from * trackW, right - 3)
        const w = Math.max(3, Math.min((bar.to - bar.from) * trackW, right - x))
        parts.push(swatch(bar.status, x, y + 4, w, bar.status === 'building'))
      }
      y += 18
    }
    if (lanes.hidden > 0) {
      parts.push(`<text x="${trackX}" y="${y + 12}" font-size="11"${fill('muted')}>and ${lanes.hidden} earlier ${lanes.hidden === 1 ? 'worker' : 'workers'}</text>`)
      y += 16
    }
    // The key: the bars say their state by shape as well as colour, and the key names each one drawn.
    const drawn = new Set(lanes.lanes.flatMap(lane => lane.bars.map(bar => bar.status)))
    let keyX = PAD
    y += 8
    for (const status of LEGEND_ORDER) {
      if (!drawn.has(status)) continue
      const text = LEGEND_WORD[status]
      const w = 18 + text.length * SANS_11
      if (keyX > PAD && keyX + w > right) {
        keyX = PAD
        y += 16
      }
      parts.push(
        swatch(status, keyX, y + 1, 12, false),
        `<text x="${round(keyX + 17)}" y="${y + 10}" font-size="11"${fill('muted')}>${text}</text>`,
      )
      keyX += w + 12
    }
    y += 14
  }

  if (board.building.length > 0) {
    label('Now', `${board.building.length} building`)
    for (const task of board.building) {
      const isSilent = task.silentMinutes !== undefined
      ring(y, isSilent ? 'amber' : 'clay', 1, !isSilent)
      const lead = task.worker ?? task.id
      const meta = [
        lead === task.id ? undefined : task.id,
        tierLabel(task),
        task.silentMinutes === undefined ? undefined : `silent ${elapsedShort(task.silentMinutes)}`,
        task.contextTokens === undefined ? undefined : `${thousands(task.contextTokens)} tokens`,
        task.note ?? task.activity?.text,
      ]
      row(
        lead,
        task.title,
        task.minutes === undefined ? undefined : elapsedShort(task.minutes),
        'primary',
        meta.filter(one => one !== undefined).join(' · '),
        isSilent ? 'amber' : 'secondary',
      )
    }
  }

  if (board.returned.length > 0) {
    label('Handed back', String(board.returned.length))
    for (const task of board.returned.slice(0, ROWS_SHOWN)) {
      ring(y, 'secondary')
      const lead = task.worker ?? task.id
      const meta = [lead === task.id ? undefined : task.id, tierLabel(task), task.note ?? 'waits for the orchestrator']
      row(
        lead,
        task.title,
        task.sinceMinutes === undefined ? undefined : `${elapsedShort(task.sinceMinutes)} ago`,
        'secondary',
        meta.filter(one => one !== undefined).join(' · '),
      )
    }
    more(board.returned.length - ROWS_SHOWN, 'handed back')
  }

  const queued = [...board.next, ...board.waiting]
  if (queued.length > 0) {
    label('Up next', `${queued.length} queued`)
    let x = PAD
    const place = (w: number): void => {
      if (x > PAD && x + w > right) {
        x = PAD
        y += 28
      }
    }
    const chip = (task: TaskRow, isWaiting: boolean): void => {
      const text = cut(`${task.id} ${tierLabel(task)}`, right - PAD - 16, MONO_12)
      const w = text.length * MONO_12 + 16
      place(w)
      parts.push(
        `<g opacity="${isWaiting ? 0.7 : 1}"><rect x="${round(x) + 0.5}" y="${y + 0.5}" width="${round(w)}" height="22" rx="6" fill="none" stroke-width="1"${isWaiting ? ' stroke-dasharray="3 3"' : ''}${stroke('strong')}/>` +
          `<text x="${round(x + 8)}" y="${y + 15.5}" font-family="${MONO}" font-size="12"${fill('primary')}>${escape(text)}</text></g>`,
      )
      x += w + 6
    }
    const shown = queued.slice(0, CHIPS_SHOWN)
    shown.forEach((task, at) => {
      const isWaiting = at >= board.next.length
      if (isWaiting && at === board.next.length && at > 0) {
        place(4 * SANS_12 + 6)
        parts.push(`<text x="${round(x)}" y="${y + 15.5}" font-size="12"${fill('secondary')}>then</text>`)
        x += 4 * SANS_12 + 8
      }
      chip(task, isWaiting)
    })
    y += 28
    more(queued.length - shown.length, 'queued')
  }

  if (board.review.length > 0) {
    const flight = board.review.find(task => task.merging !== undefined)
    const ready = board.review.filter(task => task.status === 'green' && task.merging === undefined).length
    const waiting = board.review.filter(task => task.status === 'review').length
    label(
      'To merge',
      [flight?.merging ?? '', ready > 0 ? `${ready} ready` : '', waiting > 0 ? `${waiting} in review` : ''].filter(one => one !== '').join(' · '),
    )
    for (const task of board.review.slice(0, ROWS_SHOWN)) {
      if (task.status === 'green') dot(y, 'green', 1, task.merging !== undefined)
      else ring(y, 'green', 0.6)
      // The one in flight says how long it has been: silence reads as stuck.
      const where = task.merging === undefined ? undefined : task.mergeMinutes === undefined ? task.merging : `${task.merging} · ${elapsedShort(task.mergeMinutes)}`
      row(task.pr === undefined ? task.id : `PR ${task.pr}`, task.title, where ?? (task.status === 'green' ? 'ready' : 'review'), 'secondary')
    }
    more(board.review.length - ROWS_SHOWN, 'to merge')
  }

  const own = orchestratorLine(board.orchestrator)
  if (own !== undefined) {
    y += 14
    const isFull = (board.orchestrator?.contextPercent ?? 0) >= 70
    parts.push(`<text x="${PAD}" y="${y + 10}" font-size="11"${fill(isFull ? 'amber' : 'muted')}>${escape(own)}</text>`)
    y += 2
  }
  if (options.updated !== undefined) {
    y += 14
    const said = [
      board.findings > 0 ? `${board.findings} ${board.findings === 1 ? 'finding' : 'findings'}` : '',
      board.rulings > 0 ? `${board.rulings} ${board.rulings === 1 ? 'ruling' : 'rulings'}` : '',
    ].filter(one => one !== '')
    const footer = `Updated ${options.updated}${said.length > 0 ? ` · ${said.join(', ')} on the board` : ''}${options.isViewOnly === true ? ' · view only' : ''}`
    parts.push(`<text x="${PAD}" y="${y + 10}" font-size="11"${fill('muted')}>${escape(footer)}</text>`)
    y += 14
  }

  const height = Math.ceil(y + 6)
  const alt = [
    `${board.title}: ${summary(board)}.`,
    ...board.problems.map(one => `Problem ${one.id}, ${one.severity}: ${one.text}.`),
    ...board.attention.map(one => `${one.id} ${one.title} is ${one.status}.`),
  ].join(' ')
  const light =
    theme === 'auto'
      ? `<style>@media (prefers-color-scheme: light){${(Object.keys(LIGHT) as Ink[])
          .map(ink => `.f-${ink}{fill:${LIGHT[ink]}}.s-${ink}{stroke:${LIGHT[ink]}}`)
          .join('')}}</style>`
      : ''
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${SANS}" role="img" aria-label="${escape(alt)}">` +
    light +
    parts.join('') +
    '</svg>'

  return { source, alt, width, height }
}
