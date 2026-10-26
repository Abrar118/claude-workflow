import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Assumption, Status } from '../types'

const items = atom({ plugin: 'assumption-log', key: 'items' } as const, [])
const expanded = atom({ plugin: 'assumption-log', key: 'expanded' } as const, [])
const hasOpened = atom({ plugin: 'assumption-log', key: 'hasOpened' } as const, false)
const editing = atom({ plugin: 'assumption-log', key: 'editing' } as const, null as number | null)
const lastVerdict = atom({ plugin: 'assumption-log', key: 'lastVerdict' } as const, null as number | null)

const PANE = 'assumption-log'
const ASSUME = 'mcp__assumption-log__assume'

const RULE =
  'Whenever you make an assumption the user did not state (a requirement, default, behavior, name, library, ' +
  'scope or file location you chose for them), call the `assume` tool right away, then carry on without waiting. ' +
  'One call per assumption, one plain sentence each. Skip obvious steps and things the user told you.'

// --- helpers

const label = (a: Assumption): string => `A${a.id}`
const quote = (s: string): string => `“${s.length > 90 ? s.slice(0, 89) + '…' : s}”`
const toggle = (list: number[], id: number): number[] => (list.includes(id) ? list.filter(n => n !== id) : [...list, id])

// What the pane lists: open ones, and wrong or changed ones until their verdict reaches Claude.
// Right ones leave at once (their "keep it" note is still sent).
export const shownIn = (list: Assumption[]): Assumption[] =>
  list.filter(a => a.status === 'open' || (a.status !== 'right' && !a.isSent))

// The verdicts Claude has not heard yet, as one note; null when there are none.
export const reviewText = (list: Assumption[]): string | null => {
  const fresh = list.filter(a => a.status !== 'open' && !a.isSent)
  if (fresh.length === 0) return null
  const lines = fresh.map(a =>
    a.status === 'right'
      ? `- ${label(a)} ${quote(a.text)}: right, keep it.`
      : a.status === 'changed'
        ? `- ${label(a)} ${quote(a.text)}: wrong. Instead: ${a.correction}. Rework anything that relied on it.`
        : `- ${label(a)} ${quote(a.text)}: wrong.${a.alternative ? ` Consider: ${a.alternative}.` : ''} Undo or rework anything that relied on it.`,
  )
  return `[The user reviewed assumptions you logged]\n${lines.join('\n')}`
}

// Takes the note of unheard verdicts and marks them heard, in one update so no verdict slips between.
async function takeReview($: EngineInterface): Promise<string | null> {
  let note: string | null = null
  await update($, items, l => {
    note = reviewText(l)
    return note ? l.map(a => (a.status !== 'open' ? { ...a, isSent: true } : a)) : l
  })
  return note
}

async function setStatus($: EngineInterface, id: number, status: Status, correction = ''): Promise<void> {
  const after = await update($, items, list =>
    list.map((a): Assumption =>
      a.id !== id ? a : status !== 'changed' && a.status === status ? { ...a, status: 'open', correction: '', isSent: false } : { ...a, status, correction, isSent: false },
    ),
  )
  const now = after.find(a => a.id === id)
  await update($, lastVerdict, () => (now && now.status !== 'open' ? id : null))
  await update($, editing, () => null)
}

// Puts the last verdict back to open, while Claude has not heard it.
async function undoVerdict($: EngineInterface): Promise<void> {
  const id = await read($, lastVerdict)
  await update($, items, l => l.map(a => (a.id === id && !a.isSent ? { ...a, status: 'open' as const, correction: '' } : a)))
  await update($, lastVerdict, () => null)
}

async function togglePane($: EngineInterface): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await $.ui.open({ id: PANE, title: 'Assumptions' })
  return true
}

// --- desktop cards. Each card is one SVG in Claude's palette (flat color, warm neutrals, clay accent).

type Drawn = { svg: string; alt: string }
type Palette = Record<'card' | 'line' | 'well' | 'text' | 'muted' | 'clay' | 'sky' | 'olive' | 'fig' | 'heather' | 'gold', string>

