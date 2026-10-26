import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Git, Pr } from '../types'

const lastTurnAt = atom({ plugin: 'prompt-deck', key: 'lastTurnAt' } as const, 0)
const now = atom({ plugin: 'prompt-deck', key: 'now' } as const, 0)
const hint = atom({ plugin: 'prompt-deck', key: 'hint' } as const, '')
const git = atom({ plugin: 'prompt-deck', key: 'git' } as const, null as Git)
const compactAt = atom({ plugin: 'prompt-deck', key: 'compactAt' } as const, null as number | null)
const pr = atom({ plugin: 'prompt-deck', key: 'pr' } as const, null as Pr)

const PANE = 'limits'
const PANE_OPEN = { id: PANE, title: 'Usage & cache', focus: true, closeOnEscape: true } as const

// Colors follow the Kitty theme (~/.config/kitty/current-theme.conf).
const C = {
  ok: '#8ff0a4',
  warn: '#ffa348',
  bad: '#f66151',
  git: '#dc8add',
  info: '#99c1f1',
  next: '#ff7800',
  muted: '#9a9996',
  edge: '#4f4f4f',
} as const

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
const bar = (pct: number, w: number) => {
  const f = Math.max(0, Math.min(w, Math.round((pct / 100) * w)))
  return '▰'.repeat(f) + '▱'.repeat(w - f)
}
const tone = (pct: number) => (pct >= 85 ? C.bad : pct >= 60 ? C.warn : C.ok)
const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

// `git status --porcelain=v2 --branch` -> branch, upstream, ahead/behind, and the files by kind.
export const parseGit = (out: string): Git => {
  const g = { branch: '', ahead: 0, behind: 0, hasUpstream: false, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) g.branch = line.slice(14).trim()
    else if (line.startsWith('# branch.upstream ')) g.hasUpstream = true
    else if (line.startsWith('# branch.ab ')) {
      const [a = '', b = ''] = line.slice(12).trim().split(' ')
      g.ahead = Number(a.slice(1)) || 0
      g.behind = Number(b.slice(1)) || 0
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      if (line[2] !== '.') g.staged += 1
      if (line[3] !== '.') g.unstaged += 1
    } else if (line.startsWith('u ')) g.conflicts += 1
    else if (line.startsWith('? ')) g.untracked += 1
  }
  return g.branch ? g : null
}

const dirtyOf = (g: NonNullable<Git>): number => g.staged + g.unstaged + g.untracked + g.conflicts

async function refreshGit($: EngineInterface) {
  const cwd = await $.session.cwd()
  const r = await $.process.run(['git', '--no-optional-locks', '-C', cwd, 'status', '--porcelain=v2', '--branch']).catch(() => null)
  const value = r && r.exitCode === 0 ? parseGit(r.stdout) : null
  await update($, git, () => value)
}

// The branch's open PR and review state, the same lookup as the status line. Slow (network), so after turns only.
export const parsePr = (json: string): Pr => {
  try {
    const p = JSON.parse(json) as { number?: number; state?: string; reviewDecision?: string }
    if (p.state !== 'OPEN' || !p.number) return null
    return { number: p.number, review: (p.reviewDecision || 'open').toLowerCase().replace(/_/g, ' ') }
  } catch {
    return null
  }
}

async function refreshPr($: EngineInterface) {
  const r = await $.process.run(['gh', 'pr', 'view', '--json', 'number,state,reviewDecision'], { cwd: await $.session.cwd(), timeoutMs: 8000 }).catch(() => null)
  const value = r && r.exitCode === 0 ? parsePr(r.stdout) : null
  await update($, pr, () => value)
}

/** The Linear issue a branch names (`RB-319`, `feature/rb-12-login`), upper-cased. */
export const issueOf = (branch: string): string => /\bRB-\d+/i.exec(branch)?.[0].toUpperCase() ?? ''

async function refreshCompactAt($: EngineInterface) {
  const u = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
  const at = u?.context.breakdown?.autoCompactThreshold ?? null
  await update($, compactAt, () => at)
}

