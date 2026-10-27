import { expect, mock, test } from 'claude-code/testing'

import { lastLines } from '../hooks/register'
import { toRelative } from '../hooks/tree'

const SCROLL = { offset: 0, bodyRows: 20 }
const PANE = {
  plugin: 'agent-panel',
  component: 'Pane',
  requestId: 'agent-panel',
  surface: 'terminal',
  props: { title: 'Activity', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: SCROLL, view: {} },
} as const

test('Windows paths are made relative with forward slashes, ignoring case; POSIX ones keep their case', () => {
  expect(toRelative('D:\\Shop\\lib\\main.dart', 'D:/shop')).toBe('lib/main.dart')
  expect(toRelative('d:/shop/lib/main.dart', 'D:\\Shop\\')).toBe('lib/main.dart')
  expect(toRelative('C:\\elsewhere\\x.txt', 'D:/shop')).toBe('C:/elsewhere/x.txt')
  expect(toRelative('/repo/src/a.py', '/repo')).toBe('src/a.py')
  expect(toRelative('/Repo/src/a.py', '/repo')).toBe('/Repo/src/a.py')
})

test('a job tail drops color codes and splits on CRLF as well as LF', () => {
  expect(lastLines('\x1b[32mepoch 1/10\x1b[0m\r\nepoch 2/10\repoch 3/10\r\n')).toEqual(['epoch 1/10', 'epoch 2/10', 'epoch 3/10'])
})

test('on Windows, PowerShell checks, background jobs and their output tail show in the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const OUTPUT = 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\tasks\\bk7.output'
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', () => ({ cwd: 'C:\\repo' }))
  on('session.cwd', () => ({ value: 'C:\\repo' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register' as never, () => ({ value: undefined }) as never)
  // No `tail` on Windows: the output is read through the engine, never by spawning it.
  const spawned: string[] = []
  on('process.run' as never, (_: unknown, e: { argv: string[] }) => {
    spawned.push(e.argv[0]!)
    return { value: { exitCode: 1, stdout: '', stderr: '' } } as never
  })
  const slashed = (p: string) => p.replace(/\\/g, '/')
  on('fs.stat' as never, (_: unknown, e: { path: string }) =>
    (slashed(e.path) === slashed(OUTPUT) ? { value: { kind: 'file', size: 40, mtimeMs: 0, isLink: false } } : { value: { kind: 'missing', size: 0, mtimeMs: 0, isLink: false } }) as never)
  on('fs.read' as never, () => ({ value: 'epoch 2/10\r\nepoch 3/10\r\n' }) as never)
  on('tool.call', { tool: 'Edit' } as never, () => ({ result: 'ok', text: 'ok' }) as never)
  on('tool.call', { tool: 'PowerShell' } as never, (_: unknown, e: { command?: string }) =>
    (e.command?.includes('pytest')
      ? { result: 'x', text: '=== 2 failed, 40 passed ===\r\nFAILED tests/a.py::test_one - boom' }
      : { result: 'x', text: `Command running in background with ID: bk7. Output is being written to: ${OUTPUT}` }) as never)
  await $.session.start({ source: 'startup', cwd: 'C:\\repo' })
  await $.turn.start({ text: 'go', turnId: 't1' } as never).catch(() => undefined)

  await $.tool.call({ tool: 'Edit', file_path: 'C:\\Repo\\src\\a.py', old_string: 'a', new_string: 'b\nc' } as never)
  await $.tool.call({ tool: 'PowerShell', command: 'pytest tests/' } as never)
  await $.tool.call({ tool: 'PowerShell', command: 'python pilot.py', run_in_background: true } as never)
  await clock.advance(4500)

  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ text: /✎ a\.py/ })).toBeDefined()
  expect(await pane.find({ text: /pytest tests\/ · 40 passed, 2 failed/ })).toBeDefined()
  expect(await pane.find({ text: /epoch 3\/10/ })).toBeDefined()
  expect(spawned).not.toContain('tail')
  await pane.unmount()
})