const SANS = "-apple-system,'SF Pro Text','Inter','Segoe UI',system-ui,sans-serif"
const SERIF = "'Tiempos Headline','Iowan Old Style',Georgia,'Times New Roman',serif"
const DARK: Palette = {
  card: '#30302E', line: '#454540', well: '#3D3D3A', text: '#FAF9F5', muted: '#A6A39A',
  clay: '#E08A6B', sky: '#7FAEDB', olive: '#9DB27A', fig: '#D77D9A', heather: '#A9A3D6', gold: '#E0B060',
}
const LIGHT: Palette = {
  card: '#FAF9F5', line: '#E3DACC', well: '#EFEBE0', text: '#141413', muted: '#6B6A64',
  clay: '#C6613F', sky: '#4F7FB0', olive: '#5F7A45', fig: '#B04F73', heather: '#7C75B5', gold: '#A8741A',
}
const NAME: Record<Status, string> = { open: 'To review', right: 'Right', wrong: 'Wrong', changed: 'Changed' }

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Greedy line breaks by an estimated width: the SVG cannot measure text.
const wrap = (s: string, px: number, size: number, maxLines: number): string[] => {
  const per = Math.max(8, Math.floor(px / (size * 0.56)))
  const lines: string[] = []
  let line = ''
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= per) line = next
    else {
      if (line) lines.push(line)
      line = word.length > per ? word.slice(0, per - 1) + '…' : word
    }
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines)
    const last = cut[maxLines - 1]!
    cut[maxLines - 1] = (last.length >= per ? last.slice(0, per - 1) : last) + '…'
    return cut
  }
  return lines
}

const lines = (ls: string[], x: number, y: number, size: number, lh: number, attrs: string): string =>
  ls.map((l, i) => `<text x="${x}" y="${y + i * lh}" font-size="${size}" ${attrs}>${esc(l)}</text>`).join('')

const doc = (W: number, H: number, body: string, alt: string): Drawn => ({
  svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${SANS}">${body}</svg>`,
  alt,
})

const ground = (P: Palette, W: number, H: number, dashed = false): string =>
  `<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="14" fill="${P.card}" stroke="${P.line}" stroke-width="1.5"${dashed ? ' stroke-dasharray="5 5"' : ''}/>`

const toneOf = (P: Palette, s: Status): string => (s === 'open' ? P.gold : s === 'right' ? P.olive : s === 'changed' ? P.sky : P.fig)

const headCard = (P: Palette, list: Assumption[], W: number): Drawn => {
  const n = (s: Status) => list.filter(a => a.status === s).length
  const reviewed = list.length - n('open')
  const pct = list.length ? Math.round((reviewed / list.length) * 100) : 0
  const chips = [
    [`${n('open')} to review`, P.gold],
    [`${n('right')} right`, P.olive],
    [`${n('wrong')} wrong`, P.fig],
    [`${n('changed')} changed`, P.sky],
  ] as const
  let x = 16
  const pills = chips
    .map(([t, c]) => {
      const w = Math.round(t.length * 6.3 + 20)
      const out =
        `<rect x="${x}" y="84" width="${w}" height="20" rx="10" fill="${c}" fill-opacity="0.18"/>` +
        `<text x="${x + 10}" y="98" font-size="11" font-weight="600" fill="${c}">${t}</text>`
      x += w + 6
      return out
    })
    .join('')
  const H = 118
  const body =
    ground(P, W, H) +
    `<text x="16" y="36" font-family="${SERIF}" font-size="20" font-weight="600" fill="${P.text}">Assumptions</text>` +
    `<text x="16" y="53" font-size="12" fill="${P.muted}">${list.length} made so far · ${reviewed} reviewed</text>` +
    `<rect x="16" y="64" width="${W - 32 - 48}" height="10" rx="5" fill="${P.well}"/>` +
    (pct ? `<rect x="16" y="64" width="${Math.max(10, ((W - 80) * pct) / 100)}" height="10" rx="5" fill="${P.clay}"/>` : '') +
    `<text x="${W - 16}" y="74" font-size="14" font-weight="700" text-anchor="end" fill="${P.text}">${pct}%</text>` +
    pills
  return doc(W, H, body, `Assumptions: ${list.length} made, ${chips.map(c => c[0]).join(', ')}.`)
}

