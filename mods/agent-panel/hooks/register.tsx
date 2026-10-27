import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Call, Check, FileEdit, Flow, Job, Main, Phase, PlannedTask, Run, RunStatus, Todo } from '../types'
import { buildTree, editCounts, toRelative, type TreeRow } from './tree'

const runs = atom({ plugin: 'agent-panel', key: 'runs' } as const, [])
const now = atom({ plugin: 'agent-panel', key: 'now' } as const, 0)
const flow = atom({ plugin: 'agent-panel', key: 'flow' } as const, null)
const openedFor = atom({ plugin: 'agent-panel', key: 'openedFor' } as const, '')
const calls = atom({ plugin: 'agent-panel', key: 'calls' } as const, [])
const jobs = atom({ plugin: 'agent-panel', key: 'jobs' } as const, [])
const todos = atom({ plugin: 'agent-panel', key: 'todos' } as const, [])
const todosAt = atom({ plugin: 'agent-panel', key: 'todosAt' } as const, 0)
const openCalls = atom({ plugin: 'agent-panel', key: 'openCalls' } as const, [])
const files = atom({ plugin: 'agent-panel', key: 'files' } as const, [])
const checks = atom({ plugin: 'agent-panel', key: 'checks' } as const, [])
const collapsed = atom({ plugin: 'agent-panel', key: 'collapsed' } as const, [])
const tree = atom({ plugin: 'agent-panel', key: 'tree' } as const, [])
const root = atom({ plugin: 'agent-panel', key: 'root' } as const, '')
const changed = atom({ plugin: 'agent-panel', key: 'changed' } as const, [])
const openDirs = atom({ plugin: 'agent-panel', key: 'openDirs' } as const, [])
const main = atom(
  { plugin: 'agent-panel', key: 'main' } as const,
  { isWorking: false, turnStartedAt: 0 } as Main,
)

const PANE = 'agent-panel'
const PROGRESS = 'mcp__agent-panel__progress'
const STEP = 'mcp__agent-panel__step'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
const RULE =
  '# Reporting progress\n' +
  'For any task with 3 or more steps, call the `progress` tool before starting: a short `title`, `total`, the ' +
  '`tasks` list and `done: 0`. Call it again with the new `done` count after each step, and once at the end ' +
  'with `finished: true`. Skip it only when you already keep a TodoWrite/TaskCreate list.'
const ACCENT = '#ff7800'
const GLYPH: Record<RunStatus, string> = { running: '●', done: '✓', failed: '✗' }
const COLOR: Record<RunStatus, string> = { running: ACCENT, done: 'green', failed: 'red' }
// Terminal colors: Claude's palette in mid tones, the same as prompt-deck's band.
const T = { clay: ACCENT, ok: '#8ff0a4', bad: '#f66151', info: '#99c1f1', warn: '#ffa348', heather: '#dc8add', muted: '#9a9996', line: '#4f4f4f' } as const
const MAX_TREE_ROWS = 150
// Colors follow the Kitty theme (~/.config/kitty/current-theme.conf): its background and ANSI palette.
const PANE_BG = '#1d1d20'
const short = (s: string, n: number): string => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
// One color per effort level (low → max), per model family, and per context load.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const EFFORT_COLOR = ['#8ff0a4', '#99c1f1', '#ffa348', '#dc8add', '#f66151'] as const
const effortLevel = (e?: string): number => EFFORTS.indexOf(String(e ?? '').toLowerCase() as (typeof EFFORTS)[number])
const effortColor = (e?: string): string => EFFORT_COLOR[effortLevel(e)] ?? T.muted
const effortDots = (e?: string): string => {
  const n = effortLevel(e) + 1
  return '●'.repeat(n) + '○'.repeat(EFFORTS.length - n)
}
const modelColor = (id: string): string =>
  /haiku/i.test(id) ? T.ok : /sonnet/i.test(id) ? T.info : /opus/i.test(id) ? T.clay : /fable/i.test(id) ? T.heather : T.muted
const loadColor = (pct: number): string => (pct >= 80 ? T.bad : pct >= 50 ? T.warn : T.ok)

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: Phase
  finished?: boolean
  tasks?: { title?: string; agent?: string; after?: number[] }[]
}

// ponytail: guessed from the model name, the engine gives no window per subagent.
const windowOf = (model: string): number => (/haiku/i.test(model) ? 200_000 : 1_000_000)

const contextOf = (u: ModelUsage): number =>
  u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

const modelName = (id: string): string => id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '?'

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const elapsed = (r: Run, at: number): number => (r.endedAt ?? Math.max(at, r.startedAt)) - r.startedAt

const bar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()


// The whole argument of a call, for its expanded card.
const detailOf = (e: Record<string, unknown>): string => {
  const key = ARG_KEYS.find(k => typeof e[k] === 'string' && (e[k] as string).trim())
  return (key ? String(e[key]) : '').trim().slice(0, 1500)
}

const ARG_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']

// One short line for a tool call: its name and the first argument that reads as text.
const describeCall = (e: Record<string, unknown>): string => {
  const tool = String(e.tool).replace(/^mcp__.*__/, '')
  const q = Array.isArray(e.questions) ? (e.questions[0] as { question?: string } | undefined)?.question : undefined
  if (q) return `${tool} ${q}`.slice(0, 140)
  const key = ARG_KEYS.find(k => typeof e[k] === 'string' && (e[k] as string).trim())
  const arg = key ? String(e[key]).replace(/\s+/g, ' ').trim() : ''
  return (arg ? `${tool} ${arg}` : tool).slice(0, 90)
}

// --- the main conversation: its tool calls, background tasks and task list.

const shortTool = (t: string): string => t.replace(/^mcp__.*__/, '')
const TASK_ID = /(?:ID|id)[:=]?\s+`?([A-Za-z0-9_-]{3,})/
// `/tmp/…/x.output`, or on Windows `C:\Users\…\x.output`.
const OUTPUT_PATH = /(?:written to|output file|output)[:\s]+([A-Za-z]:[\\/][^\s'"`]+|\/[^\s'"`]+)/i
const STOPPERS = ['TaskStop', 'KillShell', 'KillBash']

// A background task's end notification names its id and says how it ended.
export const settleJobs = (list: Job[], text: string, at: number): Job[] =>
  list.map(j => {
    if (j.status !== 'running' || !((j.taskId && text.includes(j.taskId)) || text.includes(j.id))) return j
    const how = /<status>\s*(\w+)/i.exec(text)?.[1] ?? (/\b(failed|error)\b/i.test(text) ? 'failed' : /\b(killed|stopped)\b/i.test(text) ? 'killed' : 'completed')
    const isBad = /fail|kill|error/i.test(how)
    return { ...j, status: isBad ? 'failed' : 'done', endedAt: at, note: /kill/i.test(how) ? 'stopped' : isBad ? 'failed' : undefined }
  })

// Brings the job list in line with the engine's list of tasks still in flight.
export const syncJobs = (list: Job[], tasks: { id: string; type: string; description: string; command?: string }[], at: number): Job[] => {
  const live = tasks.filter(t => t.type !== 'subagent')
  const known = (j: Job, t: { id: string }) => j.taskId === t.id || j.id === t.id
  const settled = list.map(j =>
    j.status === 'running' && !live.some(t => known(j, t)) ? { ...j, status: 'done' as const, endedAt: at } : j,
  )
  const added = live
    .filter(t => !list.some(j => known(j, t)))
    .map(t => ({
      id: t.id,
      taskId: t.id,
      kind: (t.type === 'shell' ? 'shell' : 'monitor') as Job['kind'],
      label: (t.description || t.command || t.type).replace(/\s+/g, ' ').trim().slice(0, 120),
      startedAt: at,
      status: 'running' as const,
    }))
  return [...settled, ...added].slice(-30)
}

const todoStatus = (s: unknown): Todo['status'] => (s === 'completed' || s === 'in_progress' ? s : 'pending')

// The model's own task list, read off its TodoWrite call.
export const readTodos = (input: Record<string, unknown>): Todo[] =>
  (Array.isArray(input.todos) ? input.todos : [])
    .map((t: Record<string, unknown>) => ({
      text: String(t.content ?? t.subject ?? '').trim(),
      now: String(t.activeForm ?? '').trim(),
      status: todoStatus(t.status),
    }))
    .filter(t => t.text)


const tokensOf = (u: ModelUsage): number => u.input_tokens + u.output_tokens + u.cache_creation_input_tokens

const EDITORS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const CHECK_CMD = /\b(pytest|vitest|jest|mocha|cargo (test|build|check)|go (test|build)|npm (run )?(test|build|lint)|pnpm (run )?(test|build)|yarn (test|build)|tsc|make( test| check)?|ruff|mypy)\b/
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

// What a tool printed: its text, or the string fields of its record (stdout, stderr).
export const outText = (r: { text?: string; result?: unknown }): string => {
  if (typeof r.text === 'string') return r.text
  if (typeof r.result === 'string') return r.result
  if (r.result && typeof r.result === 'object')
    return Object.values(r.result as Record<string, unknown>).filter((v): v is string => typeof v === 'string').join('\n')
  return ''
}

const firstLine = (s: string): string => (s.replace(ANSI, '').split('\n').map(l => l.trim()).find(Boolean) ?? '').slice(0, 140)

// `42 passed, 1 failed` and the first failing test, read off a test or build run's output.
export const readCheck = (command: string, out: string, isError: boolean): Pick<Check, 'isOk' | 'summary' | 'firstFailure'> => {
  const text = out.replace(ANSI, '')
  const n = (re: RegExp) => Number(re.exec(text)?.[1] ?? 0)
  const passed = n(/(\d+) passed/i)
  const failed = n(/(\d+) failed/i) + n(/(\d+) errors?\b/i)
  const parts = [passed ? `${passed} passed` : '', failed ? `${failed} failed` : ''].filter(Boolean)
  const firstFailure = /^(?:FAILED|FAIL|ERROR)\s+(\S+)/m.exec(text)?.[1]
  const isOk = !isError && failed === 0
  return { isOk, summary: parts.join(', ') || (isOk ? 'ok' : 'failed'), firstFailure }
}

// The last lines of a task's output; progress bars that redraw with \r keep only their last frame.
export const lastLines = (text: string): string[] =>
  text.replace(ANSI, '').split(/[\r\n]+/).map(l => l.trim()).filter(Boolean).slice(-4).map(l => l.slice(0, 160))

// Windows reads the whole file each poll (it has no tail), so a bigger output shows no tail rather than stall.
const MAX_READ_BYTES = 2_000_000
export const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p)