// The git row's parts, in order: files by kind (or clean), then where the branch stands against its upstream.
const gitParts = (g: NonNullable<Git>, c: { ok: string; warn: string; bad: string; info: string; muted: string }, p: Pr = null): [string, string, boolean][] => [
  // The issue only when the branch is not just its name (RB-319 already says it).
  ...(issueOf(g.branch) && issueOf(g.branch) !== g.branch.toUpperCase() ? [[issueOf(g.branch), c.info, true] as [string, string, boolean]] : []),
  ...(p ? [[`PR #${p.number} ${p.review}`, p.review === 'approved' ? c.ok : p.review === 'changes requested' ? c.bad : c.warn, true] as [string, string, boolean]] : []),
  ...(dirtyOf(g) === 0 ? [['✓ clean', c.muted, false] as [string, string, boolean]] : []),
  ...(g.conflicts ? [[`✖ ${g.conflicts} conflict`, c.bad, true] as [string, string, boolean]] : []),
  ...(g.staged ? [[`+${g.staged} staged`, c.ok, true] as [string, string, boolean]] : []),
  ...(g.unstaged ? [[`~${g.unstaged} unstaged`, c.warn, true] as [string, string, boolean]] : []),
  ...(g.untracked ? [[`?${g.untracked} untracked`, c.warn, true] as [string, string, boolean]] : []),
  !g.hasUpstream
    ? ['no upstream', c.muted, false]
    : g.ahead || g.behind
      ? [`↑${g.ahead} ↓${g.behind}`, c.info, true]
      : ['⇅ up to date', c.muted, false],
]


// --- desktop card: the four rows drawn as one SVG in Claude's palette (flat color, warm neutrals, clay accent).
// The buttons stay native, under it.

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

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Text is cut by an estimated width: the SVG cannot measure it.
const fit = (s: string, px: number, size: number): string => {
  const max = Math.max(4, Math.floor(px / (size * 0.58)))
  return esc(s.length > max ? s.slice(0, max - 1) + '…' : s)
}

const deckCard = (
  P: Palette,
  W: number,
  d: {
    meters: [string, number][]
    cost?: number
    cache: { color: string; pct: number | null; text: string; isLoud: boolean }
    repo: Git
    pr: Pr
    suggestion: string
    waiting: string
  },
): Drawn => {
  const tone = (pct: number) => (pct >= 85 ? P.fig : pct >= 60 ? P.gold : P.olive)
  const X = 78
  const rows = 3 + (d.repo ? 1 : 0)
  const H = 14 + rows * 26 + 4
  let y = 28
  let out = `<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="14" fill="${P.card}" stroke="${P.line}" stroke-width="1.5"/>`
  const label = (name: string, color: string) =>
    `<circle cx="20" cy="${y - 4}" r="3.5" fill="${color}"/><text x="30" y="${y}" font-size="11.5" fill="${P.muted}">${name}</text>`
  const pill = (x: number, text: string, color: string, filled: boolean) => {
    const w = Math.round(text.length * 6.3 + 20)
    return [
      `<rect x="${x}" y="${y - 14}" width="${w}" height="20" rx="10" fill="${color}" fill-opacity="${filled ? 0.18 : 0.12}"/>` +
        `<text x="${x + 10}" y="${y}" font-size="11" font-weight="600" fill="${color}">${esc(text)}</text>`,
      w,
    ] as const
  }
  const alt: string[] = []

  // usage
  const costText = d.cost === undefined ? '' : `$${d.cost.toFixed(2)}`
  const costW = costText ? Math.round(costText.length * 6.3 + 20) : 0
  const segW = (W - 16 - costW - 8 - X) / Math.max(1, d.meters.length)
  out += label('usage', P.clay)
  d.meters.forEach(([name, pct], i) => {
    const sx = X + i * segW
    const bw = Math.max(20, segW - 26 - 52)
    out +=
      `<text x="${sx}" y="${y}" font-size="11" fill="${P.muted}">${name}</text>` +
      `<rect x="${sx + 26}" y="${y - 8}" width="${bw}" height="7" rx="3.5" fill="${P.well}"/>` +
      (pct > 0 ? `<rect x="${sx + 26}" y="${y - 8}" width="${Math.max(7, (bw * Math.min(100, pct)) / 100)}" height="7" rx="3.5" fill="${tone(pct)}"/>` : '') +
      `<text x="${sx + 26 + bw + 6}" y="${y}" font-size="11.5" font-weight="700" fill="${tone(pct)}">${Math.round(pct)}%</text>`
    alt.push(`${name} ${Math.round(pct)}%`)
  })
  if (costText) out += pill(W - 16 - costW, costText, P.muted, false)[0]
  y += 26

  // cache
  out += label('cache', d.cache.color)
  let cx = X
  if (d.cache.pct !== null) {
    out +=
      `<rect x="${X}" y="${y - 8}" width="110" height="7" rx="3.5" fill="${P.well}"/>` +
      `<rect x="${X}" y="${y - 8}" width="${Math.max(7, (110 * d.cache.pct) / 100)}" height="7" rx="3.5" fill="${d.cache.color}"/>`
    cx += 120
  }
  out += `<text x="${cx}" y="${y}" font-size="12" font-weight="${d.cache.isLoud ? 700 : 500}" fill="${d.cache.isLoud ? d.cache.color : P.muted}">${fit(d.cache.text, W - cx - 16, 12)}</text>`
  alt.push(`cache ${d.cache.text}`)
  y += 26

  // git
  if (d.repo) {
    out += label('git', P.heather)
    const branch = fit(d.repo.branch, 150, 12.5)
    out += `<text x="${X}" y="${y}" font-size="12.5" font-weight="700" fill="${P.heather}">${branch}</text>`
    let gx = X + Math.min(150, Math.round(d.repo.branch.length * 7.3)) + 12
    const parts = gitParts(d.repo, { ok: P.olive, warn: P.gold, bad: P.fig, info: P.sky, muted: P.muted }, d.pr)
    for (const [text, color, loud] of parts) {
      const [svg, w] = pill(gx, text, color, loud)
      if (gx + w > W - 16) break
      out += svg
      gx += w + 6
    }
    alt.push(`git ${d.repo.branch}, ${parts.map(p => p[0].replace(/^[✓✖⇅] /, '')).join(', ')}`)
    y += 26
  }

  // next
  out += label('next', P.clay)
  out += d.suggestion
    ? `<text x="${X}" y="${y}" font-family="${SERIF}" font-size="14" font-style="italic" fill="${P.text}">${fit(d.suggestion, W - X - 16, 14)}</text>`
    : `<text x="${X}" y="${y}" font-size="12" fill="${P.muted}">${esc(d.waiting)}</text>`
  alt.push(`next ${d.suggestion || d.waiting}`)

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${SANS}">${out}</svg>`,
    alt: alt.join('. ') + '.',
  }
}

