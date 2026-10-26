import { expect, mock, test } from 'claude-code/testing'

test('a subagent waits for a yes once the 5h limit is nearly spent', async ($, on) => {
  let pct = 96
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: pct }] } }) as never)
  // $.ui.ask runs AskUserQuestion; a dismissed dialog counts as Skip.
  on('tool.call', ($, e) => (e.tool === 'AskUserQuestion' ? { deny: 'dismissed' } : { result: 'ran' }))

  const skipped = await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'y', subagent_type: 'Explore' } as never)
  expect(JSON.stringify(skipped)).toMatch(/skipped a subagent at 96%/)

  pct = 50
  const ran = await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'y', subagent_type: 'Explore' } as never)
  expect(JSON.stringify(ran)).toMatch(/ran/)
})

test('the 85% toast shows once even when the limit has no reset time', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 90 }] } }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get((e as never as { key: string }).key) }) as never)
  on('store.set', ($, e) => (store.set((e as never as { key: string }).key, (e as never as { value: unknown }).value), { value: undefined }) as never)
  let toasts = 0
  on('ui.toast', () => {
    toasts++
    return { value: undefined } as never
  })
  for (const turnId of ['t1', 't2', 't3']) await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId } as never)
  expect(toasts).toBe(1)
})