// The last lines a background task wrote.
async function tailOf($: EngineInterface, path: string): Promise<string[]> {
  if (/[\r\n]/.test(path)) return []
  if (isWindowsPath(path)) {
    const stat = await $.fs.stat(path).catch(() => null)
    if (!stat || stat.kind !== 'file' || stat.size > MAX_READ_BYTES) return []
    return lastLines(((await ($.fs.read(path) as Promise<string>).catch(() => '')) as string).slice(-3000))
  }
  if (!path.startsWith('/')) return []
  const r = await $.process.run(['tail', '-c', '3000', path]).catch(() => null)
  if (!r || r.exitCode !== 0) return []
  return lastLines(r.stdout)
}

// `git status --porcelain` lines -> changed paths; a rename keeps its new name.
export const parseChanged = (out: string): string[] =>
  out
    .split('\n')
    .filter(l => l.length > 3)
    .map(l => l.slice(3).split(' -> ').at(-1)!.replace(/^"|"$/g, ''))

// The project's files (git's tracked and untracked, not ignored) and the ones git sees changed.
// ponytail: none outside a git repo; the edited files still show.
async function refreshTree($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const git = (args: string[]) => $.process.run(['git', '--no-optional-locks', '-C', cwd, ...args]).catch(() => null)
  const r = await git(['ls-files', '--cached', '--others', '--exclude-standard'])
  const list = r && r.exitCode === 0 ? r.stdout.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 20_000) : []
  const st = await git(['status', '--porcelain', '--untracked-files=all'])
  await update($, root, () => cwd)
  await update($, tree, () => list)
  await update($, changed, () => (st && st.exitCode === 0 ? parseChanged(st.stdout).slice(0, 500) : []))
}

// The person's prompt as one short line: the task shown when Claude keeps no list.
export const promptLine = (text: string): string =>
  text.trimStart().startsWith('<') ? 'Handling a background task result' : text.replace(/\s+/g, ' ').trim().slice(0, 160)

// --- the flow: a multi-step task the main agent reports through `progress`.

const blank = (): Flow => ({ title: 'Task', total: 0, done: 0, phase: 'plan', isFinished: false, tasks: [] })

const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev || prev.isFinished || (input.title !== undefined && input.title.trim() !== prev.title)

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = prev && !isNewFlow(prev, input) ? prev : blank()
  const tasks: PlannedTask[] = input.tasks
    ? input.tasks
        .filter(t => t.title?.trim())
        .map(t => ({
          title: (t.title ?? '').trim(),
          agent: (t.agent ?? '').trim(),
          after: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0),
        }))
    : base.tasks
  const total = Math.max(0, Math.round(input.total ?? (input.tasks ? tasks.length : base.total)))
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? base.done)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    title: input.title?.trim() || base.title,
    total,
    done,
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    tasks,
  }
}

const label = (f: Flow, running: number): string => {
  if (f.isFinished) return 'Done'
  if (f.phase === 'plan') return 'Plan'
  if (f.phase === 'design') return 'Design'
  return `${f.phase === 'review' ? 'Review' : 'Tasks'} ${f.total ? `${f.done}/${f.total}` : `${running} running`}`
}

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// Tasks planned for a subagent that has not started yet (matched by the Agent description) and not done.
const plannedOf = (f: Flow | null, list: Run[]) => {
  if (!f || f.isFinished) return []
  const started = new Set(list.map(r => norm(r.description)))
  return f.tasks.map((t, i) => ({ ...t, n: i + 1 })).filter(t => t.agent && t.n > f.done && !started.has(norm(t.title)))
}

// The reported plan as a task list: the first `done` tasks finished, the next one in progress.
export const flowTodos = (f: Flow | null): Todo[] =>
  (f?.tasks ?? []).map((t, i) => ({
    text: t.title,
    now: '',
    status: f!.isFinished || i < f!.done ? 'completed' : i === f!.done ? 'in_progress' : 'pending',
  }))


// --- desktop cards. Each card is one SVG in Claude's own palette: flat color, warm neutrals, a clay accent.

type Drawn = { svg: string; alt: string }
type Palette = Record<'card' | 'line' | 'well' | 'text' | 'muted' | 'clay' | 'sky' | 'olive' | 'fig' | 'heather' | 'gold', string>

const SANS = "-apple-system,'SF Pro Text','Inter','Segoe UI',system-ui,sans-serif"
const SERIF = "'Tiempos Headline','Iowan Old Style',Georgia,'Times New Roman',serif"
const MONO = "'SF Mono',ui-monospace,Menlo,Consolas,monospace"
const DARK: Palette = {
  card: '#30302E', line: '#454540', well: '#3D3D3A', text: '#FAF9F5', muted: '#A6A39A',
  clay: '#E08A6B', sky: '#7FAEDB', olive: '#9DB27A', fig: '#D77D9A', heather: '#A9A3D6', gold: '#E0B060',
}
const LIGHT: Palette = {
  card: '#FAF9F5', line: '#E3DACC', well: '#EFEBE0', text: '#141413', muted: '#6B6A64',
  clay: '#C6613F', sky: '#4F7FB0', olive: '#5F7A45', fig: '#B04F73', heather: '#7C75B5', gold: '#A8741A',
}
// ponytail: set once per draw from the person's theme setting, so the builders below stay plain functions.
let P: Palette = DARK

const toneOf = (k: RunStatus | 'planned'): string =>
  k === 'running' ? P.clay : k === 'done' ? P.olive : k === 'failed' ? P.fig : P.muted
const hues = (): string[] => [P.clay, P.sky, P.olive, P.heather, P.gold, P.fig]

// 24x24 line icons, drawn white on a colored tile.
const ICON = {
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  list: '<path d="M4 7l2 2 3-3M4 16l2 2 3-3M13 8h7M13 17h7"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3.2 8.2-7 10-3.8-1.8-7-5-7-10V6z"/><path d="M9 12l2.2 2.2L15 10"/>',
  book: '<path d="M5 4h10a3 3 0 013 3v13H8a3 3 0 01-3-3z"/><path d="M5 17a3 3 0 013-3h10"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17v4M17 19h4"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 1.5"/>',
  terminal: '<path d="M4 6l6 6-6 6M12 18h8"/>',
}
type IconName = keyof typeof ICON

const iconOf = (type: string): IconName =>
  /explore|search/i.test(type) ? 'search'
  : /plan|architect/i.test(type) ? 'list'
  : /review|security|hunter|analy/i.test(type) ? 'shield'
  : /guide|doc|comment/i.test(type) ? 'book'
  : 'spark'

const hueOf = (s: string): string => hues()[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 6]!

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Text is cut by an estimated width: the SVG cannot measure it.
const fit = (s: string, px: number, size: number): string => {
  const max = Math.max(4, Math.floor(px / (size * 0.58)))
  return esc(s.length > max ? s.slice(0, max - 1) + '…' : s)
}

const glyph = (name: IconName, x: number, y: number, size: number, color = '#fff'): string =>
  `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</g>`

const meter = (x: number, y: number, w: number, h: number, pct: number, fill: string): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${P.well}"/>` +
  (pct > 0 ? `<rect x="${x}" y="${y}" width="${Math.max(h, (w * pct) / 100)}" height="${h}" rx="${h / 2}" fill="${fill}"/>` : '')

// Pills laid left to right; the ones that do not fit are dropped.
const chips = (items: (readonly [string, string])[], x: number, y: number, maxX: number): string => {
  let at = x
  let out = ''
  for (const [text, color] of items) {
    const w = Math.round(text.length * 6.3 + 20)
    if (at + w > maxX) break
    out +=
      `<rect x="${at}" y="${y}" width="${w}" height="20" rx="10" fill="${color}" fill-opacity="0.18"/>` +
      `<text x="${at + 10}" y="${y + 14}" font-size="11" font-weight="600" fill="${color}">${esc(text)}</text>`
    at += w + 6
  }
  return out
}

const doc = (W: number, H: number, body: string, alt: string): Drawn => ({
  svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${SANS}">${body}</svg>`,
  alt,
})

const ground = (W: number, H: number, dashed = false): string =>
  `<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="14" fill="${P.card}" stroke="${P.line}" stroke-width="1.5"${dashed ? ' stroke-dasharray="5 5"' : ''}/>`

const runCard = (r: Run, at: number, W: number): Drawn => {
  const tone = toneOf(r.status)
  const ctx = r.contextMax ? Math.min(100, Math.round((r.contextTokens / r.contextMax) * 100)) : 0
  const prog =
    r.status === 'done' ? 100 : r.stepTotal ? Math.min(100, Math.round(((r.stepDone ?? 0) / r.stepTotal) * 100)) : null
  const title = r.description || r.type
  const steps = r.stepTotal ? `${r.stepDone ?? 0}/${r.stepTotal}` : ''
  const lineA =
    r.status === 'running' ? [steps, r.stepNote].filter(Boolean).join(' · ') || 'Working…'
    : r.status === 'done' ? 'Finished'
    : 'Stopped'
  const lineB = r.activity ? `${r.status === 'running' ? '›' : 'last'} ${r.activity}` : ''
  const label = r.status === 'running' ? 'Running' : r.status === 'done' ? 'Done' : 'Failed'
  const time = fmtTime(elapsed(r, at))
  const H = 158
  const barW = W - 32 - 44
  const main = prog ?? ctx

  const body =
    ground(W, H) +
    `<rect x="16" y="16" width="40" height="40" rx="12" fill="${hueOf(r.type)}"/>` +
    glyph(iconOf(r.type), 24, 24, 24) +
    `<text x="68" y="33" font-family="${SERIF}" font-size="16" font-weight="600" fill="${P.text}">${fit(title, W - 68 - 16 - 84, 16)}</text>` +
    `<text x="68" y="51" font-size="11.5" fill="${P.muted}">${fit(`${r.type} · ${modelName(r.model)}`, W - 68 - 16 - 84, 11.5)}</text>` +
    // status pill
    `<rect x="${W - 92}" y="16" width="76" height="22" rx="11" fill="${tone}" fill-opacity="0.18"/>` +
    `<circle cx="${W - 79}" cy="27" r="3.5" fill="${tone}"/>` +
    `<text x="${W - 69}" y="31" font-size="11" font-weight="700" fill="${tone}">${label}</text>` +
    // what it is doing now
    `<text x="16" y="79" font-size="13" font-weight="600" fill="${P.text}">${fit(lineA, W - 32, 13)}</text>` +
    (lineB ? `<text x="16" y="97" font-size="11" font-family="${MONO}" fill="${P.muted}">${fit(lineB, W - 32, 11)}</text>` : '') +
    // progress: the task's own steps; the thin bar under it is the context
    meter(16, 108, barW, 8, main, tone) +
    `<text x="${W - 16}" y="116" font-size="12" font-weight="700" text-anchor="end" fill="${P.text}">${main}%</text>` +
    (prog === null ? '' : meter(16, 122, barW, 3, ctx, P.sky)) +
    chips(
      [
        ...(r.effort ? [[`Thinking ${r.effort}`, P.heather] as const] : []),
        [`ctx ${ctx}% · ${fmtTokens(r.contextTokens)}`, P.sky],
        [`${r.requests} req`, P.gold],
        ...(r.tokens ? [[`${fmtTokens(r.tokens)} tok`, P.muted] as const] : []),
        [time, P.olive],
      ],
      16,
      131,
      W - 16,
    )
  const alt =
    `${label}: ${title}. ${r.type}, ${modelName(r.model)}${r.effort ? `, thinking ${r.effort}` : ''}. ` +
    `${lineA}. ${lineB ? lineB + '. ' : ''}${prog === null ? 'Context' : 'Progress'} ${main}%. ${time}.`
  return doc(W, H, body, alt)
}

