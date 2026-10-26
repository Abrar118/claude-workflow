import type { EngineInterface, Register } from 'claude-code'

type Formatter = { name: string; cwd: string; argv: string[]; isChanged: (stdout: string) => boolean }

const PRETTIER_EXT = /\.(tsx?|jsx?|mjs|cjs|css|scss|json|md|html|ya?ml)$/

const parent = (p: string) => p.slice(0, p.lastIndexOf('/'))

const inside = (path: string, root: string) => root === '/' || path === root || path.startsWith(`${root}/`)

// The nearest folder at or above `dir`, and not above `root`, holding one of `names`; null past 8 levels.
async function nearest($: EngineInterface, dir: string, root: string, names: string[]): Promise<{ dir: string; name: string } | null> {
  for (let d = dir, i = 0; d && inside(d, root) && i < 8; d = parent(d), i++) {
    for (const name of names) if (await $.fs.exists(`${d}/${name}`)) return { dir: d, name }
  }
  return null
}

const read = ($: EngineInterface, path: string) => ($.fs.read(path) as Promise<string>).catch(() => '')

/** Picks the project's own formatter for a file, or null when the project has none set up.
 * Only files and projects inside the session's folder count: a formatter runs the project's own code. */
export async function formatterFor($: EngineInterface, file: string): Promise<Formatter | null> {
  if (file.includes('/node_modules/') || file.includes('/build/')) return null
  const root = (await $.session.cwd()).replace(/(.)\/+$/, '$1')
  if (!inside(file, root)) return null
  const dir = parent(file)
  if (PRETTIER_EXT.test(file)) {
    const pkg = await nearest($, dir, root, ['package.json'])
    // Only the project's installed Prettier: never a download.
    if (!pkg || !(await $.fs.exists(`${pkg.dir}/node_modules/.bin/prettier`))) return null
    return { name: 'Prettier', cwd: pkg.dir, argv: [`${pkg.dir}/node_modules/.bin/prettier`, '--write', '--list-different', file], isChanged: out => out.trim() !== '' }
  }
  if (file.endsWith('.dart')) {
    if (!(await nearest($, dir, root, ['pubspec.yaml']))) return null
    return { name: 'dart format', cwd: dir, argv: ['dart', 'format', file], isChanged: out => !/\(0 changed\)/.test(out) }
  }
  if (file.endsWith('.java') || file.endsWith('.kt')) {
    const build = await nearest($, dir, root, ['build.gradle', 'build.gradle.kts'])
    if (!build || !/spotless/i.test(await read($, `${build.dir}/${build.name}`))) return null
    const wrapper = await nearest($, build.dir, root, ['gradlew'])
    if (!wrapper) return null
    // ponytail: Spotless does not say whether it changed the file, so it is always reported as formatted.
    return { name: 'Spotless', cwd: wrapper.dir, argv: ['./gradlew', '-q', 'spotlessApply', `-PspotlessIdeHook=${file}`], isChanged: () => true }
  }
  return null
}

export const register: Register = on => {
  on('tool.call', { tool: /^(Edit|Write)$/ }, async ($, e, next) => {
      const result = await next(e)
      if (result.deny !== undefined || result.isError) return result
      const file = String((e as unknown as { file_path?: string }).file_path ?? '')
      const f = file.startsWith('/') ? await formatterFor($, file) : null
      if (!f) return result
      const r = await $.process.run(f.argv, { cwd: f.cwd, timeoutMs: 60_000 }).catch(() => null)
      if (!r || r.exitCode !== 0 || !f.isChanged(r.stdout)) return result
      const note = `format-on-edit: ${f.name} reformatted ${file}. Read it again before your next edit to it.`
      return { ...result, context: [...(result.context ?? []), note] }
  })
}
