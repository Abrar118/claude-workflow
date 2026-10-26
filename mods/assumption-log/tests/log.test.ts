import { expect, mock, test } from 'claude-code/testing'

import { reviewText } from '../hooks/register'

const PANE = {
  plugin: 'assumption-log',
  component: 'Pane',
  requestId: 'assumption-log',
  props: { title: 'Assumptions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const shows = async (ui: { find: (q: { text: RegExp }) => Promise<unknown>; drawn: () => Promise<unknown> }, surface: string, re: RegExp) =>
  surface === 'terminal' ? (await ui.find({ text: re })) !== undefined : re.test(JSON.stringify(await ui.drawn()))

test('an assumption is logged, reviewed on both surfaces, and sent to Claude', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes' as never, () => ({ value: [] }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: 'ok' }))

  const logged = await $.tool.call({
    tool: 'mcp__assumption-log__assume',
    assumption: 'Dates are stored in UTC',
    why: 'No timezone was given',
    alternative: 'Store the local time',
    area: 'booking form',
  })
  expect(JSON.stringify(logged)).toMatch(/Logged as A1/)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await shows(pane, surface, /A1.*(Dates are stored in UTC|To review)/)).toBe(true)
    await pane.unmount()
  }

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'more-1' })
  expect(await shows(pane, 'desktop', /Why: No timezone was given/)).toBe(true)
  await pane.press({ key: 'wrong-1' })
  expect(await shows(pane, 'desktop', /A1 Wrong/)).toBe(true)

  // The verdict rides on the main loop's next tool result, once.
  const first = await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  expect(JSON.stringify(first)).toMatch(/A1.*wrong/)
  const second = await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  expect(JSON.stringify(second)).not.toMatch(/A1/)
  // Once Claude has heard a wrong verdict, it leaves the list.
  expect(await shows(pane, 'desktop', /A1 Wrong/)).toBe(false)
  expect(await shows(pane, 'desktop', /All reviewed/)).toBe(true)

  // A right one leaves at once, and can be undone until it is sent.
  await $.tool.call({ tool: 'mcp__assumption-log__assume', assumption: 'Use Postgres' } as never)
  await pane.press({ key: 'right-2' })
  expect(await shows(pane, 'desktop', /Use Postgres/)).toBe(false)
  await pane.press({ key: 'undo' })
  expect(await shows(pane, 'desktop', /A2 To review/)).toBe(true)

  // A correction stays until it reaches Claude with the next prompt, then leaves.
  await pane.press({ key: 'change-2' })
  await pane.input({ key: 'fix-2', text: 'Use SQLite' })
  expect(await shows(pane, 'desktop', /Use SQLite/)).toBe(true)
  await $.prompt.submit({ text: 'go on' } as never)
  expect(await shows(pane, 'desktop', /Use Postgres/)).toBe(false)
})

test('the review names right and wrong ones once', () => {
  const base = { why: '', alternative: '', area: '', correction: '', isFromAgent: false, isSent: false }
  const text = reviewText([
    { ...base, id: 1, text: 'Use SQLite', status: 'right' },
    { ...base, id: 2, text: 'Use UTC', alternative: 'local time', status: 'wrong' },
    { ...base, id: 3, text: 'Skip auth', status: 'open' },
    { ...base, id: 4, text: 'Old', status: 'right', isSent: true },
  ])
  expect(text).toMatch(/A1.*right/)
  expect(reviewText([{ ...base, id: 5, text: 'x', status: 'open', correction: '' }])).toBeNull()
  expect(text).toMatch(/A2.*wrong.*local time/)
  expect(text).not.toMatch(/A3|A4/)
})