const plannedCard = (p: PlannedTask & { n: number }, W: number): Drawn => {
  const sub = [p.agent, p.after.length ? `after ${p.after.join(', ')}` : ''].filter(Boolean).join(' · ') || 'waiting to start'
  const body =
    ground(W, 64, true) +
    `<rect x="16" y="12" width="40" height="40" rx="12" fill="${P.well}"/>` +
    glyph('clock', 24, 20, 24, P.muted) +
    `<text x="68" y="29" font-size="11" font-family="${MONO}" fill="${P.muted}">Task ${p.n}</text>` +
    `<text x="68" y="46" font-family="${SERIF}" font-size="14" font-weight="600" fill="${P.text}">${fit(p.title, W - 68 - 16, 14)}</text>` +
    `<text x="${W - 16}" y="29" font-size="11" text-anchor="end" fill="${P.muted}">${fit(sub, W / 2 - 40, 11)}</text>`
  return doc(W, 64, body, `Planned task ${p.n}: ${p.title}. ${sub}.`)
}

const durationOf = (startedAt: number, endedAt: number | undefined, at: number): string => fmtTime((endedAt ?? Math.max(at, startedAt)) - startedAt)

// A tool call that is running now: one line, or the whole command when opened.
const callCard = (c: Call, isOpen: boolean, at: number, W: number): Drawn => {
  const icon: IconName = /^(Bash|Monitor)$/.test(c.tool) ? 'terminal' : /^(Read|Grep|Glob|WebFetch|WebSearch)$/.test(c.tool) ? 'search' : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.tool) ? 'list' : 'spark'
  const arg = c.summary.slice(c.tool.length).trim()
  const time = durationOf(c.startedAt, undefined, at)
  const shown = isOpen
    ? (c.detail ?? arg).split('\n').flatMap(l => wrapText(l, W - 32, 11, 8)).slice(0, 10)
    : []
  const H = isOpen && shown.length ? 64 + 16 + shown.length * 15 + 8 : 64
  let body =
    ground(W, H) +
    `<rect x="16" y="12" width="40" height="40" rx="12" fill="${P.clay}"/>` +
    glyph(icon, 24, 20, 24) +
    `<text x="68" y="31" font-family="${SERIF}" font-size="14" font-weight="600" fill="${P.text}">${esc(c.tool)}</text>` +
    `<text x="68" y="48" font-size="11" font-family="${MONO}" fill="${P.muted}">${fit(arg || c.tool, W - 68 - 16 - 84, 11)}</text>` +
    `<rect x="${W - 92}" y="14" width="76" height="22" rx="11" fill="${P.clay}" fill-opacity="0.18"/>` +
    `<circle cx="${W - 79}" cy="25" r="3.5" fill="${P.clay}"/>` +
    `<text x="${W - 69}" y="29" font-size="11" font-weight="700" fill="${P.clay}">${time}</text>`
  if (isOpen && shown.length) {
    body +=
      `<rect x="16" y="64" width="${W - 32}" height="${shown.length * 15 + 12}" rx="8" fill="${P.well}"/>` +
      shown.map((l, i) => `<text x="24" y="${82 + i * 15}" font-size="11" font-family="${MONO}" fill="${P.text}" xml:space="preserve">${esc(l)}</text>`).join('')
  }
  return doc(W, H, body, `Running ${c.tool} for ${time}: ${c.detail ?? arg}`)
}

// Break a line at spaces to fit a width; cut it with an ellipsis past maxLines.
const wrapText = (s: string, px: number, size: number, maxLines: number): string[] => {
  const per = Math.max(10, Math.floor(px / (size * 0.62)))
  const out: string[] = []
  let line = ''
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= per) line = next
    else {
      if (line) out.push(line)
      line = word.length > per ? word.slice(0, per) : word
    }
  }
  if (line) out.push(line)
  return out.length > maxLines ? [...out.slice(0, maxLines - 1), out[maxLines - 1]!.slice(0, per - 1) + '…'] : out.length ? out : ['']
}

