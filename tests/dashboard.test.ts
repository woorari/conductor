import { describe, expect, test } from 'claude-code/testing'

import { boardView, elapsedShort, runMinutes, timeline } from '../hooks/board'
import { ROWS_SHOWN, cut, cutStart, dashboardSvg, wrap } from '../hooks/dashboard'
import type { Ledger, Problem, Task } from '../types'
import { LEDGER, NOW, withTask } from './fixture'

const WIDTH = 400
const draw = (ledger: Ledger = LEDGER, width = WIDTH, theme: 'auto' | 'dark' | 'light' = 'auto') =>
  dashboardSvg(boardView(ledger, NOW), {
    width,
    theme,
    timeline: timeline(ledger, NOW, 0),
    runMinutes: runMinutes(ledger, NOW),
    source: ledger.run.source,
    updated: '10:29',
  })
const count = (text: string, piece: string): number => text.split(piece).length - 1
const numbers = (text: string, pattern: RegExp): number[] => [...text.matchAll(pattern)].map(found => Number(found[1]))

describe('timeline', () => {
  const lanes = timeline(LEDGER, NOW, 0)!

  test('puts the workers building now on top, longest running first, then the most recently active', () => {
    expect(lanes.lanes.map(lane => lane.worker)).toEqual(['w394', 'w391', 'w393', 'w395', 'w390', 'w396'])
    expect(lanes.lanes.map(lane => lane.isBuilding)).toEqual([true, true, false, false, false, false])
  })

  test('gives one worker one lane for every task it worked on', () => {
    expect(lanes.lanes.find(lane => lane.worker === 'w390')?.bars.map(bar => bar.taskId)).toEqual(['t390-1', 't390-2'])
  })

  test('places every bar inside the axis, running forward', () => {
    for (const bar of lanes.lanes.flatMap(lane => lane.bars)) {
      expect(bar.from).toBeGreaterThanOrEqual(0)
      expect(bar.to).toBeLessThanOrEqual(1)
      expect(bar.to).toBeGreaterThan(bar.from)
    }
  })

  test('runs a task with no end time on to now', () => {
    expect(lanes.lanes[0]?.bars[0]?.to).toBe(1)
    expect(lanes.lanes.find(lane => lane.worker === 'w396')?.bars[0]?.to).toBe(0.5)
  })

  test('ticks the axis on the hour of the wall clock it is told', () => {
    expect(lanes.ticks.map(tick => tick.label)).toEqual(['08:00', '09:00', '10:00'])
    expect(timeline(LEDGER, NOW, 120)!.ticks.map(tick => tick.label)).toEqual(['10:00', '11:00', '12:00'])
    expect(timeline(LEDGER, NOW, -210)!.ticks.map(tick => tick.label)).toEqual(['05:00', '06:00'])
  })

  test('keeps every building lane and says how many others it left out', () => {
    const few = timeline(LEDGER, NOW, 0, 3)!
    expect(few.lanes.map(lane => lane.worker)).toEqual(['w394', 'w391', 'w393'])
    expect(few.hidden).toBe(3)
    expect(timeline(LEDGER, NOW, 0, 1)!.lanes.map(lane => lane.worker)).toEqual(['w394', 'w391'])
  })

  test('draws nothing for a run where no task has both a worker and a start time', () => {
    const bare: Ledger = { ...LEDGER, tasks: LEDGER.tasks.map(({ worker: _worker, ...rest }) => rest) }
    expect(timeline(bare, NOW, 0)).toBeUndefined()
  })

  test('counts the run from its start', () => {
    expect(runMinutes(LEDGER, NOW)).toBe(150)
    expect(runMinutes(LEDGER, 0)).toBeUndefined()
    expect([12, 65, 150].map(elapsedShort)).toEqual(['12 min', '1 h 05', '2 h 30'])
  })
})

describe('fitting text without measuring it', () => {
  test('leaves a text that fits alone and ends a cut one with an ellipsis', () => {
    expect(cut('Settings module', 200, 7)).toBe('Settings module')
    const short = cut('Pool exhaustion answers 503', 70, 7)
    expect(short).toBe('Pool exha…')
    expect(short.length).toBeLessThanOrEqual(10)
  })

  test('keeps the end of a path that is too long, where the file name is', () => {
    expect(cutStart('#334', 100, 7)).toBe('#334')
    expect(cutStart('docs/superpowers/specs/2026-10-01-ai-cost.md', 140, 7)).toBe('…26-10-01-ai-cost.md')
  })

  test('wraps at spaces and marks what did not fit in the lines it has', () => {
    expect(wrap('Pool timeout test fails on the CI runner', 140, 140, 7, 3)).toEqual([
      'Pool timeout test',
      'fails on the CI',
      'runner',
    ])
    const two = wrap('Pool timeout test fails on the CI runner', 140, 140, 7, 2)
    expect(two).toHaveLength(2)
    expect(two[1]).toBe('fails on the CI…')
  })

  test('gives the first line less room when something leads it', () => {
    expect(wrap('The shared api image lacks h2', 70, 210, 7, 3)).toEqual(['The shared', 'api image lacks h2'])
  })
})

