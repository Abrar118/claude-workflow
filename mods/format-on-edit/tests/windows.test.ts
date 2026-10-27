import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { inside, isAbsolute, prettierBin, shimArgv, toSlash } from '../hooks/register'

type Run = { argv: string[]; cwd: string }

// The engine hands fs hooks the path in the platform's own spelling, so the disk compares with forward slashes.
const slashed = (p: string) => p.replaceAll('\\', '/')

/** A disk of `files` (path → text) in session folder `cwd`, recording each formatter run and each fs.exists probe. */
function disk(on: On, files: Record<string, string>, stdout: (argv: string[]) => string, cwd: string) {
  const runs: Run[] = []
  const probes: string[] = []
  on('session.cwd', () => ({ value: cwd }))
  on('fs.exists', ($, e) => {
    const path = slashed((e as unknown as { path: string }).path)
    probes.push(path)
    return { value: path in files } as never
  })
  on('fs.read', ($, e) => {
    const text = files[slashed((e as unknown as { path: string }).path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('process.run', ($, e) => {
    const { argv, init } = e as unknown as { argv: string[]; init?: { cwd?: string } }
    runs.push({ argv, cwd: slashed(init?.cwd ?? '') })
    return { value: { exitCode: 0, stdout: stdout(argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  return { runs, probes }
}

test('paths, Prettier bin entries and the cmd.exe switch', () => {
  expect(toSlash('C:\\Users\\me\\proj\\a.ts')).toBe('C:/Users/me/proj/a.ts')
  expect(isAbsolute('C:/Users/me/a.ts')).toBe(true)
  expect(isAbsolute('/app/a.ts')).toBe(true)
  expect(isAbsolute('src/a.ts')).toBe(false)
  expect(prettierBin('{"bin":"./bin/prettier.cjs"}')).toBe('bin/prettier.cjs')
  expect(prettierBin('{"bin":{"prettier":"bin-prettier.js"}}')).toBe('bin-prettier.js')
  expect(prettierBin('{"name":"prettier"}')).toBe(null)
  expect(prettierBin('nope')).toBe(null)
  expect(shimArgv(['dart', 'format', 'C:/a.dart'], true)).toEqual(['cmd.exe', '/d', '/c', 'dart', 'format', 'C:/a.dart'])
  expect(shimArgv(['dart', 'format', '/a.dart'], false)).toEqual(['dart', 'format', '/a.dart'])
})

test('the session folder check ignores case on Windows only', () => {
  expect(inside('C:/proj/a.ts', 'C:/proj')).toBe(true)
  expect(inside('c:/PROJ/a.ts', 'C:/proj')).toBe(true)
  expect(inside('C:/project2/a.ts', 'C:/proj')).toBe(false)
  expect(inside('/app/a.ts', '/')).toBe(true)
  expect(inside('/App/a.ts', '/app')).toBe(false)
})

test('on Windows Prettier runs from its package.json bin through node', async ($, on) => {
  const { runs } = disk(
    on,
    { 'C:/Users/me/app/package.json': '{}', 'C:/Users/me/app/node_modules/prettier/package.json': '{"bin":{"prettier":"./bin/prettier.cjs"}}' },
    () => 'src/a.ts\r\n',
    'C:\\Users\\me\\app',
  )
  const edited = await $.tool.call({ tool: 'Edit', file_path: 'C:\\Users\\me\\app\\src\\a.ts', old_string: 'a', new_string: 'b' } as never)
  expect(runs).toEqual([
    {
      argv: ['node', 'C:/Users/me/app/node_modules/prettier/bin/prettier.cjs', '--write', '--list-different', 'C:/Users/me/app/src/a.ts'],
      cwd: 'C:/Users/me/app',
    },
  ])
  expect(JSON.stringify(edited)).toContain('Prettier reformatted C:\\\\Users\\\\me\\\\app\\\\src\\\\a.ts. Read it again')
})

test('on Windows dart format and Spotless go through cmd.exe', async ($, on) => {
  const { runs } = disk(
    on,
    {
      'C:/apps/shop/pubspec.yaml': 'name: shop',
      'C:/apps/svc/build.gradle': "plugins { id 'com.diffplug.spotless' version '6.25.0' }",
      'C:/apps/svc/gradlew.bat': '',
    },
    argv => (argv[3] === 'dart' ? 'Formatted lib\\main.dart\r\nFormatted 1 file (1 changed) in 0.01 seconds.\r\n' : ''),
    'C:\\apps',
  )
  const dart = await $.tool.call({ tool: 'Write', file_path: 'C:\\apps\\shop\\lib\\main.dart', content: 'x' } as never)
  expect(runs[0]).toEqual({ argv: ['cmd.exe', '/d', '/c', 'dart', 'format', 'C:/apps/shop/lib/main.dart'], cwd: 'C:/apps/shop/lib' })
  expect(JSON.stringify(dart)).toMatch(/dart format reformatted/)

  const java = await $.tool.call({ tool: 'Edit', file_path: 'C:\\apps\\svc\\src\\main\\java\\A.java', old_string: 'a', new_string: 'b' } as never)
  expect(runs[1]).toEqual({
    argv: ['cmd.exe', '/d', '/c', 'gradlew.bat', '-q', 'spotlessApply', '-PspotlessIdeHook=C:/apps/svc/src/main/java/A.java'],
    cwd: 'C:/apps/svc',
  })
  expect(JSON.stringify(java)).toMatch(/Spotless reformatted/)
})

test('the walk up stops at the drive root, and a path cmd.exe would act on is left alone', async ($, on) => {
  const { runs, probes } = disk(on, { 'C:/pubspec.yaml': '' }, () => 'Formatted 1 file (1 changed)', 'C:\\')
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\src\\a.ts', old_string: 'a', new_string: 'b' } as never)
  expect(probes).toEqual(['C:/src/package.json', 'C:/package.json'])

  await $.tool.call({ tool: 'Write', file_path: 'C:\\lib\\a&calc.dart', content: 'x' } as never)
  expect(runs.length).toBe(0)
  await $.tool.call({ tool: 'Write', file_path: 'C:\\lib\\main.dart', content: 'x' } as never)
  expect(runs.length).toBe(1)
})

test('on Windows, files and projects outside the session folder are never formatted', async ($, on) => {
  const { runs, probes } = disk(
    on,
    { 'D:/shop/pubspec.yaml': '', 'D:/other/pubspec.yaml': '', 'D:/package.json': '{}', 'D:/node_modules/prettier/package.json': '{"bin":"p.cjs"}' },
    () => 'Formatted 1 file (1 changed)',
    'd:\\Shop\\',
  )
  // Inside, with the folder's case and trailing slash differing: formatted.
  await $.tool.call({ tool: 'Write', file_path: 'D:\\shop\\lib\\main.dart', content: 'x' } as never)
  expect(runs.length).toBe(1)
  // Another project, a climb out through `..`, and a Prettier found only above the session folder: left alone.
  await $.tool.call({ tool: 'Write', file_path: 'D:\\other\\lib\\main.dart', content: 'x' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'D:\\shop\\..\\other\\lib\\main.dart', content: 'x' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'D:\\shop\\web\\a.ts', old_string: 'a', new_string: 'b' } as never)
  expect(runs.length).toBe(1)
  expect(probes).not.toContain('D:/package.json')
})
