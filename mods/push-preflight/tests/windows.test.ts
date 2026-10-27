import { expect, test } from 'claude-code/testing'

import { isPush, isWindowsPath, shimArgv } from '../hooks/register'

const slashed = (p: string) => p.replaceAll('\\', '/')

test('npm is started through cmd.exe on Windows only', () => {
  expect(isWindowsPath('C:\\Users\\me\\fe')).toBe(true)
  expect(isWindowsPath('d:/fe')).toBe(true)
  expect(isWindowsPath('/fe')).toBe(false)
  expect(shimArgv(['npm', 'run', '-s', 'lint'], true)).toEqual(['cmd.exe', '/d', '/c', 'npm', 'run', '-s', 'lint'])
  expect(shimArgv(['npm', 'run', '-s', 'lint'], false)).toEqual(['npm', 'run', '-s', 'lint'])
  expect(isPush('cd C:\\repo; git push origin feat')).toBe(true)
})

test('on a C:\\ folder the checks run through cmd.exe, and a push from PowerShell is checked too', async ($, on) => {
  on('session.cwd', () => ({ value: 'C:\\Users\\me\\fe' }))
  const paths: string[] = []
  on('fs.read', ($, e) => {
    paths.push((e as unknown as { path: string }).path)
    return { value: '{"scripts":{"lint":"eslint .","typecheck":"tsc"}}' } as never
  })
  on('fs.exists', ($, e) => {
    paths.push((e as unknown as { path: string }).path)
    return { value: true } as never
  })
  const runs: unknown[] = []
  on('process.run', ($, e) => {
    const { argv, init } = e as unknown as { argv: string[]; init?: { cwd?: string } }
    runs.push({ argv, cwd: slashed(init?.cwd ?? '') })
    const failed = argv.at(-1) === 'typecheck'
    return { value: { exitCode: failed ? 2 : 0, stdout: failed ? 'a.ts(1,1): error TS2304\r\nFound 1 error.\r\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  let pushed = false
  on('tool.call', () => {
    pushed = true
    return { result: 'ok' }
  })
  const r = await $.tool.call({ tool: 'PowerShell', command: 'git push origin feat' } as never)
  // The engine hands fs hooks the native form of the path, so compare without slash direction.
  expect(paths.map(slashed)).toEqual(['C:/Users/me/fe/package.json', 'C:/Users/me/fe/node_modules'])
  expect(runs).toEqual([
    { argv: ['cmd.exe', '/d', '/c', 'npm', 'run', '-s', 'lint'], cwd: 'C:/Users/me/fe' },
    { argv: ['cmd.exe', '/d', '/c', 'npm', 'run', '-s', 'typecheck'], cwd: 'C:/Users/me/fe' },
  ])
  expect(pushed).toBe(false)
  // CRLF output is split into lines, so the tail reads cleanly.
  expect(JSON.stringify(r)).toContain('error TS2304\\nFound 1 error.')
})