const itemCard = (P: Palette, a: Assumption, isOpen: boolean, W: number): Drawn => {
  const tone = toneOf(P, a.status)
  const textW = W - 60 - 16 - 84
  const head = wrap(a.text, textW, 14.5, isOpen ? 6 : 2)
  let y = 30
  let body = ''
  body += lines(head, 60, y, 14.5, 19, `font-family="${SERIF}" font-weight="600" fill="${P.text}"`)
  y += head.length * 19 - 5
  const meta: string[] = []
  if (a.status === 'changed' && a.correction) {
    const ls = wrap(`→ ${a.correction}`, W - 60 - 16, 12.5, 3)
    y += 20
    body += lines(ls, 60, y, 12.5, 17, `font-weight="600" fill="${P.sky}"`)
    y += (ls.length - 1) * 17
    meta.push(`Change to: ${a.correction}`)
  }
  if (isOpen) {
    for (const [name, value] of [['Why', a.why], ['Instead', a.alternative]] as const) {
      if (!value) continue
      const ls = wrap(value, W - 60 - 16, 12.5, 4)
      y += 22
      body += `<text x="60" y="${y}" font-size="11" font-weight="700" fill="${P.muted}">${name}</text>`
      y += 17
      body += lines(ls, 60, y, 12.5, 17, `fill="${P.text}" fill-opacity="0.88"`)
      y += (ls.length - 1) * 17
      meta.push(`${name}: ${value}`)
    }
  }
  if (a.area) {
    y += 24
    body += `<text x="60" y="${y}" font-size="11" fill="${P.muted}">while building · ${esc(a.area.length > 60 ? a.area.slice(0, 59) + '…' : a.area)}</text>`
  }
  const H = y + 16
  const sent = a.status !== 'open' && a.isSent ? ' · sent' : ''
  const pill = NAME[a.status] + sent
  const pw = Math.round(pill.length * 6.4 + 28)
  const out =
    ground(P, W, H) +
    `<rect x="14" y="14" width="36" height="36" rx="10" fill="${tone}"/>` +
    `<text x="32" y="37" font-size="13" font-weight="800" text-anchor="middle" fill="${P.card}">${label(a)}</text>` +
    body +
    `<rect x="${W - 16 - pw}" y="14" width="${pw}" height="22" rx="11" fill="${tone}" fill-opacity="0.18"/>` +
    `<circle cx="${W - 16 - pw + 12}" cy="25" r="3.5" fill="${tone}"/>` +
    `<text x="${W - 16 - pw + 22}" y="29" font-size="11" font-weight="700" fill="${tone}">${pill}</text>`
  const alt = `${label(a)} ${NAME[a.status]}${sent}: ${a.text}. ${meta.join('. ')}${a.area ? ` While building: ${a.area}.` : ''}`
  return doc(W, H, out, alt)
}

const emptyCard = (P: Palette, W: number, isDone: boolean): Drawn => {
  const [title, sub] = isDone
    ? ['All reviewed', 'New assumptions show up here as Claude makes them.']
    : ['No assumptions yet', 'Claude logs one here each time it fills a gap on its own.']
  return doc(
    W,
    72,
    ground(P, W, 72, true) +
      `<text x="16" y="32" font-family="${SERIF}" font-size="15" font-weight="600" fill="${P.text}">${title}</text>` +
      `<text x="16" y="52" font-size="12" fill="${P.muted}">${sub}</text>`,
    `${title}.`,
  )
}

