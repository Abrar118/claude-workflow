import type { Register } from 'claude-code'

export const register: Register = on => {
  let startedAt = 0
  let costAtStart = 0
  let tools = 0
  const costs: number[] = []

  // Clears the status line entry older versions wrote; the line now shows in the prompt-deck band.
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    startedAt = await $.clock.now()
    costAtStart = (await $.session.usage()).cost?.usd ?? 0
    tools = 0
    return next(e)
  })

  // Subagent loops fire tool.call and turn.complete too (agentId set); only the main loop is measured.
  on('tool.call', ($, e, next) => {
    if (!e.agentId) tools += 1
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId || !startedAt) return next(e)
    const secs = Math.round(((await $.clock.now()) - startedAt) / 1000)
    const cost = Math.max(0, ((await $.session.usage()).cost?.usd ?? 0) - costAtStart)
    const avg = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0
    costs.push(cost)
    if (costs.length > 20) costs.shift()
    const time = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`
    await $.state.set({ plugin: 'turn-meter', key: 'last' } as const, `${time} · ${tools} tools · ≈$${cost.toFixed(2)}`)
    if (costs.length > 3 && cost > 0.5 && cost > avg * 2.5) {
      $.ui.toast(`That turn cost ≈$${cost.toFixed(2)}, ${(cost / avg).toFixed(1)}x your average`)
    }
    startedAt = 0
    return next(e)
  })
}
