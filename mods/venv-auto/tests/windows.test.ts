import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { activated, dirOf, needsVenv } from '../hooks/register'

// The engine hands fs hooks the path in the platform's own spelling, so venvs are compared with forward slashes.
const slashed = (p: string) => p.replaceAll('\\', '/')

/** Venv activate scripts on disk; records each probe and the command that ran. */
function world(on: On, cwd: string, scripts: string[]) {
  const probes: string[] = []
  const ran = { command: '' }
  on('session.cwd', () => ({ value: cwd }))
  on('fs.exists', ($, e) => {
    const path = slashed((e as unknown as { path: string }).path)
    probes.push(path)
    return { value: scripts.includes(path) } as never
  })
  on('tool.call', ($, e) => {
    ran.command = (e as unknown as { command: string }).command
    return { result: 'ok' }
  })
  return { probes, ran }
}

test('Windows venvs and PowerShell activation count as set up; py and jupyter need one', () => {
  expect(needsVenv('cd code; py -3 -m pytest')).toBe(true)
  expect(needsVenv('jupyter lab')).toBe(true)
  expect(needsVenv('source .venv/Scripts/activate && python x.py')).toBe(false)
  expect(needsVenv('& .venv\\Scripts\\Activate.ps1; python x.py')).toBe(false)
  expect(needsVenv('.venv\\Scripts\\python x.py')).toBe(false)
  expect(needsVenv('cd app && .venv/Scripts/python.exe -m pytest')).toBe(false)
  expect(needsVenv('pyright src')).toBe(false)
})

test('a leading cd names the folder on Windows, in Git Bash and in PowerShell', () => {
  expect(dirOf('python x.py', 'C:\\thesis\\')).toBe('C:/thesis')
  expect(dirOf('cd code && python x.py', 'C:\\thesis')).toBe('C:/thesis/code')
  expect(dirOf('cd C:\\work\\app && pytest', 'C:\\x')).toBe('C:/work/app')
  expect(dirOf('cd /c/work/app && pytest', 'C:\\x')).toBe('C:/work/app')
  expect(dirOf('cd "C:\\My Projects\\app" && pytest', 'C:\\x')).toBe('C:/My Projects/app')
  expect(dirOf("cd 'sub dir'; python x.py", 'C:\\x')).toBe('C:/x/sub dir')
  expect(dirOf('Set-Location app; python x.py', 'C:\\x')).toBe('C:/x/app')
  expect(dirOf('Set-Location -Path ..\\app; pytest', 'C:\\x\\y')).toBe('C:/x/app')
  expect(dirOf('cd ~\\proj; python x.py', 'C:\\x', 'C:\\Users\\me')).toBe('C:/Users/me/proj')
  // On macOS and Linux a /c/ folder is just a folder.
  expect(dirOf('cd /c/work && pytest', '/home/me')).toBe('/c/work')
})

test('the activate step is written in each shell, with the path single-quoted', () => {
  expect(activated('Bash', 'C:/p/.venv/Scripts/activate', 'pytest')).toBe("source 'C:/p/.venv/Scripts/activate' && pytest")
  expect(activated('PowerShell', 'C:/p/.venv/Scripts/Activate.ps1', 'pytest')).toBe("& 'C:\\p\\.venv\\Scripts\\Activate.ps1'; pytest")
  expect(activated('PowerShell', '/p/.venv/bin/Activate.ps1', 'pytest')).toBe("& '/p/.venv/bin/Activate.ps1'; pytest")
  // PowerShell runs nothing inside single quotes; a quote in the name (straight or curly) is doubled.
  expect(activated('PowerShell', `C:/w/x$(calc)'q’r/.venv/Scripts/Activate.ps1`, 'pytest')).toBe(`& 'C:\\w\\x$(calc)''q’’r\\.venv\\Scripts\\Activate.ps1'; pytest`)
})

test('on a C:\\ folder a Git Bash command gets the Scripts venv with a forward-slash path', async ($, on) => {
  const { ran } = world(on, 'C:\\Users\\me\\thesis\\code\\src', ['C:/Users/me/thesis/code/.venv/Scripts/activate'])
  await $.tool.call({ tool: 'Bash', command: 'python train.py' } as never)
  expect(ran.command).toBe("source 'C:/Users/me/thesis/code/.venv/Scripts/activate' && python train.py")
  await $.tool.call({ tool: 'Bash', command: 'cd /c/Users/me/thesis/code && pytest -q' } as never)
  expect(ran.command).toBe("source 'C:/Users/me/thesis/code/.venv/Scripts/activate' && cd /c/Users/me/thesis/code && pytest -q")
})

test('on a C:\\ folder a PowerShell command runs Activate.ps1 first', async ($, on) => {
  const { ran } = world(on, 'C:\\Users\\me\\thesis\\code', ['C:/Users/me/thesis/code/.venv/Scripts/Activate.ps1'])
  await $.tool.call({ tool: 'PowerShell', command: 'pytest -q' } as never)
  expect(ran.command).toBe("& 'C:\\Users\\me\\thesis\\code\\.venv\\Scripts\\Activate.ps1'; pytest -q")
})

test('a cd to ~ in PowerShell finds the venv under USERPROFILE', async ($, on) => {
  mock.env(on, { USERPROFILE: 'C:\\Users\\me' })
  const { ran } = world(on, 'C:\\work', ['C:/Users/me/proj/.venv/Scripts/Activate.ps1'])
  await $.tool.call({ tool: 'PowerShell', command: 'cd ~\\proj; python -m pytest' } as never)
  expect(ran.command).toBe("& 'C:\\Users\\me\\proj\\.venv\\Scripts\\Activate.ps1'; cd ~\\proj; python -m pytest")
})

test('no venv nearby: the command runs as written, and the walk stops at the drive root', async ($, on) => {
  const { probes, ran } = world(on, 'C:\\a\\b', [])
  await $.tool.call({ tool: 'Bash', command: 'python x.py' } as never)
  expect(ran.command).toBe('python x.py')
  expect(probes).toEqual(['C:/a/b/.venv/Scripts/activate', 'C:/a/b/.venv/bin/activate', 'C:/a/.venv/Scripts/activate', 'C:/a/.venv/bin/activate', 'C:/.venv/Scripts/activate', 'C:/.venv/bin/activate'])
})
