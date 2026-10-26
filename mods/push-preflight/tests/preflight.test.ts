import { expect, test } from 'claude-code/testing'

import { checksIn, isPush } from '../hooks/register'

test('pushes are recognised; dry runs and other commands are not', () => {
  expect(isPush('git push -u origin RB-12')).toBe(true)
  expect(isPush('git add . && git commit -m x && git push')).toBe(true)
  expect(isPush('git push --dry-run')).toBe(false)
  expect(isPush('git pull')).toBe(false)
  expect(checksIn('{"scripts":{"lint":"eslint .","format:check":"prettier --check .","build":"x"}}')).toEqual(['format:check', 'lint'])
  expect(checksIn('nope')).toEqual([])
})

test('a failing check blocks the push with its output', async ($, on) => {
  on('session.cwd', () => ({ value: '/fe' }))
  on('fs.read', () => ({ value: '{"scripts":{"format:check":"x","lint":"y","typecheck":"z"}}' }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  const ran: string[] = []
  on('process.run', ($, e) => {
    const check = (e as unknown as { argv: string[] }).argv[3]!
    ran.push(check)
    return { value: { exitCode: check === 'lint' ? 1 : 0, stdout: check === 'lint' ? 'src/a.ts: no-unused-vars' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  let pushed = false
  on('tool.call', () => {
    pushed = true
    return { result: 'ok' }
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(ran).toEqual(['format:check', 'lint'])
  expect(pushed).toBe(false)
  expect(JSON.stringify(r)).toMatch(/npm run lint.*failed[\s\S]*no-unused-vars/)
})
