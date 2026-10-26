import type { Register } from 'claude-code'

const WARN_AT = 85
const ASK_AT = 95

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const u = await $.session.usage()
    const five = u.rateLimits.find(r => r.kind === 'five_hour')
    if (!five || five.percentUsed < WARN_AT) return next(e)
    // One toast per 5h window, kept in $.store so reloads and other sessions remember it.
    // No reset time given: fall back to a fixed 5h bucket of the clock.
    const window = five.resetsAt ?? `bucket-${Math.floor((await $.clock.now()) / 18_000_000)}`
    if ((await $.store.get('warnedFor')) !== window) {
      await $.store.set('warnedFor', window)
      $.ui.toast(`5h limit at ${Math.round(five.percentUsed)}%. Switch to Sonnet to stretch it: /model sonnet`)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const u = await $.session.usage()
    const five = u.rateLimits.find(r => r.kind === 'five_hour')?.percentUsed ?? 0
    if (five < ASK_AT) return next(e)
    const answer = await $.ui.ask(`5h limit is at ${Math.round(five)}%. Subagents use a lot of tokens. Start one anyway?`, ['Run it', 'Skip']).catch(() => 'Skip')
    return answer === 'Run it' ? next(e) : { deny: `limit-guard: skipped a subagent at ${Math.round(five)}% of the 5h limit. Do the work inline instead.` }
  })
}