const todoCard = (list: Todo[], W: number): Drawn => {
  const done = list.filter(t => t.status === 'completed').length
  const shown = list.slice(0, 10)
  const H = 66 + shown.length * 24 + (list.length > shown.length ? 22 : 0)
  const pct = list.length ? Math.round((done / list.length) * 100) : 0
  let body =
    ground(W, H) +
    `<circle cx="22" cy="26" r="4" fill="${P.clay}"/>` +
    `<text x="34" y="31" font-family="${SERIF}" font-size="16" font-weight="600" fill="${P.text}">Task list</text>` +
    `<text x="${W - 16}" y="31" font-size="12" font-weight="700" text-anchor="end" fill="${P.text}">${done}/${list.length}</text>` +
    meter(16, 42, W - 32, 6, pct, P.clay)
  shown.forEach((t, i) => {
    const y = 76 + i * 24
    const isNow = t.status === 'in_progress'
    body +=
      t.status === 'completed'
        ? `<circle cx="26" cy="${y - 4}" r="7" fill="${P.olive}"/><path d="M22.5 ${y - 4}l2.5 2.5 4.5-5" fill="none" stroke="${P.card}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
        : isNow
          ? `<circle cx="26" cy="${y - 4}" r="7" fill="none" stroke="${P.clay}" stroke-width="2"/><circle cx="26" cy="${y - 4}" r="3" fill="${P.clay}"/>`
          : `<circle cx="26" cy="${y - 4}" r="7" fill="none" stroke="${P.line}" stroke-width="2"/>`
    body += `<text x="44" y="${y}" font-size="13" font-weight="${isNow ? 700 : 500}" fill="${t.status === 'completed' ? P.muted : P.text}"${t.status === 'completed' ? ' text-decoration="line-through"' : ''}>${fit(isNow && t.now ? t.now : t.text, W - 44 - 16, 13)}</text>`
  })
  if (list.length > shown.length) body += `<text x="44" y="${H - 12}" font-size="11.5" fill="${P.muted}">+${list.length - shown.length} more</text>`
  const alt = `Task list: ${done} of ${list.length} done. ${list.map(t => `${t.status} ${t.text}`).join('; ')}.`
  return doc(W, H, body, alt)
}

const jobCard = (j: Job, at: number, W: number): Drawn => {
  const tone = toneOf(j.status)
  const label = j.status === 'running' ? 'Running' : j.status === 'done' ? 'Done' : 'Failed'
  const time = durationOf(j.startedAt, j.endedAt, at)
  const sub = `${j.kind === 'monitor' ? 'monitor' : 'background shell'} · ${time}${j.note ? ` · ${j.note}` : ''}`
  const tail = j.tail ?? []
  const H = tail.length ? 64 + 14 + tail.length * 15 + 6 : 64
  const body =
    ground(W, H) +
    `<rect x="16" y="12" width="40" height="40" rx="12" fill="${tone}"/>` +
    glyph('terminal', 24, 20, 24) +
    `<text x="68" y="31" font-family="${SERIF}" font-size="14" font-weight="600" fill="${P.text}">${fit(j.label, W - 68 - 16 - 84, 14)}</text>` +
    `<text x="68" y="48" font-size="11" fill="${P.muted}">${fit(sub, W - 68 - 16, 11)}</text>` +
    `<rect x="${W - 92}" y="14" width="76" height="22" rx="11" fill="${tone}" fill-opacity="0.18"/>` +
    `<circle cx="${W - 79}" cy="25" r="3.5" fill="${tone}"/>` +
    `<text x="${W - 69}" y="29" font-size="11" font-weight="700" fill="${tone}">${label}</text>` +
    (tail.length
      ? `<rect x="16" y="64" width="${W - 32}" height="${tail.length * 15 + 8}" rx="8" fill="${P.well}"/>` +
        tail.map((l, i) => `<text x="24" y="${79 + i * 15}" font-size="10.5" font-family="${MONO}" fill="${i === tail.length - 1 ? P.text : P.muted}">${fit(l, W - 48, 10.5)}</text>`).join('')
      : '')
  return doc(W, H, body, `${label} background task: ${j.label}. ${sub}.${tail.length ? ` Latest output: ${tail[tail.length - 1]}` : ''}`)
}

const agoOf = (ms: number): string => (ms < 60_000 ? 'now' : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m ago` : `${Math.round(ms / 3_600_000)}h ago`)

type Need = { kind: 'question' | 'failure' | 'review'; text: string }

const needsCard = (items: Need[], W: number): Drawn => {
  const H = 52 + items.length * 26
  const color = (k: Need['kind']) => (k === 'question' ? P.gold : k === 'failure' ? P.fig : P.heather)
  const name = (k: Need['kind']) => (k === 'question' ? 'asking you' : k === 'failure' ? 'failed' : 'to review')
  const body =
    ground(W, H) +
    `<circle cx="22" cy="26" r="4" fill="${P.fig}"/>` +
    `<text x="34" y="31" font-family="${SERIF}" font-size="16" font-weight="600" fill="${P.text}">Needs you</text>` +
    `<text x="${W - 16}" y="31" font-size="12" font-weight="700" text-anchor="end" fill="${P.fig}">${items.length}</text>` +
    items
      .map((n, i) => {
        const y = 60 + i * 26
        return (
          `<circle cx="22" cy="${y - 4}" r="3.5" fill="${color(n.kind)}"/>` +
          `<text x="34" y="${y}" font-size="12.5" fill="${P.text}">${fit(n.text, W - 34 - 96, 12.5)}</text>` +
          `<text x="${W - 16}" y="${y}" font-size="11" font-weight="600" text-anchor="end" fill="${color(n.kind)}">${name(n.kind)}</text>`
        )
      })
      .join('')
  return doc(W, H, body, `Needs you: ${items.map(n => `${name(n.kind)}: ${n.text}`).join('; ')}.`)
}

// The Files section: the project tree with the file being edited lit, or only the files this run changed.
const treeCard = (rows: TreeRow[], rootName: string, sub: string, W: number): Drawn => {
  const shown = rows.slice(0, 40)
  const H = 70 + shown.length * 18 + (rows.length > shown.length ? 18 : 0)
  let body =
    ground(W, H) +
    `<circle cx="22" cy="26" r="4" fill="${P.sky}"/>` +
    `<text x="34" y="31" font-family="${SERIF}" font-size="16" font-weight="600" fill="${P.text}">Files</text>` +
    `<text x="${W - 16}" y="31" font-size="12" text-anchor="end" fill="${P.muted}">${fit(sub, W / 2, 12)}</text>` +
    `<text x="16" y="56" font-size="12" font-weight="700" font-family="${MONO}" fill="${P.sky}">▾ ${fit(rootName, W - 32, 12)}</text>`
  shown.forEach((r, i) => {
    const y = 76 + i * 18
    const x = 16 + (r.depth + 1) * 14
    const room = W - x - 90
    if (r.more !== undefined) body += `<text x="${x}" y="${y}" font-size="11.5" font-family="${MONO}" fill="${P.muted}">… ${r.more} more</text>`
    else if (r.isDir) body += `<text x="${x}" y="${y}" font-size="11.5" font-family="${MONO}" fill="${P.sky}">${r.isOpen ? '▾' : '▸'} ${fit(r.name + '/', room, 11.5)}</text>`
    else if (r.touch?.isEditing)
      body +=
        `<text x="${x}" y="${y}" font-size="11.5" font-weight="700" font-family="${MONO}" fill="${P.clay}">● ${fit(r.name, room, 11.5)}</text>` +
        `<rect x="${W - 82}" y="${y - 12}" width="66" height="16" rx="8" fill="${P.clay}" fill-opacity="0.18"/>` +
        `<text x="${W - 49}" y="${y}" font-size="10.5" font-weight="700" text-anchor="middle" fill="${P.clay}">editing</text>`
    else if (r.touch)
      body +=
        `<text x="${x}" y="${y}" font-size="11.5" font-weight="600" font-family="${MONO}" fill="${P.olive}">✎ ${fit(r.name, room, 11.5)}</text>` +
        `<text x="${W - 16}" y="${y}" font-size="11" font-weight="700" text-anchor="end" font-family="${MONO}"><tspan fill="${P.olive}">+${r.touch.added}</tspan> <tspan fill="${P.fig}">−${r.touch.removed}</tspan></text>`
    else if (r.isChanged) body += `<text x="${x}" y="${y}" font-size="11.5" font-family="${MONO}" fill="${P.heather}">• ${fit(r.name, room, 11.5)}</text>`
    else body += `<text x="${x + 11}" y="${y}" font-size="11.5" font-family="${MONO}" fill="${P.muted}">${fit(r.name, room, 11.5)}</text>`
  })
  if (rows.length > shown.length) body += `<text x="16" y="${H - 10}" font-size="11.5" fill="${P.muted}">+${rows.length - shown.length} more rows</text>`
  const touched = shown.filter(r => r.touch)
  return doc(W, H, body, `Files: ${sub}.${touched.length ? ' ' + touched.map(r => `${r.path}${r.touch!.isEditing ? ' editing' : ` +${r.touch!.added} −${r.touch!.removed}`}`).join('; ') + '.' : ''}`)
}

type AsmItem = { id: number; text: string; status: string }

const assumptionsCard = (items: AsmItem[], W: number): Drawn => {
  const open = items.filter(a => a.status === 'open')
  const shown = open.slice(-5).reverse()
  const n = (st: string) => items.filter(a => a.status === st).length
  const H = 82 + Math.max(1, shown.length) * 24 + (open.length > shown.length ? 18 : 0)
  let body =
    ground(W, H) +
    `<circle cx="22" cy="26" r="4" fill="${P.gold}"/>` +
    `<text x="34" y="31" font-family="${SERIF}" font-size="16" font-weight="600" fill="${P.text}">Assumptions</text>` +
    `<text x="${W - 16}" y="31" font-size="12" font-weight="700" text-anchor="end" fill="${open.length ? P.gold : P.muted}">${open.length} to review</text>` +
    chips([[`${n('right')} right`, P.olive], [`${n('wrong')} wrong`, P.fig], [`${n('changed')} changed`, P.sky]], 16, 42, W - 16)
  if (shown.length === 0) body += `<text x="16" y="90" font-size="12" fill="${P.muted}">${items.length ? 'All reviewed.' : 'None logged yet.'}</text>`
  shown.forEach((a, i) => {
    const y = 90 + i * 24
    body +=
      `<circle cx="22" cy="${y - 4}" r="3.5" fill="${P.gold}"/>` +
      `<text x="34" y="${y}" font-size="11" font-weight="800" fill="${P.gold}">A${a.id}</text>` +
      `<text x="66" y="${y}" font-size="12.5" fill="${P.text}">${fit(a.text, W - 66 - 16, 12.5)}</text>`
  })
  if (open.length > shown.length) body += `<text x="34" y="${H - 10}" font-size="11.5" fill="${P.muted}">+${open.length - shown.length} more</text>`
  return doc(W, H, body, `Assumptions: ${open.length} to review. ${shown.map(a => `A${a.id} ${a.text}`).join('; ')}`)
}

const checksCard = (list: Check[], at: number, W: number): Drawn => {
  const shown = [...list].reverse().slice(0, 5)
  const rowH = (c: Check) => (c.firstFailure ? 42 : 26)
  const H = 48 + shown.reduce((a, c) => a + rowH(c), 0) + 6
  let y = 62
  let body =
    ground(W, H) +
    `<circle cx="22" cy="26" r="4" fill="${shown[0]?.isOk === false ? P.fig : P.olive}"/>` +
    `<text x="34" y="31" font-family="${SERIF}" font-size="16" font-weight="600" fill="${P.text}">Tests &amp; builds</text>`
  shown.forEach(c => {
    const color = c.isOk ? P.olive : P.fig
    body +=
      `<circle cx="22" cy="${y - 4}" r="3.5" fill="${color}"/>` +
      `<text x="34" y="${y}" font-size="11.5" font-family="${MONO}" fill="${P.text}">${fit(c.command, W - 34 - 150, 11.5)}</text>` +
      `<text x="${W - 16}" y="${y}" font-size="11.5" font-weight="700" text-anchor="end" fill="${color}">${esc(c.summary)} · ${agoOf(at - c.at)}</text>`
    if (c.firstFailure) body += `<text x="34" y="${y + 16}" font-size="11" fill="${P.muted}">✗ ${fit(c.firstFailure, W - 34 - 16, 11)}</text>`
    y += rowH(c)
  })
  return doc(W, H, body, `Tests and builds: ${shown.map(c => `${c.command} ${c.isOk ? 'passed' : 'failed'}, ${c.summary}`).join('; ')}.`)
}

type Bar = { label: string; start: number; end?: number; status: RunStatus }

const timelineCard = (bars: Bar[], at: number, W: number): Drawn => {
  const shown = bars.slice(-8)
  const t0 = Math.min(...shown.map(b => b.start))
  const t1 = Math.max(at, ...shown.map(b => b.end ?? 0), t0 + 1000)
  const x0 = 136
  const w = W - 16 - x0
  const H = 48 + shown.length * 22 + 22
  const body =
    ground(W, H) +
    `<circle cx="22" cy="26" r="4" fill="${P.heather}"/>` +
    `<text x="34" y="31" font-family="${SERIF}" font-size="16" font-weight="600" fill="${P.text}">Timeline</text>` +
    shown
      .map((b, i) => {
        const y = 60 + i * 22
        const bx = x0 + ((b.start - t0) / (t1 - t0)) * w
        const bw = Math.max(5, (((b.end ?? t1) - b.start) / (t1 - t0)) * w)
        return (
          `<text x="16" y="${y + 4}" font-size="11.5" fill="${P.text}">${fit(b.label, x0 - 24, 11.5)}</text>` +
          `<rect x="${x0}" y="${y - 6}" width="${w}" height="12" rx="6" fill="${P.well}"/>` +
          `<rect x="${bx}" y="${y - 6}" width="${bw}" height="12" rx="6" fill="${toneOf(b.status)}"/>`
        )
      })
      .join('') +
    `<text x="${x0}" y="${H - 8}" font-size="10.5" fill="${P.muted}">0:00</text>` +
    `<text x="${W - 16}" y="${H - 8}" font-size="10.5" text-anchor="end" fill="${P.muted}">${fmtTime(t1 - t0)}</text>`
  return doc(W, H, body, `Timeline over ${fmtTime(t1 - t0)}: ${shown.map(b => `${b.label} ${b.status}`).join('; ')}.`)
}

const headCard = (f: Flow | null, list: Run[], planned: number, W: number, bg = 0, cost?: number, isBusy = false): Drawn => {
  const count = (s: RunStatus) => list.filter(r => r.status === s).length
  const running = count('running')
  const counts = [
    [`${running} running`, P.clay],
    ...(bg ? [[`${bg} background`, P.sky] as const] : []),
    [`${count('done')} done`, P.olive],
    [`${count('failed')} failed`, P.fig],
    [`${planned} planned`, P.muted],
    ...(cost !== undefined ? [[`$${cost.toFixed(2)} session`, P.heather] as const] : []),
  ] as const
  const pct = f ? Math.round(ratio(f) * 100) : 0
  const H = f ? 150 : 96
  const chipY = f ? 120 : 64
  const step = f ? PHASES.indexOf(f.phase) : -1
  const x = (i: number) => 28 + (i * (W - 56)) / (PHASES.length - 1)
  const phase = f ? (f.isFinished ? 'Finished' : f.phase[0]!.toUpperCase() + f.phase.slice(1)) : ''

  const stepper = f
    ? `<line x1="${x(0)}" y1="92" x2="${x(4)}" y2="92" stroke="${P.well}" stroke-width="2"/>` +
      `<line x1="${x(0)}" y1="92" x2="${x(Math.max(0, step))}" y2="92" stroke="${P.clay}" stroke-width="2"/>` +
      PHASES.map((ph, i) => {
        const on = i <= step
        const here = i === step && !f.isFinished
        return (
          (here ? `<circle cx="${x(i)}" cy="92" r="9" fill="${P.clay}" fill-opacity="0.25"/>` : '') +
          `<circle cx="${x(i)}" cy="92" r="${here ? 5.5 : 4}" fill="${on ? P.clay : P.well}"/>` +
          `<text x="${x(i)}" y="110" font-size="10.5" font-weight="${here ? 700 : 500}" text-anchor="middle" fill="${on ? P.text : P.muted}">${ph[0]!.toUpperCase() + ph.slice(1)}</text>`
        )
      }).join('')
    : ''
  const body =
    ground(W, H) +
    `<text x="16" y="36" font-family="${SERIF}" font-size="20" font-weight="600" fill="${P.text}">${fit(f ? f.title : 'Activity', W - 32 - 100, 20)}</text>` +
    (f
      ? `<text x="16" y="53" font-size="12" fill="${P.muted}">${esc(label(f, running))}</text>` +
        `<rect x="${W - 96}" y="16" width="80" height="24" rx="12" fill="${P.clay}" fill-opacity="0.18"/>` +
        `<text x="${W - 56}" y="32" font-size="11.5" font-weight="700" text-anchor="middle" fill="${P.clay}">${phase}</text>` +
        meter(16, 66, W - 32 - 48, 10, pct, P.clay) +
        `<text x="${W - 16}" y="76" font-size="14" font-weight="700" text-anchor="end" fill="${P.text}">${pct}%</text>` +
        stepper
      : `<text x="16" y="53" font-size="12" fill="${P.muted}">${running + bg || isBusy ? 'Working on it' : 'Nothing running'}</text>`) +
    chips(counts.map(([t, c]) => [t, c] as const), 16, chipY, W - 16)
  const alt = `${f ? `${f.title}: ${label(f, running)}, ${pct}%, phase ${f.phase}. ` : 'Activity. '}${counts.map(c => c[0]).join(', ')}.`
  return doc(W, H, body, alt)
}

const sectionCard = (name: string, n: number, color: string, W: number): Drawn => {
  const w = Math.min(W, Math.round(name.length * 7.4 + 62))
  const body =
    `<rect x="0" y="0" width="${w}" height="26" rx="13" fill="${P.card}" stroke="${P.line}"/>` +
    `<circle cx="14" cy="13" r="4" fill="${color}"/>` +
    `<text x="26" y="17.5" font-size="12.5" font-weight="700" fill="${P.text}">${esc(name)}</text>` +
    `<text x="${w - 14}" y="17.5" font-size="12.5" font-weight="700" text-anchor="end" fill="${color}">${n}</text>`
  return doc(w, 26, body, `${name}: ${n}`)
}

const emptyCard = (W: number): Drawn =>
  doc(
    W,
    64,
    ground(W, 64, true) +
      glyph('spark', 18, 20, 24, P.clay) +
      `<text x="52" y="30" font-family="${SERIF}" font-size="14" font-weight="600" fill="${P.text}">No subagents yet</text>` +
      `<text x="52" y="47" font-size="11.5" fill="${P.muted}">They appear here the moment one starts.</text>`,
    'No subagents yet.',
  )

// --- the panel

async function togglePane($: EngineInterface): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: 'Activity' })
  return true
}

