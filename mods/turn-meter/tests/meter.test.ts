import { expect, mock, test } from 'claude-code/testing'

test("a turn's time, tool calls and cost are saved for the prompt-deck band", async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let usd = 1
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd } } }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  let saved: unknown
  on('state.set', ($, e, next) => {
    saved = e.value
    return next(e)
  })

  await $.prompt.submit({ text: 'go' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  await clock.advance(5000)
  usd = 1.25
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1' } as never)

  expect(saved).toBe('5s · 1 tools · ≈$0.25')
})

test("a subagent finishing doesn't end the main turn's measurement", async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: 1 } } }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const saved: unknown[] = []
  on('state.set', ($, e, next) => {
    saved.push(e.value)
    return next(e)
  })

  await $.prompt.submit({ text: 'go' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/y', agentId: 'sub1' } as never)
  await clock.advance(2000)
  await $.turn.complete({ reason: 'answer', answer: 'sub', durationMs: 2, isAborted: false, turnId: 's1', agentId: 'sub1' } as never)
  expect(saved).toEqual([])
  await clock.advance(3000)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1' } as never)
  expect(saved).toEqual(['5s · 1 tools · ≈$0.00'])
})
