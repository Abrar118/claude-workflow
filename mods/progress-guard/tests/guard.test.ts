import { expect, test } from 'claude-code/testing'

const PROGRESS = 'mcp__agent-panel__progress'

test('a reminder follows every third tool call without a task list update', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const notes: (string[] | undefined)[] = []
  for (let i = 0; i < 4; i++) notes.push(((await $.tool.call({ tool: 'Bash', command: 'ls' })) as { context?: string[] }).context)
  expect(notes.map(n => n?.length ?? 0)).toEqual([0, 0, 1, 0])
  expect(notes[2]![0]).toContain('no task list')

  await $.tool.call({ tool: PROGRESS, done: 1 } as never)
  for (let i = 0; i < 2; i++) await $.tool.call({ tool: 'Bash', command: 'ls' })
  const third = (await $.tool.call({ tool: 'Bash', command: 'ls' })) as { context?: string[] }
  expect(third.context![0]).toContain('since the task list was updated')
})