// Opens the panel once per flow (or once per session without one).
async function autoOpen($: EngineInterface, key: string): Promise<void> {
  if ((await read($, openedFor)) === key) return
  await update($, openedFor, () => key)
  await $.ui.open({ id: PANE, title: 'Activity' })
}

// The Assumptions pane is a tab behind this one; opening an open id only retitles it, so close and reopen to bring it forward.
async function showAssumptions($: EngineInterface): Promise<void> {
  await $.ui.close({ id: 'assumption-log' })
  await $.ui.open({ id: 'assumption-log', title: 'Assumptions', focus: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'progress',
      isDeferred: false,
      description:
        'Report progress of a multi-step task to the progress bar above the prompt and the subagents panel. ' +
        'Use it for a task of 3 or more steps that has no TodoWrite/TaskCreate list, or when you lay out a plan ' +
        'for the user to follow: after presenting the plan (title, total, tasks, phase), each time a task is finished and ' +
        'checked (done), when the phase or the plan changes, and once at the end with finished: true. A plan you ' +
        'only describe stays open (not finished) until the user reports it done. Fields left out keep their ' +
        'previous value.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks finished and checked.' },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the whole task is closed.' },
          tasks: {
            type: 'array',
            description:
              'The planned tasks in order, numbered from 1. A task given to a subagent must use the same title as ' +
              'the Agent tool `description`, so the panel can match the run to the task.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; reused as the Agent description.' },
                agent: { type: 'string', description: 'The subagent type planned for it, if any.' },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
              },
              required: ['title'],
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      isDeferred: false,
      description:
        'For subagents only: report progress on your own task to the subagents panel. Right after reading your ' +
        'brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; call it again as each step finishes. ' +
        'Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
    })
    await $.command.register({
      name: 'subagents',
      description: 'Show or hide the activity panel: tasks, background, agents, assumptions, files',
    })
    await refreshTree($)
    // Always on: the panel opens with the session.
    await autoOpen($, 'session')
    // Moves the clocks of running subagents; quiet when none run.
    let ticks = 0
    $.clock.every(1000, () => {
      void (async () => {
        const running = (await read($, jobs)).filter(j => j.status === 'running')
        const busy = (await read($, runs)).some(r => r.status === 'running') || running.length > 0 || (await read($, main)).isWorking
        if (!busy) return
        // Every 4th second, re-read the end of each running task's output file.
        if (++ticks % 4 === 0) {
          for (const j of running.filter(j => j.outputPath)) {
            const tail = await tailOf($, j.outputPath!)
            if (tail.length) await update($, jobs, l => l.map(x => (x.id === j.id ? { ...x, tail } : x)))
          }
        }
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, { id: 'agent-panel:rule', text: RULE, scope: 'session' as const }] }
  })

  on('command.run', { command: 'subagents' }, async $ => ({
    text: (await togglePane($)) ? 'Subagents panel opened.' : 'Subagents panel closed.',
  }))

  on('tool.call', { tool: PROGRESS }, async ($, e) => {
    const input = e as unknown as ProgressInput
    if (isNewFlow(await read($, flow), input) && input.title !== undefined) {
      // A new flow starts with a clean list; subagents still running stay.
      await update($, runs, list => list.filter(r => r.status === 'running'))
    }
    const f = await update($, flow, prev => merge(prev, input))
    if (f && input.tasks?.length) await autoOpen($, f.title)
    const running = (await read($, runs)).filter(r => r.status === 'running').length
    return { result: `ok: ${f ? label(f, running) : ''}` }
  })

  // A subagent's own progress: the call runs in its loop, so agentId names it.
  on('tool.call', { tool: STEP }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    if (!e.agentId) return { result: 'ignored: only subagents report steps' }
    await update($, runs, list =>
      list.map(r => {
        if (r.id !== e.agentId) return r
        const total = Math.max(0, Math.round(input.total ?? r.stepTotal ?? 0))
        const done = Math.max(0, Math.round(input.done ?? r.stepDone ?? 0))
        return { ...r, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: input.note?.trim() || undefined }
      }),
    )
    return { result: 'ok' }
  })

  // Every tool call: a subagent's last one is its activity; the main conversation's go in the step log,
  // its background shells and monitors in the job list, its task list in the todo card.
  on('tool.call', async ($, e, next) => {
    if (e.tool === STEP || e.tool === PROGRESS) return next(e)
    const rec = e as unknown as Record<string, unknown>
    const summary = describeCall(rec)
    if (e.agentId) {
      await update($, runs, list => list.map(r => (r.id === e.agentId ? { ...r, activity: summary } : r)))
      return next(e)
    }
    const id = e.tool_use_id
    const start = await $.clock.now()
    await update($, calls, l => [...l, { id, tool: shortTool(e.tool), summary, detail: detailOf(rec), startedAt: start, status: 'running' as const }].slice(-40))
    await update($, now, () => start)
    const rawPath = EDITORS.includes(e.tool) ? String(rec.file_path ?? rec.notebook_path ?? '') : ''
    const path = rawPath ? toRelative(rawPath, await read($, root)) : ''
    if (path) {
      await update($, files, l =>
        l.some(f => f.path === path) ? l.map(f => (f.path === path ? { ...f, isEditing: true } : f)) : [...l, { path, isEditing: true, added: 0, removed: 0 }],
      )
    }
    if (e.tool === 'TodoWrite') {
      const next_ = readTodos(rec)
      await update($, todos, () => next_)
      await update($, todosAt, () => start)
      if (next_.length) await autoOpen($, 'session')
    }

    const result = await next(e)

    const end = await $.clock.now()
    const r = result as { isError?: boolean; deny?: string; text?: string; result?: unknown }
    const status: RunStatus = r.isError || typeof r.deny === 'string' ? 'failed' : 'done'
    await update($, calls, l => l.map(c => (c.id === id ? { ...c, status, endedAt: end } : c)))
    const text = outText(r)
    if (status === 'failed') {
      const error = firstLine(text || r.deny || 'failed')
      await update($, calls, l => l.map(c => (c.id === id ? { ...c, error } : c)))
    }
    if (path) {
      const n = editCounts(e.tool, rec)
      await update($, files, l =>
        l.flatMap((f): FileEdit[] =>
          f.path !== path ? [f]
          : status === 'done' ? [{ ...f, isEditing: false, added: f.added + n.added, removed: f.removed + n.removed }]
          : f.added + f.removed > 0 ? [{ ...f, isEditing: false }] : [],
        ),
      )
      if (status === 'done' && e.tool === 'Write') await update($, tree, l => (l.includes(path) ? l : [...l, path]))
    }
    // A shell call: Bash, or PowerShell on Windows.
    const isShell = e.tool === 'Bash' || e.tool === 'PowerShell'
    if (isShell && rec.run_in_background !== true && CHECK_CMD.test(String(rec.command ?? ''))) {
      const command = String(rec.command).replace(/\s+/g, ' ').trim().slice(0, 100)
      const check: Check = { id, command, at: end, ...readCheck(command, text, status === 'failed') }
      await update($, checks, l => [...l, check].slice(-8))
    }

    // Started in the background by the model, or moved there by the person: either way the result names the task.
    const bgId = /background/i.test(text) ? TASK_ID.exec(text)?.[1] : undefined
    const isBg = (isShell && rec.run_in_background === true) || e.tool === 'Monitor' || (isShell && !!bgId)
    if (isBg && !(bgId && (await read($, jobs)).some(j => j.taskId === bgId))) {
      const label = String(rec.description || rec.command || rec.name || e.tool).replace(/\s+/g, ' ').trim()
      const job: Job = {
        id,
        taskId: TASK_ID.exec(text)?.[1],
        outputPath: OUTPUT_PATH.exec(text)?.[1],
        kind: e.tool === 'Monitor' ? 'monitor' : 'shell',
        label: label.slice(0, 120),
        startedAt: start,
        status: status === 'failed' ? 'failed' : 'running',
        endedAt: status === 'failed' ? end : undefined,
      }
      await update($, jobs, l => [...l, job].slice(-30))
      await autoOpen($, 'session')
    }
    if (STOPPERS.includes(e.tool)) {
      const target = String(rec.task_id ?? rec.shell_id ?? rec.bash_id ?? '')
      if (target) await update($, jobs, l => settleJobs(l, `${target} killed`, end))
    }
    if (e.tool === 'TaskCreate' || e.tool === 'TaskUpdate') await update($, todosAt, () => end)
    if (e.tool === 'TaskCreate') {
      const n = /#(\d+)/.exec(text)?.[1]
      await update($, todos, l => [...l, { id: n, text: String(rec.subject ?? '').trim(), now: String(rec.activeForm ?? ''), status: 'pending' as const }].filter(t => t.text))
    }
    if (e.tool === 'TaskUpdate') {
      const tid = String(rec.taskId ?? '')
      await update($, todos, l =>
        rec.status === 'deleted'
          ? l.filter(t => t.id !== tid)
          : l.map(t => (t.id === tid ? { ...t, status: rec.status ? todoStatus(rec.status) : t.status, text: rec.subject ? String(rec.subject) : t.text } : t)),
      )
    }
    return result
  })

  // A background task's end arrives as a notification message; it names the task and how it ended.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification') {
      const at = await $.clock.now()
      await update($, jobs, l => settleJobs(l, e.text, at))
    }
    return next(e)
  })

  // The engine's own list of work still running after each turn: the one source that also knows
  // tasks the person moved to the background by hand, and tasks that ended without a notification.
  on('classic.Stop', async ($, e, next) => {
    const tasks = (e as unknown as { background_tasks?: { id: string; type: string; description: string; command?: string }[] }).background_tasks
    if (tasks) {
      const at = await $.clock.now()
      await update($, jobs, l => syncJobs(l, tasks, at))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!(e as { agentId?: string }).agentId) {
      const at = await $.clock.now()
      const prompt = promptLine((e as { text?: string }).text ?? '')
      await update($, main, m => ({ ...m, isWorking: true, turnStartedAt: at, prompt: prompt || m.prompt }))
      await update($, files, () => [])
      await update($, now, () => at)
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started
    const at = await $.clock.now()
    const run: Run = {
      id: started.agentId ?? e.tool_use_id,
      type: e.subagentType,
      description: e.description,
      model: started.model,
      status: 'running',
      startedAt: at,
      contextTokens: 0,
      contextMax: windowOf(started.model),
      requests: 0,
    }
    await update($, runs, list => [...list.filter(r => r.id !== run.id), run].slice(-50))
    await update($, now, () => at)
    const f = await read($, flow)
    await autoOpen($, f && !f.isFinished ? f.title : 'session')
    return started
  })

  // Each model request of a subagent: its context and model as they are now.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (!usage) return result
    const model = usage.model || e.model
    if (!e.agentId) {
      await update($, main, m => ({ ...m, isWorking: true }))
      return result
    }
    await update($, runs, list =>
      list.map((r): Run =>
        r.id !== e.agentId
          ? r
          : {
              ...r,
              model,
              effort: e.effort === undefined ? r.effort : String(e.effort),
              status: 'running',
              endedAt: undefined,
              contextTokens: contextOf(usage),
              contextMax: windowOf(model),
              requests: r.requests + 1,
              tokens: (r.tokens ?? 0) + tokensOf(usage),
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const at = await $.clock.now()
      const status: RunStatus = e.reason === 'answer' ? 'done' : 'failed'
      const list = await update($, runs, l => l.map(r => (r.id === e.agentId ? { ...r, status, endedAt: at } : r)))
      const run = list.find(r => r.id === e.agentId)
      if (run) $.ui.toast(`${GLYPH[status]} ${run.description || run.type} (${fmtTime(elapsed(run, at))})`)
    } else {
      // The turn is over: nothing of the main conversation is still running, except background jobs.
      const at = await $.clock.now()
      await update($, main, m => ({ ...m, isWorking: false, turnEndedAt: at }))
      await update($, files, l => l.map(f => ({ ...f, isEditing: false })))
      await refreshTree($)
      await update($, calls, l => l.map(c => (c.status === 'running' ? { ...c, status: 'done' as const, endedAt: at } : c)))
      await update($, now, () => at)
    }
    return next(e)
  })

  // The panel, in the kit's order: Tasks, Background, Agents, Assumptions, Files; then tests and the timeline.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const list = await read($, runs)
    const at = await read($, now)
    const f = await read($, flow)
    const running = list.filter(r => r.status === 'running').reverse()
    const finished = list.filter(r => r.status !== 'running').reverse()
    const planned = plannedOf(f, list)
    const barW = Math.max(6, Math.min(20, e.props.bodyColumns - 34))
    const m = await read($, main)
    const cs = await read($, calls)
    const tdAll = await read($, todos)
    const js = await read($, jobs)
    const jobsRun = js.filter(j => j.status === 'running').reverse()
    const jobsDone = js.filter(j => j.status !== 'running').reverse()
    const fl = await read($, files)
    const ck = await read($, checks)
    const usage = await $.session.usage().catch(() => null)
    const fold = await read($, collapsed)
    const isOpen = (k: string) => !fold.includes(k)
    const flip = (k: string) => update($, collapsed, l => (l.includes(k) ? l.filter(x => x !== k) : [...l, k]))
    // What waits on the person: a question being asked, failures of this turn.
    const needs: Need[] = [
      ...cs.filter(c => c.tool === 'AskUserQuestion' && c.status === 'running').map(c => ({ kind: 'question' as const, text: c.summary.replace(/^AskUserQuestion\s*/, '') || 'a question' })),
      ...cs.filter(c => c.status === 'failed' && c.startedAt >= m.turnStartedAt).slice(-3).map(c => ({ kind: 'failure' as const, text: `${c.tool}: ${c.error ?? 'failed'}` })),
    ]
    // Kept by the assumption-log mod; reviewed in its own pane.
    const asm = await $.state.get({ plugin: 'assumption-log', key: 'items' } as never).catch(() => null)
    const asmItems = (asm as { value?: AsmItem[] } | null)?.value ?? []
    const toReview = asmItems.filter(a => a.status === 'open').length
    const bars: Bar[] = [
      ...list.map(r => ({ label: r.description || r.type, start: r.startedAt, end: r.endedAt, status: r.status })),
      ...js.map(j => ({ label: j.label, start: j.startedAt, end: j.endedAt, status: j.status })),
    ].sort((x, y) => x.start - y.start)
    // A finished list leaves two minutes after it was done; one nobody has touched for 3 hours leaves while nothing runs.
    const clockNow = await $.clock.now()
    const tdAt = await read($, todosAt)
    const allDone = tdAll.length > 0 && tdAll.every(t => t.status === 'completed')
    const isStale = (allDone && clockNow - tdAt > 120_000) || (clockNow - tdAt > 3 * 3_600_000 && !m.isWorking && jobsRun.length === 0)
    // Claude's own task list (TodoWrite/TaskCreate) when it keeps one; else the plan it reports through `progress`.
    const td = !isStale && tdAll.length ? tdAll : flowTodos(f)
    const tdDone = td.filter(t => t.status === 'completed').length
    const nowCalls = cs.filter(c => c.status === 'running').reverse()
    const openC = await read($, openCalls)
    const clearAgents = () => update($, runs, l => l.filter(r => r.status === 'running'))
    const clearJobs = () => update($, jobs, l => l.filter(j => j.status === 'running'))
    // Finished tasks leave; so does a finished reported plan.
    const hasFinishedFlow = !!f && (f.isFinished || (f.total > 0 && f.done >= f.total))
    const clearTasks = async () => {
      await update($, todos, l => l.filter(t => t.status !== 'completed'))
      if (hasFinishedFlow) await update($, flow, () => null)
    }
    const canClearTasks = tdDone > 0 || hasFinishedFlow
    // Files: the tree while working (or before any edit); the edited files once the run ends.
    const projectFiles = await read($, tree)
    const rootPath = await read($, root)
    const dirsOpen = await read($, openDirs)
    const gitChanged = await read($, changed)
    const isChangedView = !m.isWorking && fl.length > 0
    const rows = isChangedView ? buildTree([], fl, [], true) : buildTree(projectFiles, fl, dirsOpen, false, gitChanged)
    const rootName = rootPath.split('/').filter(Boolean).at(-1) ?? 'project'
    const editingNow = fl.find(x => x.isEditing)
    const filesSub = isChangedView
      ? `${fl.length} changed in last run`
      : editingNow
        ? `editing ${editingNow.path.split('/').at(-1)}`
        : gitChanged.length
          ? `${gitChanged.length} changed · ${projectFiles.length} in project`
          : `${projectFiles.length} in project`
    // With no list, the task is the turn itself: what the person asked, running or last done.
    const turnTime = fmtTime((m.isWorking ? at : (m.turnEndedAt ?? at)) - m.turnStartedAt)
    const current = td.length === 0 && m.prompt ? m.prompt : ''
    const tasksSub = td.length
      ? `${tdDone}/${td.length} done${nowCalls.length ? ` · ${nowCalls.length} running now` : ''}`
      : current
        ? m.isWorking ? `working · ${turnTime}` : `last done in ${turnTime}`
        : 'no task list'

    // The terminal's table names Svg too but cannot draw it; every other surface can.
    if ('Svg' in els && e.surface !== 'terminal') {
      const { Svg } = els
      const theme = (await $.config.list().catch(() => [])).find(r => r.key === 'theme')?.value
      P = /light/i.test(String(theme)) ? LIGHT : DARK
      const W = Math.max(280, Math.min(1000, e.props.bodyColumns * 8))
      const item = (key: string, d: Drawn) => (
        <Box key={key} marginBottom={1}>
          <Svg source={d.svg} alt={d.alt} />
        </Box>
      )
      const none = (key: string, text: string) => (
        <Box key={key} marginBottom={1}>
          <Text dimColor>{text}</Text>
        </Box>
      )
      // A card that has its own title: a small "Hide" above it, or one line to bring it back.
      const section = (k: string, name: string, n: number, card: () => Drawn) =>
        isOpen(k) ? (
          <Box key={`sec-${k}`} flexDirection="column">
            <Button key={`fold-${k}`} label="▾ Hide" plain onPress={() => flip(k)} />
            {item(k, card())}
          </Box>
        ) : (
          <Box key={`sec-${k}`} marginBottom={1}>
            <Button key={`fold-${k}`} label={`▸ ${name} · ${n}`} plain onPress={() => flip(k)} />
          </Box>
        )
      // A section header: the pill, a Hide/Show button, and anything extra beside it.
      const pill = (k: string, name: string, n: number, color: string, extra?: JSX.Element) => (
        <Box key={`pill-${k}`} marginBottom={1} gap={2} alignItems="center">
          <Svg source={sectionCard(name, n, color, W).svg} alt={`${name}: ${n}`} />
          <Button key={`fold-${k}`} label={isOpen(k) ? 'Hide' : 'Show'} plain onPress={() => flip(k)} />
          {extra}
        </Box>
      )
      const doneN = finished.length
      return (
        <Box flexDirection="column">
          {item('head', headCard(f, list, planned.length, W, jobsRun.length, usage?.cost?.usd, nowCalls.length > 0 || m.isWorking))}
          {needs.length > 0 && section('needs', 'Needs you', needs.length, () => needsCard(needs, W))}

          {pill('tasks', 'Tasks', td.length ? td.length - tdDone : nowCalls.length, P.clay, canClearTasks ? <Button key="clear-tasks" label="Clear finished" plain onPress={clearTasks} /> : undefined)}
          {isOpen('tasks') && nowCalls.length === 0 && td.length === 0 && planned.length === 0 && !current && none('tasks-none', 'No task list yet.')}
          {isOpen('tasks') && current && (
            <Box key="current" marginBottom={1}>
              <Text wrap="wrap">
                <Text color={m.isWorking ? P.clay : P.olive}>{m.isWorking ? '● ' : '✓ '}</Text>
                <Text bold={m.isWorking}>{current}</Text>
                <Text dimColor> · {turnTime}</Text>
              </Text>
            </Box>
          )}
          {isOpen('tasks') &&
            nowCalls.map(c => (
              <Box key={`call-${c.id}`} flexDirection="column">
                {item(`call-card-${c.id}`, callCard(c, openC.includes(c.id), at, W))}
                <Box key={`call-act-${c.id}`} marginBottom={1}>
                  <Button
                    key={`more-${c.id}`}
                    label={openC.includes(c.id) ? '▾ Hide' : '▸ Details'}
                    plain
                    onPress={() => update($, openCalls, l => (l.includes(c.id) ? l.filter(x => x !== c.id) : [...l, c.id]))}
                  />
                </Box>
              </Box>
            ))}
          {isOpen('tasks') && td.length > 0 && item('todos', todoCard(td, W))}
          {isOpen('tasks') && planned.map(p => item(`plan-${p.n}`, plannedCard(p, W)))}

          {pill('background', 'Background', jobsRun.length, P.sky, jobsDone.length > 0 ? <Button key="clear-jobs" label="Clear finished" plain onPress={clearJobs} /> : undefined)}
          {isOpen('background') && js.length === 0 && none('bg-none', 'Nothing in the background.')}
          {isOpen('background') && jobsRun.map(j => item(`job-${j.id}`, jobCard(j, at, W)))}
          {isOpen('background') && jobsDone.slice(0, 5).map(j => item(`job-${j.id}`, jobCard(j, at, W)))}

          {pill('agents', 'Agents', running.length, P.heather, doneN > 0 ? <Button key="clear" label="Clear finished" plain onPress={clearAgents} /> : undefined)}
          {isOpen('agents') && list.length === 0 && none('agents-none', 'No agents this session.')}
          {isOpen('agents') && running.map(r => item(r.id, runCard(r, at, W)))}
          {isOpen('agents') && finished.map(r => item(r.id, runCard(r, at, W)))}

          {pill('assumptions', 'Assumptions', toReview, P.gold, asmItems.length > 0 ? <Button key="review" label="Review" plain onPress={() => showAssumptions($)} /> : undefined)}
          {isOpen('assumptions') && item('asm', assumptionsCard(asmItems, W))}

          {pill('files', 'Files', fl.length, P.sky)}
          {isOpen('files') && item('tree', treeCard(rows, rootName, filesSub, W))}

          {ck.length > 0 && section('checks', 'Tests & builds', ck.length, () => checksCard(ck, at, W))}
          {bars.length >= 2 && section('timeline', 'Timeline', bars.length, () => timelineCard(bars, at, W))}
        </Box>
      )
    }

    // Terminal: the same sections as text, each under a header that folds it.
    const rule = (k: string) => <Text key={`rule-${k}`} color={T.line}>{'─'.repeat(Math.max(8, e.props.bodyColumns - 1))}</Text>
    const head = (k: string, title: string, sub: string, color: string) => (
      <Box key={`head-${k}`} flexDirection="column" marginTop={1}>
        {rule(k)}
        <Button key={`fold-${k}`} plain onPress={() => flip(k)}>
          <Text color={color} bold>
            {isOpen(k) ? '▾' : '▸'} ● {title}
          </Text>
          <Text color={T.muted}>  {sub}</Text>
        </Button>
      </Box>
    )
    // A thin colored meter: the filled part in `color`, the rest dim.
    const meter = (pct: number, width: number, color: string) => {
      const n = Math.max(0, Math.min(width, Math.round((width * pct) / 100)))
      return (
        <Text>
          <Text color={color}>{'━'.repeat(n)}</Text>
          <Text color={T.line}>{'─'.repeat(width - n)}</Text>
        </Text>
      )
    }
    const action = (key: string, text: string, onPress: () => unknown) => (
      <Box key={key} paddingLeft={2}>
        <Button key={`btn-${key}`} plain onPress={onPress}>
          <Text color={T.info}>⌫ {text}</Text>
        </Button>
      </Box>
    )
    const dim = (key: string, text: string) => (
      <Text key={key} color={T.muted}>
        {'  '}
        {text}
      </Text>
    )
    // A list row with a hanging indent: the mark keeps its column and wrapped text lines up after it.
    const li = (key: string, mark: JSX.Element | string, body: JSX.Element | string, pad = 2, color?: string) => (
      <Box key={key} paddingLeft={pad}>
        <Box width={2} flexShrink={0}>
          {typeof mark === 'string' ? <Text color={color}>{mark}</Text> : mark}
        </Box>
        <Box flexShrink={1}>
          <Text wrap="wrap" color={color}>
            {body}
          </Text>
        </Box>
      </Box>
    )
    // An agent as a three-line card with a left accent in its status color; every line fits one row.
    const runRow = (r: Run) => {
      const pct = r.contextMax ? Math.min(100, Math.round((r.contextTokens / r.contextMax) * 100)) : 0
      // The task's own progress when the subagent reports steps; else its context load.
      const progress = r.status === 'done' ? 1 : r.stepTotal ? Math.min(1, (r.stepDone ?? 0) / r.stepTotal) : null
      const tone = r.status === 'done' ? T.ok : r.status === 'failed' ? T.bad : T.clay
      const accent = <Text color={tone}>▍ </Text>
      const note = [r.stepTotal ? `${r.stepDone ?? 0}/${r.stepTotal}${r.stepNote ? ' ' + r.stepNote : ''}` : '', r.status === 'running' ? r.activity : '']
        .filter(Boolean)
        .join(' › ')
      return (
        <Box key={r.id} flexDirection="column" marginBottom={1}>
          <Box justifyContent="space-between" gap={1}>
            <Box flexShrink={1}>
              <Text wrap="truncate-end">
                {accent}
                <Text color={tone}>{GLYPH[r.status]} </Text>
                <Text bold>{r.description || r.type}</Text>
              </Text>
            </Box>
            <Text color={tone}>{fmtTime(elapsed(r, at))}</Text>
          </Box>
          <Text wrap="truncate-end">
            {accent}
            <Text color={modelColor(r.model)} bold>  ◆ {modelName(r.model)}</Text>
            {r.effort ? <Text color={effortColor(r.effort)}>{'  '}{effortDots(r.effort)} {r.effort}</Text> : null}
            <Text color={T.muted}>  {r.type}</Text>
          </Text>
          <Text wrap="truncate-end">
            {accent}
            {'  '}
            {meter(progress === null ? pct : progress * 100, barW, progress === null ? loadColor(pct) : tone)}
            <Text color={loadColor(pct)}> {pct}%</Text>
            <Text color={T.muted}> ctx · {r.requests} req</Text>
          </Text>
          {note ? (
            <Text wrap="truncate-end" color={T.muted}>
              {accent}
              {'  '}› {note}
            </Text>
          ) : null}
        </Box>
      )
    }
    const treeRow = (r: TreeRow, i: number) => {
      const indent = '  '.repeat(r.depth + 2)
      if (r.more !== undefined)
        return isChangedView ? (
          dim(`more-${i}`, `${indent.slice(2)}… ${r.more} more`)
        ) : (
          // Opens the folder this row stands in, listing all it holds.
          <Button key={`tree-more-${i}-${r.path.replace(/[^A-Za-z0-9]/g, '_').slice(-40)}`} plain onPress={() => update($, openDirs, l => (l.includes(r.path) ? l : [...l, r.path]))}>
            <Text color={T.muted}>
              {indent}… {r.more} more
            </Text>
          </Button>
        )
      if (r.isDir)
        return isChangedView ? (
          <Text key={`dir-${i}`} color={T.info}>
            {indent}▾ {r.name}/
          </Text>
        ) : (
          <Button key={`dir-${i}-${r.path.replace(/[^A-Za-z0-9]/g, '_').slice(-40)}`} plain onPress={() => update($, openDirs, l => (l.includes(r.path) ? l.filter(x => x !== r.path) : [...l, r.path]))}>
            <Text color={T.info}>
              {indent}
              {r.isOpen ? '▾' : '▸'} {r.name}/
            </Text>
          </Button>
        )
      if (r.touch?.isEditing)
        return (
          <Text key={`f-${i}`} color={T.clay} bold>
            {indent}● {r.name} <Text color={T.warn}>◀ editing</Text>
          </Text>
        )
      if (r.touch)
        return (
          <Text key={`f-${i}`}>
            <Text color={T.ok}>
              {indent}✎ {r.name}
            </Text>
            <Text color={T.ok}> +{r.touch.added}</Text>
            <Text color={T.bad}> −{r.touch.removed}</Text>
          </Text>
        )
      if (r.isChanged)
        return (
          <Text key={`f-${i}`} color={T.heather}>
            {indent}• {r.name}
          </Text>
        )
      return (
        <Text key={`f-${i}`} color={T.muted}>
          {indent} {r.name}
        </Text>
      )
    }

    return (
      <Box flexDirection="column" width={e.props.bodyColumns} paddingRight={1} minHeight={e.props.scroll.bodyRows} backgroundColor={PANE_BG}>
        {f && !f.isFinished && (
          <Text wrap="wrap">
            <Text color={T.clay} bold>{f.title}</Text>
            <Text color={T.muted}> · {label(f, running.length)}</Text>
          </Text>
        )}
        {needs.map((n, i) => li(`need-${i}`, '!', `${n.kind === 'question' ? 'asking you' : 'failed'}: ${n.text}`, 0, T.bad))}

        {head('tasks', 'TASKS', tasksSub, T.clay)}
        {isOpen('tasks') && (
          <Box flexDirection="column">
            {nowCalls.length === 0 && td.length === 0 && planned.length === 0 && !current && dim('tasks-none', 'no task list yet')}
            {current &&
              li(
                'current',
                m.isWorking ? <Text color={T.clay}>●</Text> : <Text color={T.ok}>✓</Text>,
                <Text>
                  <Text bold={m.isWorking} color={m.isWorking ? undefined : T.muted}>{current}</Text>
                  <Text color={T.muted}> · {turnTime}</Text>
                </Text>,
              )}
            {nowCalls.map(c =>
              li(
                `now-${c.id}`,
                <Text color={T.clay}>●</Text>,
                <Text>
                  {c.summary} <Text color={T.muted}>· {fmtTime(at - c.startedAt)}</Text>
                </Text>,
              ),
            )}
            {td.length > 0 && (
              <Text>
                {'  '}
                {meter((tdDone / td.length) * 100, barW, tdDone === td.length ? T.ok : T.clay)}
                <Text bold color={tdDone === td.length ? T.ok : T.clay}> {tdDone}/{td.length}</Text>
                <Text color={T.muted}> {Math.round((tdDone / td.length) * 100)}%</Text>
              </Text>
            )}
            {td.slice(0, 12).map((t, i) =>
              li(
                `todo-${i}`,
                <Text color={t.status === 'completed' ? T.ok : t.status === 'in_progress' ? T.warn : T.muted}>
                  {t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '◉' : '○'}
                </Text>,
                <Text bold={t.status === 'in_progress'} color={t.status === 'completed' ? T.muted : t.status === 'in_progress' ? T.warn : undefined}>
                  {t.status === 'in_progress' && t.now ? t.now : t.text}
                </Text>,
              ),
            )}
            {planned.map(p => li(`plan-${p.n}`, '◷', `${p.n}. ${p.title}${p.agent ? ` · ${p.agent}` : ''}`, 2, T.muted))}
            {canClearTasks && action('clear-tasks', 'Clear finished', clearTasks)}
          </Box>
        )}

        {head('background', 'BACKGROUND', `${jobsRun.length} running`, T.info)}
        {isOpen('background') && (
          <Box flexDirection="column">
            {js.length === 0 && dim('bg-none', 'nothing in the background')}
            {[...jobsRun, ...jobsDone.slice(0, 5)].map(j =>
              li(
                `job-${j.id}`,
                <Text color={COLOR[j.status]}>{GLYPH[j.status]}</Text>,
                <Text>
                  <Text color={j.status === 'running' ? undefined : T.muted}>{j.label}</Text>
                  <Text color={j.kind === 'monitor' ? T.heather : T.info}> ▪ {j.kind}</Text>
                  <Text color={T.muted}>
                    {' '}
                    · {fmtTime(elapsed({ startedAt: j.startedAt, endedAt: j.endedAt } as Run, at))}
                    {j.tail?.length ? ` · ${j.tail[j.tail.length - 1]}` : ''}
                  </Text>
                </Text>,
              ),
            )}
            {jobsDone.length > 0 && action('clear-jobs', 'Clear finished', clearJobs)}
          </Box>
        )}

        {head('agents', 'AGENTS', `${running.length} running`, T.heather)}
        {isOpen('agents') && (
          <Box flexDirection="column">
            {list.length === 0 && dim('agents-none', 'no agents this session')}
            {running.map(runRow)}
            {finished.map(runRow)}
            {finished.length > 0 && action('clear-agents', 'Clear finished', clearAgents)}
          </Box>
        )}

        {head('assumptions', 'ASSUMPTIONS', `${toReview} to review`, T.warn)}
        {isOpen('assumptions') && (
          <Box flexDirection="column">
            {asmItems.length === 0 && dim('asm-none', 'none logged yet')}
            {asmItems
              .filter(a => a.status === 'open')
              .slice(-5)
              .reverse()
              .map(a =>
                li(
                  `asm-${a.id}`,
                  <Text color={T.warn}>◇</Text>,
                  <Text>
                    <Text color={T.warn}>A{a.id}</Text> {a.text}
                  </Text>,
                ),
              )}
            {asmItems.length > 0 && toReview === 0 && dim('asm-done', 'all reviewed')}
            {asmItems.length > 0 && action('review', 'Review assumptions', () => showAssumptions($))}
          </Box>
        )}

        {head('files', 'FILES', filesSub, T.info)}
        {isOpen('files') && (
          <Box flexDirection="column">
            <Text color={T.info} bold>
              {'  '}▾ {rootName}
            </Text>
            {rows.slice(0, MAX_TREE_ROWS).map(treeRow)}
            {rows.length > MAX_TREE_ROWS && dim('rows-more', `… ${rows.length - MAX_TREE_ROWS} more rows`)}
          </Box>
        )}

        {ck.length > 0 && head('checks', 'TESTS & BUILDS', `${ck.length}`, ck[ck.length - 1]!.isOk ? T.ok : T.bad)}
        {ck.length > 0 &&
          isOpen('checks') &&
          ck.slice(-3).map(c =>
            li(
              `check-${c.id}`,
              <Text color={c.isOk ? T.ok : T.bad}>{c.isOk ? '✔' : '✘'}</Text>,
              <Text>
                {short(c.command, Math.max(16, e.props.bodyColumns - 16 - c.summary.length))}
                <Text color={c.isOk ? T.ok : T.bad}> · {c.summary}</Text>
              </Text>,
            ),
          )}
        <Text color={T.muted}>[debug] rows {e.props.scroll.bodyRows} · cols {e.props.bodyColumns} · {e.props.placement}</Text>
      </Box>
    )
  })

  // The flow's progress bar when one is reported; else one line while subagents run.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const f = await read($, flow)
    const list = await read($, runs)
    const running = list.filter(r => r.status === 'running')
    const bg = (await read($, jobs)).filter(j => j.status === 'running')
    if (!f && running.length === 0 && bg.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    if (f) {
      const color = f.isFinished ? 'green' : ACCENT
      const cols = e.props.bodyColumns
      const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(cols / 3)))
      const width = Math.max(6, Math.min(40, cols - titleW - 32))
      return (
        <Box flexDirection="row" gap={2}>
          <Box width={titleW} flexShrink={0}>
            <Text color={color}>● </Text>
            <Text wrap="truncate-end">{f.title}</Text>
          </Box>
          <Text color={color}>{bar(ratio(f) * 100, width)}</Text>
          <Text bold>{label(f, running.length)}</Text>
          <Text dimColor>{Math.round(ratio(f) * 100)}%</Text>
          <Button
            key="panel"
            label={`×${list.length + plannedOf(f, list).length}`}
            plain
            onPress={() => void togglePane($)}
          />
          <Button key="dismiss" label="✕" plain role="dismiss" onPress={() => update($, flow, () => null)} />
        </Box>
      )
    }

    const at = await read($, now)
    const since = Math.min(...running.map(r => r.startedAt), ...bg.map(j => j.startedAt))
    return (
      <Box flexDirection="row" gap={1}>
        <Text color={ACCENT}>●</Text>
        <Text wrap="truncate-end">
          {running.length + bg.length} running: {[...running.map(r => r.description || r.type), ...bg.map(j => j.label)].join(', ')}
        </Text>
        <Text dimColor>{fmtTime(Math.max(0, at - since))}</Text>
        <Button key="panel" label="Panel" plain onPress={() => void togglePane($)} />
      </Box>
    )
  })
}