// The /limits pane as cards: plan limits, cache, context, each with its own meters.
const limitsCards = (
  P: Palette,
  W: number,
  d: {
    limits: { name: string; pct: number; note: string }[]
    cache: { name: string; pct: number; note: string; color: string }
    context: { tokens: string; window: string; pct: number }
    cats: { name: string; pct: number; tokens: string }[]
    cost?: number
    headline: string
  },
): Drawn[] => {
  const tone = (pct: number) => (pct >= 85 ? P.fig : pct >= 60 ? P.gold : P.olive)
  const ground = (H: number) =>
    `<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="14" fill="${P.card}" stroke="${P.line}" stroke-width="1.5"/>`
  const title = (name: string, color: string, right = '') =>
    `<circle cx="22" cy="26" r="4" fill="${color}"/>` +
    `<text x="34" y="31" font-family="${SERIF}" font-size="16" font-weight="600" fill="${P.text}">${esc(name)}</text>` +
    (right ? `<text x="${W - 16}" y="31" font-size="12" text-anchor="end" fill="${P.muted}">${esc(right)}</text>` : '')
  // One labelled meter: name left, note right, bar under it with the percent beside it.
  const meter = (y: number, name: string, note: string, pct: number, color: string) => {
    const bw = W - 32 - 46
    const v = Math.max(0, Math.min(100, pct))
    return (
      `<text x="16" y="${y}" font-size="13" font-weight="600" fill="${P.text}">${fit(name, W / 2 - 16, 13)}</text>` +
      (note ? `<text x="${W - 16}" y="${y}" font-size="11.5" text-anchor="end" fill="${P.muted}">${fit(note, W / 2 - 16, 11.5)}</text>` : '') +
      `<rect x="16" y="${y + 9}" width="${bw}" height="8" rx="4" fill="${P.well}"/>` +
      (v > 0 ? `<rect x="16" y="${y + 9}" width="${Math.max(8, (bw * v) / 100)}" height="8" rx="4" fill="${color}"/>` : '') +
      `<text x="${W - 16}" y="${y + 17}" font-size="12" font-weight="700" text-anchor="end" fill="${color}">${Math.round(pct)}%</text>`
    )
  }
  const mk = (H: number, body: string, alt: string): Drawn => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${SANS}">${ground(H)}${body}</svg>`,
    alt,
  })
  const out: Drawn[] = []

  const costPill = d.cost === undefined ? '' : `$${d.cost.toFixed(2)}`
  const pw = Math.round(costPill.length * 6.3 + 20)
  out.push(
    mk(
      72,
      `<text x="16" y="34" font-family="${SERIF}" font-size="20" font-weight="600" fill="${P.text}">Usage &amp; cache</text>` +
        `<text x="16" y="54" font-size="12" fill="${P.muted}">${esc(d.headline)}</text>` +
        (costPill
          ? `<rect x="${W - 16 - pw}" y="16" width="${pw}" height="22" rx="11" fill="${P.muted}" fill-opacity="0.16"/>` +
            `<text x="${W - 16 - pw / 2}" y="31" font-size="12" font-weight="600" text-anchor="middle" fill="${P.muted}">${costPill}</text>`
          : ''),
      `Usage and cache. ${d.headline}${costPill ? ` Session cost ${costPill}.` : ''}`,
    ),
  )

  if (d.limits.length === 0) {
    out.push(mk(76, title('Plan limits', P.clay) + `<text x="16" y="58" font-size="12" fill="${P.muted}">No reading yet. Send a prompt first.</text>`, 'Plan limits: no reading yet.'))
  } else {
    out.push(
      mk(
        48 + d.limits.length * 46,
        title('Plan limits', P.clay) + d.limits.map((r, i) => meter(60 + i * 46, r.name, r.note, r.pct, tone(r.pct))).join(''),
        `Plan limits: ${d.limits.map(r => `${r.name} ${Math.round(r.pct)}%${r.note ? `, ${r.note}` : ''}`).join('; ')}.`,
      ),
    )
  }

  out.push(
    mk(
      96,
      title('Cache', d.cache.color) + meter(60, d.cache.name, d.cache.note, d.cache.pct, d.cache.color),
      `Cache: ${d.cache.name}, ${d.cache.note}.`,
    ),
  )

  const hues = [P.clay, P.sky, P.olive, P.heather, P.gold, P.fig]
  out.push(
    mk(
      48 + 46 + d.cats.length * 38,
      title('Context', P.sky, `${d.context.tokens} of ${d.context.window}`) +
        meter(60, 'Window', '', d.context.pct, tone(d.context.pct)) +
        d.cats.map((c, i) => meter(112 + i * 38, c.name, c.tokens, c.pct, hues[i % hues.length]!)).join(''),
      `Context: ${d.context.tokens} of ${d.context.window}, ${Math.round(d.context.pct)}%. ${d.cats.map(c => `${c.name} ${c.tokens}`).join(', ')}.`,
    ),
  )
  return out
}

