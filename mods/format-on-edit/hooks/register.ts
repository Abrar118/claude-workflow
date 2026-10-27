import type { EngineInterface, Register } from 'claude-code'

type Formatter = { name: string; cwd: string; argv: string[]; isChanged: (stdout: string) => boolean }

const PRETTIER_EXT = /\.(tsx?|jsx?|mjs|cjs|css|scss|json|md|html|ya?ml)$/
// What cmd.exe would act on inside a path it is handed.
const CMD_META = /[&|<>^%!"]/

export const toSlash = (p: string): string => p.replaceAll('\\', '/')

/** Whether a slash-normalised path is absolute: `/…` or `C:/…`. */
export const isAbsolute = (p: string): boolean => /^([A-Za-z]:)?\//.test(p)

export const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p)

/** The argv to spawn: dart and gradlew are .bat files on Windows, which only cmd.exe can start. */
export const shimArgv = (argv: string[], isWindows: boolean): string[] => (isWindows ? ['cmd.exe', '/d', '/c', ...argv] : argv)

/** The JS file Prettier's package.json names as its command (`bin`, a string or `{ prettier }`), or null. */
export const prettierBin = (pkgJson: string): string | null => {
  try {
    const bin = (JSON.parse(pkgJson) as { bin?: string | Record<string, string> }).bin
    const entry = typeof bin === 'string' ? bin : bin?.prettier
    return entry ? entry.replace(/^\.\//, '') : null
  } catch {
    return null
  }
}

// `/a/b` → `/a`, `C:/a` → `C:`, and '' past the root (`/a`, `C:`).
const parent = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), 0))

/** Whether `path` is `root` or below it; Windows paths compare without case. Both slash-normalised, `root` without a trailing slash. */
export const inside = (path: string, root: string): boolean => {
  const [p, r] = isWindowsPath(`${root}/`) ? [path.toLowerCase(), root.toLowerCase()] : [path, root]
  return r === '/' || p === r || p.startsWith(`${r}/`)
}

// The nearest folder at or above `dir`, and not above `root`, holding one of `names`; null past 8 levels.
async function nearest($: EngineInterface, dir: string, root: string, names: string[]): Promise<{ dir: string; name: string } | null> {
  for (let d = dir, i = 0; d && inside(d, root) && i < 8; d = parent(d), i++) {
    for (const name of names) if (await $.fs.exists(`${d}/${name}`)) return { dir: d, name }
  }
  return null
}

const read = ($: EngineInterface, path: string) => ($.fs.read(path) as Promise<string>).catch(() => '')

/** Picks the project's own formatter for a file (absolute, forward slashes), or null when the project has none set up.
 * Only files and projects inside the session's folder count: a formatter runs the project's own code. */
export async function formatterFor($: EngineInterface, file: string): Promise<Formatter | null> {
  // `.` or `..` segments could climb out of the session folder after the check below.
  if (file.includes('/node_modules/') || file.includes('/build/') || /\/\.\.?(\/|$)/.test(file)) return null
  const root = toSlash(await $.session.cwd()).replace(/(.)\/+$/, '$1')
  if (!inside(file, root)) return null
  const dir = parent(file)
  const isWindows = isWindowsPath(file)
  if (PRETTIER_EXT.test(file)) {
    const pkg = await nearest($, dir, root, ['package.json'])
    if (!pkg) return null
    // Only the project's installed Prettier: never a download.
    if (!isWindows) {
      if (!(await $.fs.exists(`${pkg.dir}/node_modules/.bin/prettier`))) return null
      return { name: 'Prettier', cwd: pkg.dir, argv: [`${pkg.dir}/node_modules/.bin/prettier`, '--write', '--list-different', file], isChanged: out => out.trim() !== '' }
    }
    // Windows: .bin/prettier is a .cmd shim, so node starts Prettier's real entry instead.
    const bin = prettierBin(await read($, `${pkg.dir}/node_modules/prettier/package.json`))
    if (!bin) return null
    const argv = ['node', `${pkg.dir}/node_modules/prettier/${bin}`, '--write', '--list-different', file]
    return { name: 'Prettier', cwd: pkg.dir, argv, isChanged: out => out.trim() !== '' }
  }
  if (isWindows && CMD_META.test(file)) return null
  if (file.endsWith('.dart')) {
    if (!(await nearest($, dir, root, ['pubspec.yaml']))) return null
    return { name: 'dart format', cwd: dir, argv: shimArgv(['dart', 'format', file], isWindows), isChanged: out => !/\(0 changed\)/.test(out) }
  }
  if (file.endsWith('.java') || file.endsWith('.kt')) {
    const build = await nearest($, dir, root, ['build.gradle', 'build.gradle.kts'])
    if (!build || !/spotless/i.test(await read($, `${build.dir}/${build.name}`))) return null
    const gradlew = isWindows ? 'gradlew.bat' : 'gradlew'
    const wrapper = await nearest($, build.dir, root, [gradlew])
    if (!wrapper) return null
    // ponytail: Spotless does not say whether it changed the file, so it is always reported as formatted.
    const argv = shimArgv([isWindows ? gradlew : `./${gradlew}`, '-q', 'spotlessApply', `-PspotlessIdeHook=${file}`], isWindows)
    return { name: 'Spotless', cwd: wrapper.dir, argv, isChanged: () => true }
  }
  return null
}

export const register: Register = on => {
  on('tool.call', { tool: /^(Edit|Write)$/ }, async ($, e, next) => {
      const result = await next(e)
      if (result.deny !== undefined || result.isError) return result
      const path = String((e as unknown as { file_path?: string }).file_path ?? '')
      // Windows paths arrive with backslashes; every check below reads forward slashes.
      const file = toSlash(path)
      const f = isAbsolute(file) ? await formatterFor($, file) : null
      if (!f) return result
      const r = await $.process.run(f.argv, { cwd: f.cwd, timeoutMs: 60_000 }).catch(() => null)
      if (!r || r.exitCode !== 0 || !f.isChanged(r.stdout)) return result
      const note = `format-on-edit: ${f.name} reformatted ${path}. Read it again before your next edit to it.`
      return { ...result, context: [...(result.context ?? []), note] }
  })
}
