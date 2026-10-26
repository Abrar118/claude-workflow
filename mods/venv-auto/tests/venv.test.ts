import { expect, test } from 'claude-code/testing'

import { dirOf, needsVenv } from '../hooks/register'

test('python tools get the venv; commands that set one up do not', () => {
  expect(needsVenv('python train.py')).toBe(true)
  expect(needsVenv('cd code && pytest -q')).toBe(true)
  expect(needsVenv('source .venv/bin/activate && python x.py')).toBe(false)
  expect(needsVenv('uv run python x.py')).toBe(false)
  expect(needsVenv('git status')).toBe(false)
  expect(needsVenv('echo python')).toBe(false)
})

test('a leading cd names the folder', () => {
  expect(dirOf('cd code && python x.py', '/thesis')).toBe('/thesis/code')
  expect(dirOf('cd "/a b" && pytest', '/x')).toBe('/a b')
  expect(dirOf('python x.py', '/thesis')).toBe('/thesis')
})

test('the command is prefixed with the nearest venv', async ($, on) => {
  on('session.cwd', () => ({ value: '/thesis/code/src' }))
  on('fs.exists', ($, e) => ({ value: (e as unknown as { path: string }).path === '/thesis/code/.venv/bin/activate' }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/Users/me', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  let ran = ''
  on('tool.call', ($, e) => {
    ran = (e as unknown as { command: string }).command
    return { result: 'ok' }
  })
  await $.tool.call({ tool: 'Bash', command: 'python train.py' } as never)
  expect(ran).toBe('source "/thesis/code/.venv/bin/activate" && python train.py')
})
