import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Flow, Task } from '../types'

const flow = atom({ plugin: 'aurora-progress', key: 'flow' } as const, null)
const clock = atom({ plugin: 'aurora-progress', key: 'clock' } as const, { frame: 0, at: 0 })
const isCollapsed = atom({ plugin: 'aurora-progress', key: 'isCollapsed' } as const, false)

const PROGRESS_TOOL = 'mcp__aurora-progress__progress'
const STEP_TOOL = 'mcp__aurora-progress__step'
const STEP_BRIEF = `

Progress reporting: before any other work, call \`${STEP_TOOL}\` with \`total\` (your plan in 3-6 steps) and \`done: 0\`; call it again with \`done\` and a few-word \`note\` as each step finishes. It only draws a progress bar.`

const FRAME_MS = 120
const MAX_TASKS = 50
const MAX_TITLE = 80

// Aurora gradient while running, a calmer green one once finished.
const RUN_STOPS = ['#8b5cf6', '#6366f1', '#38bdf8', '#2dd4bf']
const DONE_STOPS = ['#22c55e', '#4ade80', '#86efac']
const FAIL = '#f87171'
const TRACK = '#3f3f50'
const MUTED = '#8a8aa0'
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  tasks?: (string | { title?: string })[]
  finished?: boolean
}

// --- colour ----------------------------------------------------------------

const hex = (c: string): number[] => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
const toHex = (rgb: number[]): string =>
  '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
const mix = (a: string, b: string, t: number): string => {
  const x = hex(a)
  const y = hex(b)
  return toHex(x.map((v, i) => v + (y[i] - v) * t))
}
const gradient = (stops: string[], t: number): string => {
  const pos = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(pos))
  return mix(stops[i], stops[i + 1], pos - i)
}

// --- formatting ------------------------------------------------------------

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…')
const pad = (s: string, n: number): string => clip(s, n).padEnd(n)

const duration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const modelName = (model?: string): string =>
  (model ?? '').replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')

const norm = (s: string): string => s.trim().toLowerCase()

// --- flow state ------------------------------------------------------------

const doneOf = (f: Flow): number =>
  Math.min(f.total || Infinity, Math.max(f.done, f.tasks.filter(t => t.status === 'done').length))

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? doneOf(f) / f.total : 0)

const titlesOf = (tasks: ProgressInput['tasks']): string[] | undefined =>
  tasks
    ?.map(t => (typeof t === 'string' ? t : (t?.title ?? '')).trim())
    .filter(Boolean)
    .slice(0, MAX_TASKS)
    .map(t => clip(t, MAX_TITLE))

function merge(prev: Flow | null, input: ProgressInput, at: number): Flow {
  const title = input.title?.trim() ? clip(input.title.trim(), MAX_TITLE) : undefined
  const isNew = !prev || prev.isFinished || prev.isAuto || (title !== undefined && title !== prev.title)
  const base: Flow = isNew
    ? { title: title ?? 'Working', total: 0, done: 0, tasks: [], startedAt: at, isFinished: false, isAuto: false }
    : prev

  // Keep what agents already reported for tasks that stay in the plan.
  const titles = titlesOf(input.tasks)
  const tasks = titles
    ? titles.map(t => base.tasks.find(o => norm(o.title) === norm(t)) ?? { title: t, status: 'planned' as const })
    : base.tasks
  const total = Math.max(0, Math.round(input.total ?? (titles ? tasks.length : base.total)))
  const isFinished = input.finished === true

  return {
    ...base,
    title: title ?? base.title,
    tasks,
    total,
    done: Math.max(0, Math.round(input.done ?? base.done)),
    isFinished,
    isAuto: false,
    endedAt: isFinished ? at : undefined,
  }
}

const isActive = (f: Flow | null): boolean => f !== null && !f.isFinished

// --- drawing ---------------------------------------------------------------

type Cell = { ch: string; color: string; bold?: boolean }

// A sleek line bar: ━ for filled cells, ╸ for a half cell, a moving glint while running.
function barCells(p: number, width: number, frame: number, stops: string[], isRunning: boolean): Cell[] {
  const halves = Math.round(Math.max(0, Math.min(1, p)) * width * 2)
  const full = Math.floor(halves / 2)
  const hasHalf = halves % 2 === 1
  const glint = isRunning && full > 0 ? frame % (full + 8) : -99
  const cells: Cell[] = []
  for (let i = 0; i < width; i++) {
    const color = gradient(stops, width > 1 ? i / (width - 1) : 0)
    if (i < full) {
      const d = Math.abs(i - glint)
      const shine = d === 0 ? 0.65 : d === 1 ? 0.35 : 0
      cells.push({ ch: '━', color: shine ? mix(color, '#ffffff', shine) : color })
    } else if (i === full && hasHalf) {
      cells.push({ ch: '╸', color })
    } else {
      cells.push({ ch: '━', color: TRACK })
    }
  }
  return cells
}

// Neighbouring cells of one colour become one Text, so a track is a single node.
function runs(cells: Cell[]): Cell[] {
  const out: Cell[] = []
  for (const c of cells) {
    const last = out[out.length - 1]
    if (last && last.color === c.color && last.bold === c.bold) last.ch += c.ch
    else out.push({ ...c })
  }
  return out
}