// --- the mod

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await update($, hasOpened, () => false)
    await $.tool.register({
      name: 'assume',
      isDeferred: false,
      description:
        'Log an assumption you are making that the user did not state, then carry on. The user reviews the list ' +
        'and can mark each one right or wrong or ask for a change. Call it as you make the assumption, once per ' +
        'assumption. Do not stop to ask and do not use it for obvious steps.',
      inputSchema: {
        type: 'object',
        properties: {
          assumption: { type: 'string', description: 'What you assumed, in one plain sentence.' },
          why: { type: 'string', description: 'What in the task led you to it.' },
          alternative: { type: 'string', description: 'The other reasonable choice you did not take.' },
          area: { type: 'string', description: 'What you are building or doing right now, a few words.' },
        },
        required: ['assumption'],
      },
    })
    await $.command.register({ name: 'assumptions', description: 'Show or hide the list of assumptions Claude made' })
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, { id: 'assumption-log:rule', text: RULE, scope: 'session' as const }] }
  })

  on('command.run', { command: 'assumptions' }, async $ => ({
    text: (await togglePane($)) ? 'Assumptions pane opened.' : 'Assumptions pane closed.',
  }))

  on('tool.call', { tool: ASSUME }, async ($, e) => {
    const input = e as unknown as { assumption?: string; why?: string; alternative?: string; area?: string }
    const text = input.assumption?.trim()
    if (!text) return { result: 'ignored: say what you assumed' }
    const list = await update($, items, l => {
      const id = Math.max(0, ...l.map(a => a.id)) + 1
      const a: Assumption = {
        id,
        text,
        why: input.why?.trim() ?? '',
        alternative: input.alternative?.trim() ?? '',
        area: input.area?.trim() ?? '',
        status: 'open',
        correction: '',
        isSent: false,
        isFromAgent: !!e.agentId,
      }
      return [...l, a].slice(-100)
    })
    const made = list[list.length - 1]!
    const isShown = (await $.ui.panes()).some(p => p.id === PANE)
    if (!isShown && !(await read($, hasOpened))) {
      await update($, hasOpened, () => true)
      await $.ui.open({ id: PANE, title: 'Assumptions' })
    } else if (!isShown) {
      $.ui.toast(`${label(made)} assumption logged. /assumptions to review.`)
    }
    return { result: `Logged as ${label(made)}. Carry on; the user may review it.` }
  })

  // Verdicts reach Claude on their own: mid-turn with the main loop's next tool result...
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if ((e.tool as string) === ASSUME || e.agentId || result.deny !== undefined || result.isError) return result
    const note = await takeReview($)
    return note ? { ...result, context: [...(result.context ?? []), note] } : result
  })

  // ...or, between turns, with the person's next prompt.
  on('prompt.submit', async ($, e, next) => {
    const note = await takeReview($)
    return next(note ? { ...e, text: `${e.text}\n\n${note}` } : e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input } = els
    const list = await read($, items)
    const open = await read($, expanded)
    const editId = await read($, editing)
    const shown = shownIn(list)
    const lastId = await read($, lastVerdict)
    const undoable = list.find(a => a.id === lastId && a.status !== 'open' && !a.isSent)
    const unsent = list.filter(a => a.status !== 'open' && !a.isSent).length
    const openCount = list.filter(a => a.status === 'open').length

    const allRight = async () => {
      await update($, items, l => l.map(a => (a.status === 'open' ? { ...a, status: 'right' as const, isSent: false } : a)))
      await update($, lastVerdict, () => null)
    }

    const actions = (a: Assumption) =>
      editId === a.id ? (
        <Box key={`act-${a.id}`} marginBottom={1}>
          <Input
            key={`fix-${a.id}`}
            placeholder="What should it be instead?"
            submitLabel="Save"
            autoFocus
            onSubmit={(value: string) => (value.trim() ? setStatus($, a.id, 'changed', value.trim()) : update($, editing, () => null))}
          />
        </Box>
      ) : (
      <Box key={`act-${a.id}`} gap={1} marginBottom={1}>
        <Button key={`more-${a.id}`} label={open.includes(a.id) ? 'Hide' : 'Details'} onPress={() => update($, expanded, l => toggle(l, a.id))} />
        <Button key={`right-${a.id}`} label="Right" variant={a.status === 'right' ? 'primary' : 'secondary'} onPress={() => setStatus($, a.id, 'right')} />
        <Button key={`wrong-${a.id}`} label="Wrong" variant={a.status === 'wrong' ? 'primary' : 'secondary'} onPress={() => setStatus($, a.id, 'wrong')} />
        <Button key={`change-${a.id}`} label="Change…" variant={a.status === 'changed' ? 'primary' : 'secondary'} onPress={() => update($, editing, () => a.id)} />
      </Box>
      )
    const footer = (
      <Box key="footer" gap={1} marginBottom={1}>
        {openCount > 0 && <Button key="allright" label="All right" onPress={allRight} />}
        {undoable && <Button key="undo" label={`Undo ${label(undoable)} ${NAME[undoable.status].toLowerCase()}`} onPress={() => undoVerdict($)} />}
        {unsent > 0 && <Text dimColor>{unsent} verdict{unsent === 1 ? '' : 's'} reach Claude with its next step or your next prompt</Text>}
      </Box>
    )

    if ('Svg' in els && e.surface !== 'terminal') {
      const { Svg } = els
      const theme = (await $.config.list().catch(() => [])).find(r => r.key === 'theme')?.value
      const P = /light/i.test(String(theme)) ? LIGHT : DARK
      const W = Math.max(280, Math.min(1000, e.props.bodyColumns * 8))
      const item = (key: string, d: Drawn) => (
        <Box key={key} marginBottom={1}>
          <Svg source={d.svg} alt={d.alt} />
        </Box>
      )
      return (
        <Box flexDirection="column">
          {item('head', headCard(P, list, W))}
          {shown.length === 0 && item('empty', emptyCard(P, W, list.length > 0))}
          {footer}
          {[...shown].reverse().map(a => (
            <Box key={`a-${a.id}`} flexDirection="column">
              {item(`card-${a.id}`, itemCard(P, a, open.includes(a.id), W))}
              {actions(a)}
            </Box>
          ))}
        </Box>
      )
    }

    // Terminal: plain text rows, same buttons.
    const mark: Record<Status, string> = { open: '◇', right: '✓', wrong: '✗', changed: '✎' }
    const color: Record<Status, string> = { open: '#ffa348', right: '#8ff0a4', wrong: '#f66151', changed: '#99c1f1' }
    return (
      <Box flexDirection="column" width={e.props.bodyColumns} paddingX={1} minHeight={e.props.scroll.bodyRows} backgroundColor="#1d1d20">
        <Text bold>Assumptions</Text>
        <Text dimColor>
          {list.length} made · {openCount} to review
        </Text>
        {shown.length === 0 && <Text dimColor>{list.length > 0 ? 'All reviewed.' : 'No assumptions yet.'}</Text>}
        {footer}
        {[...shown].reverse().map(a => (
          <Box key={`a-${a.id}`} flexDirection="column" marginBottom={1}>
            <Box>
              <Box width={2} flexShrink={0}>
                <Text color={color[a.status]}>{mark[a.status]}</Text>
              </Box>
              <Box flexShrink={1} flexDirection="column">
                <Text wrap="wrap">
                  <Text bold>{label(a)}</Text> {a.text}
                </Text>
                {a.status === 'changed' && a.correction && <Text color={color.changed} wrap="wrap">→ {a.correction}</Text>}
                {open.includes(a.id) && a.why && <Text dimColor wrap="wrap">why: {a.why}</Text>}
                {open.includes(a.id) && a.alternative && <Text dimColor wrap="wrap">instead: {a.alternative}</Text>}
              </Box>
            </Box>
            {actions(a)}
          </Box>
        ))}
      </Box>
    )
  })
}
