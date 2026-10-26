import { expect, test } from 'claude-code/testing'

const FILES = new Set(['/app/package.json', '/app/node_modules/.bin/prettier', '/flutter/pubspec.yaml'])

test('an edit is formatted by the project prettier and Claude is told to re-read it', async ($, on) => {
  on('session.cwd', () => ({ value: '/' }))
  on('fs.exists', ($, e) => ({ value: FILES.has((e as unknown as { path: string }).path) }) as never)
  const runs: string[][] = []
  on('process.run', ($, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    runs.push(argv)
    return { value: { exitCode: 0, stdout: argv[0]!.endsWith('prettier') ? 'src/a.ts\n' : 'Formatted 1 file (0 changed)', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ok' }))

  const edited = await $.tool.call({ tool: 'Edit', file_path: '/app/src/a.ts', old_string: 'a', new_string: 'b' } as never)
  expect(runs[0]).toEqual(['/app/node_modules/.bin/prettier', '--write', '--list-different', '/app/src/a.ts'])
  expect(JSON.stringify(edited)).toMatch(/Prettier reformatted \/app\/src\/a\.ts/)

  // dart format ran but changed nothing: no note.
  const dart = await $.tool.call({ tool: 'Write', file_path: '/flutter/lib/main.dart', content: 'x' } as never)
  expect(runs[1]![0]).toBe('dart')
  expect(JSON.stringify(dart)).not.toMatch(/reformatted/)

  // No formatter set up for this file: nothing runs.
  await $.tool.call({ tool: 'Edit', file_path: '/other/x.ts', old_string: 'a', new_string: 'b' } as never)
  expect(runs.length).toBe(2)
})

test('only files inside the session folder are formatted, by a project inside it', async ($, on) => {
  on('session.cwd', () => ({ value: '/work/app' }))
  const files = new Set(['/work/package.json', '/work/node_modules/.bin/prettier', '/other/package.json', '/other/node_modules/.bin/prettier'])
  on('fs.exists', ($, e) => ({ value: files.has((e as unknown as { path: string }).path) }) as never)
  const runs: string[][] = []
  on('process.run', ($, e) => {
    runs.push((e as unknown as { argv: string[] }).argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  // Outside the session folder.
  await $.tool.call({ tool: 'Edit', file_path: '/other/a.ts', old_string: 'a', new_string: 'b' } as never)
  // Inside it, but the only Prettier is above it.
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' } as never)
  expect(runs.length).toBe(0)
})