export const register: Register = (on, options) => {
  const TTL = (Number(options.cacheTtlMinutes) || 60) * 60_000
  // Warn 10 minutes out, or halfway on a short cache.
  const WARN = Math.min(10 * 60_000, TTL / 2)

  on('session.start', async ($, e, next) => {
    await refreshGit($)
    await refreshCompactAt($)
    void refreshPr($)
    // Picks up git changes made outside Claude.
    $.clock.every(15_000, () => refreshGit($))
    await $.command.register({ name: 'limits', description: 'Usage, limits, cache and context breakdown' })
    $.clock.every(5_000, async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
      const last = await read($, lastTurnAt)
      const left = TTL - (t - last)
      // Kept in $.store so a hot reload doesn't toast again for the same turn.
      if (last && left > 0 && left <= WARN && (await $.store.get('cacheWarnedFor')) !== last) {
        await $.store.set('cacheWarnedFor', last)
        $.ui.toast(`Cache goes cold in ~${Math.round(left / 60_000)} min. Compact now (c in the band) if you're stepping away.`)
      }
    })
    return next(e)
  })

  on('command.run', { command: 'limits' }, async $ => {
    await $.ui.open(PANE_OPEN)
    return { text: 'Usage pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, hint, () => '')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn doesn't keep the main conversation's cache warm.
    if (e.agentId) return next(e)
    const t = await $.clock.now()
    await update($, lastTurnAt, () => t)
    await refreshGit($)
    await refreshCompactAt($)
    void refreshPr($)
    return next(e)
  })

  // Claude Code's own next-prompt guess: shown in the band at no cost to the limits.
  on('prompt.suggest', async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind === 'suggestion') await update($, hint, () => e.text.trim())
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const t = await read($, now)
    const last = await read($, lastTurnAt)
    const suggestion = await read($, hint)
    const repo = await read($, git)
    const limit = await read($, compactAt)
    const prNow = await read($, pr)
    const u = await $.session.usage()
    // Written by the turn-meter mod after each turn.
    const turn = ((await $.state.get({ plugin: 'turn-meter', key: 'last' } as never).catch(() => null)) as { value?: string } | null)?.value
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // Terminal: draw `c: Compact` so the key to press is visible.
    const keyed = e.surface === 'terminal' ? (true as const) : undefined

    const wide = e.props.bodyColumns >= 100
    const roomy = e.props.maxRows >= 8
    const W = wide ? 8 : 5

    // Measured against auto-compact when the engine gives it, so 100% is where compaction starts.
    const ctx = limit && u.context.tokens !== undefined ? Math.min(100, (u.context.tokens / limit) * 100) : (u.context.percent ?? 0)
    const lim = (k: string) => u.rateLimits.find(r => r.kind === k)?.percentUsed
    const meters: [string, number | undefined][] = [['ctx', ctx], ['5h', lim('five_hour')], ['wk', lim('seven_day')]]

    const left = last && t ? TTL - (t - last) : 0
    const isHot = last > 0 && left > 0 && left <= WARN
    const isCold = last > 0 && left <= 0
    const cacheColor = !last ? C.muted : isCold ? C.bad : isHot ? C.warn : C.ok
    const cacheLabel = !last ? 'unknown until next reply' : isCold ? 'cold · next prompt resends everything' : isHot ? `${mmss(left)} left · compact now if you're stepping away` : `warm · ${mmss(left)} left`

    // The terminal's table names Svg too but cannot draw it; every other surface can.
    if ('Svg' in els && e.surface !== 'terminal') {
      const { Svg } = els
      const theme = (await $.config.list().catch(() => [])).find(r => r.key === 'theme')?.value
      const P = /light/i.test(String(theme)) ? LIGHT : DARK
      const card = deckCard(P, Math.max(300, Math.min(760, e.props.bodyColumns * 8)), {
        meters: meters.filter((m): m is [string, number] => m[1] !== undefined),
        cost: u.cost?.usd,
        cache: {
          color: cacheColor === C.ok ? P.olive : cacheColor === C.warn ? P.gold : cacheColor === C.bad ? P.fig : P.muted,
          pct: last > 0 && !isCold ? (left / TTL) * 100 : null,
          text: cacheLabel,
          isLoud: isHot || isCold,
        },
        repo,
        pr: prNow,
        suggestion,
        waiting: e.props.isWorking ? 'thinking after this turn…' : 'appears after the next reply',
      })
      return (
        <Box flexDirection="column">
          <Svg source={card.svg} alt={card.alt} />
          {turn && <Text color={C.muted}>⏱ last turn {turn}</Text>}
          <Box gap={1} marginTop={1}>
            <Button key="compact" label="Compact" hotkey="c" variant={isHot || ctx >= 85 ? 'primary' : 'secondary'}
              onPress={async () => {
                $.ui.toast('Compacting...')
                await $.session.compact()
                await update($, lastTurnAt, () => 0)
              }} />
            <Button key="details" label="Details" hotkey="d" onPress={() => $.ui.open(PANE_OPEN)} />
            {repo && (dirtyOf(repo) > 0 || repo.ahead > 0) && !e.props.isWorking && (
              <Button key="ship" label={dirtyOf(repo) ? 'Commit & push' : 'Push'} hotkey="g"
                onPress={() => $.prompt.submit({ text: dirtyOf(repo) ? 'commit and push' : 'push' })} />
            )}
            {suggestion && !e.props.isWorking && (
              <Button key="send" label="Send" hotkey="s" onPress={() => $.prompt.submit({ text: suggestion })} />
            )}
            {suggestion && !e.props.isWorking && (
              <Button key="edit" label="Edit" hotkey="e" onPress={() => $.prompt.fill({ text: suggestion })} />
            )}
          </Box>
        </Box>
      )
    }

    const Label = ({ icon, text, color }: { icon: string; text: string; color: string }) => (
      <Box width={9} flexShrink={0}>
        <Text color={color}>{icon} </Text>
        <Text color={C.muted}>{text}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" borderStyle={roomy ? 'round' : undefined} borderColor={C.edge} paddingX={roomy ? 1 : 0}>
        <Box>
          <Label icon="◔" text="usage" color={tone(Math.max(...meters.map(([, p]) => p ?? 0)))} />
          {meters.map(([name, pct]) =>
            pct === undefined ? null : (
              <Box key={name} marginRight={2}>
                <Text color={C.muted}>{name} </Text>
                <Text color={tone(pct)}>{bar(pct, W)} </Text>
                <Text color={tone(pct)} bold>{Math.round(pct)}%</Text>
              </Box>
            ),
          )}
          {u.cost && <Text color={C.muted}>· ${u.cost.usd.toFixed(2)}</Text>}
        </Box>

        {turn && (
          <Box>
            <Label icon="⏱" text="turn" color={C.muted} />
            <Text color={C.muted}>{turn}</Text>
          </Box>
        )}

        <Box justifyContent="space-between">
          <Box>
            <Label icon="◷" text="cache" color={cacheColor} />
            <Text color={cacheColor}>● </Text>
            {last > 0 && !isCold && <Text color={cacheColor}>{bar((left / TTL) * 100, W)} </Text>}
            <Text color={isHot || isCold ? cacheColor : C.muted}>{cacheLabel}</Text>
          </Box>
          <Box gap={1}>
            <Button
              key="compact"
              label="Compact"
              hotkey="c" plain={keyed}
              variant={isHot || ctx >= 85 ? 'primary' : 'secondary'}
              onPress={async () => {
                $.ui.toast('Compacting...')
                await $.session.compact()
                await update($, lastTurnAt, () => 0)
              }}
            />
            <Button key="details" label="Details" hotkey="d" plain={keyed} onPress={() => $.ui.open(PANE_OPEN)} />
          </Box>
        </Box>

        {repo && (
          <Box justifyContent="space-between">
            <Box>
              <Label icon="⎇" text="git" color={C.git} />
              <Text color={C.git} bold>{repo.branch}</Text>
              {gitParts(repo, C, prNow).map(([text, color], i) => (
                <Text key={`g-${i}`} color={color}>{'  '}{text}</Text>
              ))}
            </Box>
            {(dirtyOf(repo) > 0 || repo.ahead > 0) && !e.props.isWorking && (
              <Button
                key="ship"
                label={dirtyOf(repo) ? 'Commit & push' : 'Push'}
                hotkey="g" plain={keyed}
                onPress={() => $.prompt.submit({ text: dirtyOf(repo) ? 'commit and push' : 'push' })}
              />
            )}
          </Box>
        )}

        <Box justifyContent="space-between">
          <Box flexShrink={1}>
            <Label icon="✦" text="next" color={C.next} />
            {suggestion ? (
              <Text italic wrap="truncate-end">{suggestion}</Text>
            ) : (
              <Text color={C.muted}>{e.props.isWorking ? 'thinking after this turn…' : 'appears after the next reply'}</Text>
            )}
          </Box>
          {suggestion && !e.props.isWorking && (
            <Box gap={1}>
              <Button key="send" label="Send" hotkey="s" plain={keyed} onPress={() => $.prompt.submit({ text: suggestion })} />
              <Button key="edit" label="Edit" hotkey="e" plain={keyed} onPress={() => $.prompt.fill({ text: suggestion })} />
            </Box>
          )}
        </Box>

        {roomy && (
          <Box marginTop={1}>
            <Text color={C.muted} dimColor>⌨ ctrl+x tab to focus · g git · c compact · d details · s/e suggestion · esc back</Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const t = await $.clock.now()
    const last = await read($, lastTurnAt)
    const u = await $.session.usage({ breakdown: 'summary' })
    const W = 16
    const resets = (iso?: string) => {
      if (!iso) return ''
      const m = Math.max(0, Math.round((Date.parse(iso) - t) / 60000))
      return m >= 60 ? `resets in ${Math.floor(m / 60)}h ${m % 60}m` : `resets in ${m}m`
    }
    const names: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', spend_limit: 'Spend' }
    const ctx = u.context.percent ?? 0
    const threshold = u.context.breakdown?.autoCompactThreshold
    const compactPct = threshold && u.context.tokens !== undefined ? Math.min(100, (u.context.tokens / threshold) * 100) : null
    const cats = [...(u.context.breakdown?.categories ?? [])].filter(c => c.tokens > 0).sort((a, b) => b.tokens - a.tokens)
    const left = last ? TTL - (t - last) : 0

    // The terminal's table names Svg too but cannot draw it; every other surface can.
    if ('Svg' in els && e.surface !== 'terminal') {
      const { Svg } = els
      const theme = (await $.config.list().catch(() => [])).find(r => r.key === 'theme')?.value
      const P = /light/i.test(String(theme)) ? LIGHT : DARK
      const W = Math.max(300, Math.min(560, e.props.bodyColumns * 8))
      const cache = !last
        ? { name: 'Unknown', pct: 0, note: 'starts after the next reply', color: P.muted }
        : left > 0
          ? { name: 'Warm', pct: (left / TTL) * 100, note: `${mmss(left)} of ${mmss(TTL)} left`, color: left <= WARN ? P.gold : P.olive }
          : { name: 'Cold', pct: 0, note: 'next prompt resends the whole conversation', color: P.fig }
      const worst = Math.max(0, ctx, ...u.rateLimits.map(r => r.percentUsed))
      const cards = limitsCards(P, W, {
        limits: u.rateLimits.map(r => ({ name: names[r.kind] ?? r.kind, pct: r.percentUsed, note: resets(r.resetsAt) })),
        cache,
        context: { tokens: kTok(u.context.tokens ?? 0), window: kTok(u.context.window), pct: ctx },
        cats: cats.slice(0, 8).map(c => ({ name: c.name, pct: (c.tokens / u.context.window) * 100, tokens: kTok(c.tokens) })),
        cost: u.cost?.usd,
        headline: worst >= 85 ? 'Something is nearly full.' : worst >= 60 ? 'Getting busy.' : 'Plenty of room.',
      })
      return (
        <Box flexDirection="column">
          {cards.map((c, i) => (
            <Box key={`c-${i}`} marginBottom={1}>
              <Svg source={c.svg} alt={c.alt} />
            </Box>
          ))}
          <Text dimColor>esc to close</Text>
        </Box>
      )
    }

    const Section = ({ title }: { title: string }) => (
      <Box marginTop={1}>
        <Text bold color={C.info}>{title}</Text>
      </Box>
    )
    const Row = ({ name, pct, note }: { name: string; pct: number; note: string }) => (
      <Box>
        <Box width={14}><Text>{name}</Text></Box>
        <Text color={tone(pct)}>{bar(pct, W)} </Text>
        <Box width={6}><Text color={tone(pct)} bold>{Math.round(pct)}%</Text></Box>
        <Text dimColor>{note}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1} width={e.props.bodyColumns} minHeight={e.props.scroll.bodyRows} backgroundColor="#1d1d20">
        <Section title="PLAN LIMITS" />
        {u.rateLimits.length === 0 && <Text dimColor>No reading yet. Send a prompt first.</Text>}
        {u.rateLimits.map(r => (
          <Row key={r.kind} name={names[r.kind] ?? r.kind} pct={r.percentUsed} note={resets(r.resetsAt)} />
        ))}

        <Section title="CACHE" />
        <Row
          name={!last ? 'Unknown' : left > 0 ? 'Warm' : 'Cold'}
          pct={last && left > 0 ? (left / TTL) * 100 : 0}
          note={!last ? 'starts after the next reply' : left > 0 ? `${mmss(left)} of ${mmss(TTL)} left` : 'next prompt resends the whole conversation'}
        />

        <Section title="CONTEXT" />
        <Row name="Window" pct={ctx} note={`${kTok(u.context.tokens ?? 0)} / ${kTok(u.context.window)}`} />
        {compactPct !== null && <Row name="Auto-compact" pct={compactPct} note={`compacts at ${kTok(threshold!)}`} />}
        {cats.map(c => (
          <Row key={c.name} name={`  ${c.name}`} pct={(c.tokens / u.context.window) * 100} note={kTok(c.tokens)} />
        ))}

        {u.cost && (
          <>
            <Section title="SESSION COST" />
            <Text>${u.cost.usd.toFixed(2)}</Text>
          </>
        )}
        <Box marginTop={1}><Text dimColor>esc to close</Text></Box>
      </Box>
    )
  })
}