describe('dashboardSvg', () => {
  const picture = draw()

  test('is one svg document of the width asked for, with its text as the alternative', () => {
    expect(picture.source.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${picture.height}"`)).toBe(true)
    expect(picture.source.endsWith('</svg>')).toBe(true)
    expect(picture.alt).toContain('Nightly import speed: 2 problems open')
    expect(picture.alt).toContain('Problem P2, blocker: Pool timeout test fails on the CI runner.')
    expect(picture.alt).toContain('t396-1 Load test kit is blocked.')
  })

  test('closes every element it opens', () => {
    for (const tag of ['svg', 'text', 'tspan', 'g', 'circle', 'rect']) {
      const opened = count(picture.source, `<${tag} `) + count(picture.source, `<${tag}>`)
      const selfClosed = [...picture.source.matchAll(new RegExp(`<${tag} [^>]*/>`, 'g'))].length
      expect(opened - selfClosed, tag).toBe(count(picture.source, `</${tag}>`))
    }
  })

  test('shows problems and decisions first, then the lanes, now, up next and to merge', () => {
    const order = ['>Problems<', '>Needs a decision<', '>now<', '>Now<', '>Up next<', '>To merge<'].map(piece =>
      picture.source.indexOf(piece),
    )
    expect(order.every(at => at > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test('draws one bar for every task a worker started, and pulses what is building', () => {
    const bars = count(picture.source, 'class="bar ')
    const inKey = 5
    expect(bars - inKey).toBe(7)
    expect(count(picture.source, '<animate ')).toBe(4)
  })

  test('tells the bars apart by shape as well as colour, and names each kind drawn in a key', () => {
    expect(count(picture.source, 'height="6" rx="3"'), 'done bars are thin').toBe(2 + 1)
    expect(count(picture.source, 'fill="none" stroke-width="1.5"'), 'a bar in review is hollow').toBe(1 + 1)
    for (const word of ['building', 'ready', 'in review', 'done', 'blocked']) {
      expect(picture.source, word).toContain(`font-size="11" class="f-muted" fill="#918D84">${word}</text>`)
    }
    expect(picture.source).not.toContain('>failed</text>')
    const calm = draw({ ...LEDGER, tasks: LEDGER.tasks.filter(task => task.status === 'done') })
    expect(calm.source).toContain('>done</text>')
    expect(calm.source).not.toContain('>building</text>')
  })

  test('says when the ledger was last written, so a board that stopped moving shows it', () => {
    expect(picture.source).toContain('>Updated 10:29</text>')
    const { updated: _updated, ...rest } = { width: WIDTH, updated: '' }
    expect(dashboardSvg(boardView(LEDGER, NOW), rest).source).not.toContain('>Updated')
  })

  test('sizes the lane labels to the longest worker name, within bounds', () => {
    const firstRule = (source: string): number => Number(/<line x1="([\d.]+)"/.exec(source)?.[1])
    expect(firstRule(picture.source)).toBe(2 + 39)
    const long = draw(withTask('t391-1', { worker: 'worker-with-a-long-name' }))
    expect(firstRule(long.source)).toBe(2 + 56)
  })

  test('says what each row needs: the worker, the time, the task and its tier', () => {
    for (const piece of ['>w391<', 'Pool exhaustion answers 503', '>12 min<', 't391-1 · sonnet · writing the middleware test', '>1 h 05<', '>2 h 30 in<', '>t392-1 haiku<', '>then<', '>PR</tspan>', '>548</tspan>', '>ready<', '>1 ready · 1 in review<']) {
      expect(picture.source, piece).toContain(piece)
    }
  })

  test('keeps everything inside its width, at pane widths from narrow to wide', () => {
    for (const width of [260, 320, 400, 560]) {
      const { source } = draw(LEDGER, width)
      for (const x of numbers(source, / (?:x|x1|x2|cx)="(-?[\d.]+)"/g)) {
        expect(x, `x at ${width}`).toBeGreaterThanOrEqual(0)
        expect(x, `x at ${width}`).toBeLessThanOrEqual(width)
      }
      for (const found of source.matchAll(/<(?:rect|svg) x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)) {
        expect(Number(found[1]) + Number(found[2]), `box at ${width}`).toBeLessThanOrEqual(width + 0.5)
      }
    }
  })

  test('cuts a title that is too long and escapes what a title must not inject', () => {
    const long = draw(withTask('t391-1', { title: `<script>alert("x")</script> & ${'very long '.repeat(30)}` }))
    expect(long.source).not.toContain('<script>')
    expect(long.source).toContain('&lt;script&gt;alert(&quot;x&quot;)')
    expect(long.source).toContain('…')
    const hostile: Ledger = { ...LEDGER, run: { ...LEDGER.run, title: 'A & B <b> "c"' } }
    expect(draw(hostile).source).toContain('aria-label="A &amp; B &lt;b&gt; &quot;c&quot;:')
  })

  test('gives a long source at most two fifths of the title line, so the title stays', () => {
    const spec: Ledger = { ...LEDGER, run: { ...LEDGER.run, source: 'docs/superpowers/specs/2026-10-01-ai-cost.md' } }
    for (const width of [260, 400]) {
      const { source } = draw(spec, width)
      expect(source, `title at ${width}`).toContain('>Nightly import')
      expect(source, `source at ${width}`).toContain('ai-cost.md<')
      expect(source).not.toContain('>docs/superpowers')
    }
  })

  test('leaves out a section that has nothing in it', () => {
    const calm: Ledger = { ...LEDGER, problems: [], tasks: LEDGER.tasks.filter(task => task.status === 'done') }
    const { source } = draw(calm)
    for (const piece of ['>Problems<', '>Needs a decision<', '>Now<', '>Up next<', '>To merge<']) {
      expect(source, piece).not.toContain(piece)
    }
    expect(source).toContain('>of 2 done<')
  })

  test('lists a section up to its limit and says how many more there are', () => {
    const problems: Problem[] = Array.from({ length: 11 }, (_, at) => ({
      id: `P${at + 1}`,
      text: `Problem number ${at + 1}`,
      severity: 'warning',
      status: 'open',
    }))
    const { source } = draw({ ...LEDGER, problems })
    expect(count(source, '>Problem number ')).toBe(ROWS_SHOWN)
    expect(source).toContain(`>and ${11 - ROWS_SHOWN} more open<`)
  })

  test('stays far under the size a picture may have, for a run of sixty tasks', () => {
    const tasks: Task[] = Array.from({ length: 60 }, (_, at) => ({
      id: `t${at}`,
      title: `Task number ${at} with a title of ordinary length`,
      tier: 'sonnet',
      status: (['building', 'queued', 'review', 'green', 'done', 'blocked'] as const)[at % 6]!,
      worker: `worker-${at}`,
      startedAt: '2026-10-09T08:30:00Z',
    }))
    const big = draw({ ...LEDGER, tasks, problems: [] })
    expect(big.source.length).toBeLessThan(131072 / 2)
    expect(big.source).toContain('earlier workers<')
  })

  test('carries the light palette for a light scheme, and only when it follows the scheme', () => {
    expect(draw(LEDGER, WIDTH, 'auto').source).toContain('@media (prefers-color-scheme: light)')
    expect(draw(LEDGER, WIDTH, 'dark').source).not.toContain('<style>')
    expect(draw(LEDGER, WIDTH, 'light').source).toContain('fill="#1F1E1D"')
    expect(draw(LEDGER, WIDTH, 'auto').source).toContain('fill="#ECE9E2"')
  })
})

test('dashboard shows worker kind after every displayed tier, including queued tasks waiting on a dependency', () => {
  for (const status of ['blocked', 'failed', 'building', 'returned', 'queued'] as const) {
    for (const kindWhy of ['spread', 'trial'] as const) {
      const task: Task = { id: 'a', title: 'Build', tier: 'sonnet', status, kind: 'codex', kindWhy }
      const expected = `sonnet · codex${kindWhy === 'trial' ? ' · trial' : ''}`
      const ledger: Ledger = { ...LEDGER, tasks: [task], problems: [] }
      const source = draw(ledger, 560).source
      expect(source, `${status}, ${kindWhy}`).toContain(expected)
      if (kindWhy !== 'trial') expect(source).not.toContain(' · trial')
      if (status === 'queued') {
        const waiting = draw({ ...ledger, tasks: [{ ...task, dependsOn: ['gate'] }] }, 560).source
        expect(waiting, `waiting, ${kindWhy}`).toContain(expected)
      }
    }
  }
})

test('dashboard output for explicit Claude workers is identical to the default worker kind', () => {
  const explicit: Ledger = {
    ...LEDGER,
    tasks: LEDGER.tasks.map(task => ({ ...task, kind: 'claude', kindWhy: 'trial' })),
  }
  expect(draw(explicit)).toEqual(draw())
  expect(draw().source).not.toContain(' · codex')
})