function taskIcon(t: Task, frame: number): Cell {
  switch (t.status) {
    case 'done':
      return { ch: '✔', color: DONE_STOPS[0] }
    case 'failed':
      return { ch: '✘', color: FAIL }
    case 'running':
      return { ch: SPINNER[frame % SPINNER.length], color: gradient(RUN_STOPS, (frame % 20) / 19) }
    default:
      return { ch: '○', color: TRACK }
  }
}

// --- the module ------------------------------------------------------------

// Module scope is fine: a reload starts it over and session.start restarts the ticker.
let ticker: { cancel: () => void } | null = null

async function now($: EngineInterface): Promise<number> {
  return $.clock.now()
}

// Animates only while something runs; stops itself when the flow settles.
function ensureTicker($: EngineInterface): void {
  if (ticker) return
  ticker = $.clock.every(FRAME_MS, () => {
    void (async () => {
      const f = await read($, flow)
      if (!isActive(f)) {
        ticker?.cancel()
        ticker = null
        return
      }
      const at = await $.clock.now()
      await update($, clock, c => ({ frame: c.frame + 1, at }))
    })()
  })
}

export const register: Register = on => {
  ticker = null

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'progress',
      description:
        'Draw progress for a multi-part task as a band above the prompt. Call it once with `title` and `tasks` ' +
        '(task titles equal to the Agent `description` you will delegate each part with, so their runs light up), ' +
        'then with `done` as parts finish, and once with `finished: true` at the end. Omitted fields keep their value.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the whole task.' },
          tasks: { type: 'array', items: { type: 'string' }, description: 'Part titles, in order.' },
          total: { type: 'integer', minimum: 0, description: 'Number of parts; defaults to the task count.' },
          done: { type: 'integer', minimum: 0, description: 'Parts finished so far.' },
          finished: { type: 'boolean', description: 'True once everything is done.' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'step',
      description:
        'For subagents: report progress on your own task. Call it first with `total` (3-6 steps) and `done: 0`, ' +
        'then with `done` and a few-word `note` as each step finishes. Silent; it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0 },
          total: { type: 'integer', minimum: 1 },
          note: { type: 'string' },
        },
        required: ['done'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'aurora', description: 'Aurora progress band: `clear` hides it, `toggle` folds the task rows' })
    if (isActive(await read($, flow))) ensureTicker($)
    return started
  })

  on('command.run', { command: 'aurora' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'clear') {
      await update($, flow, () => null)
      return { text: 'Aurora band cleared.' }
    }
    const folded = await update($, isCollapsed, v => !v)
    return { text: folded ? 'Task rows folded.' : 'Task rows shown.' }
  })

  // A new prompt sweeps away a band that already finished.
  on('prompt.submit', async ($, e, next) => {
    const f = await read($, flow)
    if (f?.isFinished) await update($, flow, () => null)
    return next(e)
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    if (e.agentId) return { result: 'ignored: only the main session reports overall progress' }
    const at = await now($)
    const f = await update($, flow, prev => merge(prev, e as unknown as ProgressInput, at))
    await update($, clock, c => ({ ...c, at }))
    if (isActive(f)) ensureTicker($)
    return { result: f ? `ok: ${doneOf(f)}/${f.total}${f.isFinished ? ' finished' : ''}` : 'ok' }
  })

  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    const input = e as unknown as { done?: number; total?: number; note?: string }
    await update($, flow, f =>
      f && {
        ...f,
        tasks: f.tasks.map(t => {
          if (t.agentId !== agentId) return t
          const total = Math.max(0, Math.round(input.total ?? t.stepTotal ?? 0))
          const done = Math.max(0, Math.round(input.done ?? t.stepDone ?? 0))
          return { ...t, stepTotal: total, stepDone: total ? Math.min(total, done) : done, note: input.note?.trim() || t.note }
        }),
      },
    )
    return { result: 'ok' }
  })

  // Every subagent shows up: on a planned task when its description matches, else as a task of its own.
  on('agent.spawn', async ($, e, next) => {
    const f0 = await read($, flow)
    const isPlanned = isActive(f0) && !!f0?.tasks.some(t => t.status === 'planned' && norm(t.title) === norm(e.description))
    const started = await next(isPlanned && !e.prompt.includes(STEP_TOOL) ? { ...e, prompt: e.prompt + STEP_BRIEF } : e)
    if (started.deny !== undefined) return started

    const at = await now($)
    const run: Partial<Task> = { status: 'running', agentId: started.agentId ?? e.tool_use_id, model: started.model, startedAt: at }
    await update($, flow, prev => {
      const f: Flow = isActive(prev)
        ? (prev as Flow)
        : { title: 'Subagents', total: 0, done: 0, tasks: [], startedAt: at, isFinished: false, isAuto: true }
      const idx = f.tasks.findIndex(t => t.status === 'planned' && norm(t.title) === norm(e.description))
      const tasks =
        idx >= 0
          ? f.tasks.map((t, i) => (i === idx ? { ...t, ...run } : t))
          : [...f.tasks, { title: clip(e.description || e.subagentType, MAX_TITLE), ...run } as Task].slice(-MAX_TASKS)
      return { ...f, tasks, total: f.isAuto ? tasks.length : Math.max(f.total, tasks.length) }
    })
    ensureTicker($)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await now($)
      await update($, flow, f => {
        if (!f) return f
        const tasks = f.tasks.map(t =>
          t.agentId === agentId && t.status === 'running'
            ? { ...t, status: e.reason === 'answer' ? ('done' as const) : ('failed' as const), endedAt: at, stepDone: t.stepTotal ?? t.stepDone }
            : t,
        )
        // A flow of its own closes when its last subagent returns.
        const isFinished = f.isAuto && tasks.every(t => t.status === 'done' || t.status === 'failed')
        return { ...f, tasks, isFinished: f.isFinished || isFinished, endedAt: isFinished ? at : f.endedAt }
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, flow)
    if (f === null || e.props.hasSurvey) return next(e)
    // Other mods' bands stack underneath instead of being replaced.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const { Box, Text, Button } = $.ui.resolve(e)
    const { frame, at } = await read($, clock)
    const folded = await read($, isCollapsed)
    const cols = Math.max(40, e.props.bodyColumns || 100)
    const isRunning = !f.isFinished
    const hasFailed = f.tasks.some(t => t.status === 'failed')
    const stops = f.isFinished ? DONE_STOPS : RUN_STOPS
    const done = doneOf(f)
    const percent = `${Math.round(ratio(f) * 100)}%`
    const elapsed = duration((f.endedAt ?? Math.max(at, f.startedAt)) - f.startedAt)

    const head: Cell = f.isFinished
      ? { ch: hasFailed ? '✘' : '✔', color: hasFailed ? FAIL : DONE_STOPS[0] }
      : { ch: SPINNER[frame % SPINNER.length], color: gradient(RUN_STOPS, (frame % 30) / 29) }
    const titleW = Math.min(28, Math.max(10, f.title.length))
    const stats = `${done}/${f.total}`
    const barW = Math.max(10, Math.min(48, cols - titleW - stats.length - percent.length - elapsed.length - 20))
    const bar = runs(barCells(ratio(f), barW, frame, stops, isRunning))

    const rowRoom = Math.max(0, Math.min(f.tasks.length, (e.props.maxRows || 8) - 2))
    const nameW = Math.min(34, Math.max(12, ...f.tasks.map(t => t.title.length)))
    const miniW = 10

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text>
            <Text color={head.color} bold>{head.ch} </Text>
            <Text bold>{pad(f.title, titleW)}</Text>
            <Text> </Text>
            {bar.map((c, i) => (
              <Text key={`b${i}`} color={c.color}>{c.ch}</Text>
            ))}
            <Text> </Text>
            <Text bold color={gradient(stops, ratio(f))}>{stats}</Text>
            <Text color={MUTED}> · {percent} · {elapsed}</Text>
          </Text>
          {f.tasks.length > 0 && (
            <Button key="aurora-fold" label={folded ? '▸' : '▾'} plain onPress={() => update($, isCollapsed, v => !v)} />
          )}
          <Button key="aurora-dismiss" label="✕" plain role="dismiss" onPress={() => update($, flow, () => null)} />
        </Box>
        {!folded &&
          f.tasks.slice(0, rowRoom).map((t, i) => {
            const icon = taskIcon(t, frame + i * 3)
            const hasSteps = t.status === 'running' && (t.stepTotal ?? 0) > 0
            const mini = hasSteps ? runs(barCells((t.stepDone ?? 0) / (t.stepTotal ?? 1), miniW, frame + i * 5, RUN_STOPS, true)) : []
            const time =
              t.startedAt !== undefined ? duration((t.endedAt ?? Math.max(at, t.startedAt)) - t.startedAt) : ''
            const meta = [modelName(t.model), time].filter(Boolean).join(' · ')
            return (
              <Text key={`t${i}`} wrap="truncate-end">
                <Text color={TRACK}>{i === Math.min(rowRoom, f.tasks.length) - 1 ? '  └ ' : '  ├ '}</Text>
                <Text color={icon.color} bold>{icon.ch} </Text>
                <Text color={t.status === 'planned' ? MUTED : undefined} dimColor={t.status === 'done'}>
                  {pad(t.title, nameW)}
                </Text>
                <Text> </Text>
                {mini.map((c, j) => (
                  <Text key={`m${j}`} color={c.color}>{c.ch}</Text>
                ))}
                {hasSteps && <Text color={MUTED}> {t.stepDone}/{t.stepTotal} </Text>}
                {t.status === 'running' && t.note && <Text italic color={MUTED}>{clip(t.note, 24)} </Text>}
                {meta && <Text color={MUTED}>{meta}</Text>}
                {t.status === 'planned' && <Text color={MUTED}>queued</Text>}
              </Text>
            )
          })}
        {!folded && f.tasks.length > rowRoom && <Text color={MUTED}>    … {f.tasks.length - rowRoom} more</Text>}
        {below}
      </Box>
    )
  })
}
