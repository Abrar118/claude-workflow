import { expect, test } from 'claude-code/testing'

import { dirOf, isBarePush, isEnvFile, isProdCompose, risk } from '../hooks/register'

const git = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('PowerShell and cmd recursive deletes are caught; a single-file delete is not', () => {
  for (const c of [
    'Remove-Item -Recurse -Force C:\\proj\\build',
    "Remove-Item -LiteralPath 'C:\\proj\\out' -Recurse",
    'remove-item .\\dist -r',
    'rm .\\node_modules -Recurse -Force',
    'ri build -Recurse:$true',
    'del .\\cache -rec',
    'rmdir .\\tmp -r',
    'rd build -Recurse',
    'Get-ChildItem -Recurse -Filter *.log | Remove-Item',
    "[System.IO.Directory]::Delete('C:\\proj\\out', $true)",
    'Remove-Item .\\build `\n  -Recurse',
    'rd /s /q build',
    'rmdir /S /Q C:\\proj\\out',
    'cmd /c "rd /q/s build"',
    'del /s /q *.tmp',
  ])
    expect(risk(c)).toBe('recursive delete')
  for (const c of [
    'Remove-Item C:\\proj\\notes.txt',
    'Remove-Item .\\a.txt -Force -ErrorAction SilentlyContinue',
    'rm .\\a.txt -Force',
    'del C:\\proj\\a.txt',
    'del /q a.txt',
    'rd .\\empty',
    'Remove-Item a.txt; Get-ChildItem -Recurse',
    'Get-ChildItem -Recurse | Select-Object Name',
    'dir /s *.log',
  ])
    expect(risk(c)).toBeUndefined()
})

test('git rules see through PowerShell line continuations and Windows paths', () => {
  expect(risk('git push `\n  --force origin feat')).toBe('force push')
  expect(risk('git -C D:\\work\\app push --force origin a')).toBe('force push')
  expect(isProdCompose('cd C:\\proj; docker compose up')).toBe(true)
  expect(isProdCompose('docker compose -f .\\docker-compose-dev.yml up')).toBe(false)
})

test('.env files are guarded on either slash; templates are not', () => {
  for (const p of ['C:\\proj\\.env', 'C:\\proj\\.env.local', 'C:/proj/api/.env.production']) expect(isEnvFile(p)).toBe(true)
  for (const p of ['C:\\proj\\.env.example', 'C:\\proj\\.env.sample', 'C:\\proj\\.envrc', 'C:\\proj\\src\\env.ts']) expect(isEnvFile(p)).toBe(false)
})

test('PowerShell writes to .env files are caught; reads and templates are not', () => {
  for (const c of [
    '"A=1" > C:\\proj\\.env',
    "Set-Content .env 'A=1'",
    'Set-Content -Path C:\\proj\\.env.local -Value x',
    'Set-Content -Value x -Path ".env"',
    'Add-Content -LiteralPath .env -Value B=2',
    "'A=1' | Out-File -FilePath .env -Encoding utf8",
  ])
    expect(risk(c)).toBe('.env write')
  for (const c of ['Get-Content .env', 'Set-Content .env.sample x', 'npm test 2>&1']) expect(risk(c)).toBeUndefined()
})

test('the folder a command runs in, with Windows paths and PowerShell folder changes', () => {
  expect(dirOf('git push', 'C:/proj')).toBe('C:/proj')
  expect(dirOf('cd api && git push', 'C:/proj')).toBe('C:/proj/api')
  expect(dirOf('cd D:\\app && git push', 'C:/proj')).toBe('D:/app')
  expect(dirOf('cd /d D:\\app && git push', 'C:/proj')).toBe('D:/app')
  expect(dirOf('cd "D:/my folder" && git push', 'C:/proj')).toBe('D:/my folder')
  for (const c of ['Set-Location D:\\x; git push', 'sl D:\\x; git push', 'Push-Location D:\\x; git push', '$env:GIT_DIR = "D:\\x\\.git"; git push'])
    expect(dirOf(c, 'C:/proj')).toBeNull()
})

test('a PowerShell push reads the branch in the slash-normalised folder, and asks when it cannot tell', async ($, on) => {
  const dirs: string[] = []
  let branch: string | null = 'feat'
  let asked = 0
  on('session.cwd', () => ({ value: 'C:\\proj\\' }))
  on('process.run', ($, e) => {
    dirs.push((e as unknown as { argv: string[] }).argv[2]!)
    return branch === null ? git('', 128) : git(`${branch}\n`)
  })
  on('tool.call', ($, e) => {
    if (e.tool !== 'AskUserQuestion') return { result: 'ran' } as never
    asked++
    return { deny: 'dismissed' }
  })

  expect(JSON.stringify(await $.tool.call({ tool: 'PowerShell', command: 'cd api && git push' } as never))).toMatch(/ran/)
  expect(dirs).toEqual(['C:/proj/api'])
  branch = 'main'
  expect(JSON.stringify(await $.tool.call({ tool: 'PowerShell', command: 'git push' } as never))).toMatch(/blocked this push to main/)
  expect(isBarePush('git push')).toBe(true)
  branch = null
  expect(JSON.stringify(await $.tool.call({ tool: 'PowerShell', command: 'Set-Location D:\\x; git push' } as never))).toMatch(/could not tell which branch/)
  expect(asked).toBe(2)
})
