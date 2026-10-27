import type { EngineInterface, Register } from 'claude-code'

type Shell = 'Bash' | 'PowerShell'

const PY = /(^|[;&|(]\s*)(python3?|py|pip3?|pytest|jupyter)\b/
const HAS_ENV = /activate|\.venv[\\/](bin|Scripts)[\\/]|\bconda\b|\buv run\b|\bpoetry run\b/i
const CD = /^\s*(?:cd|set-location)\s+(?:-(?:literal)?path\s+)?("([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)/i
// The activate script per shell: a Windows venv keeps it in Scripts, a Unix one in bin.
const SCRIPTS: Record<Shell, string[]> = { Bash: ['Scripts/activate', 'bin/activate'], PowerShell: ['Scripts/Activate.ps1', 'bin/Activate.ps1'] }
const RULE =
  'In folders with a .venv, the venv-auto mod activates it for python, py, pip, pytest and jupyter commands, in Bash and in PowerShell. ' +
  'Do not add the activate step yourself (`source .venv/Scripts/activate`, `source .venv/bin/activate` or `& .venv\\Scripts\\Activate.ps1`).'

/** Whether the command runs Python tools without a venv already set up. */
export const needsVenv = (command: string): boolean => PY.test(command) && !HAS_ENV.test(command)

export const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p)

// Forward slashes, `.` and `..` resolved, no trailing slash; never above `/` or `C:`.
const tidy = (p: string) => {
  const parts: string[] = []
  for (const s of p.replaceAll('\\', '/').split('/')) {
    if (s === '..') {
      if (parts.length > 1) parts.pop()
    } else if (s !== '.' && (s !== '' || parts.length === 0)) parts.push(s)
  }
  return parts.join('/')
}

const parent = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), 0))

/**
 * The folder the command runs in, forward slashes: a leading `cd <dir> &&` (or PowerShell's `cd <dir>;`,
 * `Set-Location <dir>;`), else the session's folder. `~` is `home`; Git Bash's `/c/x` is `C:/x` on Windows.
 */
export const dirOf = (command: string, cwd: string, home = ''): string => {
  const m = CD.exec(command)
  const isWindows = isWindowsPath(cwd)
  let dir = m ? (m[2] ?? m[3] ?? m[4]!) : ''
  if (/^~(?=[\\/]|$)/.test(dir)) dir = home ? home + dir.slice(1) : ''
  if (isWindows) dir = dir.replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`)
  if (!dir) return tidy(cwd)
  return tidy(/^([A-Za-z]:|[\\/])/.test(dir) ? dir : `${cwd}/${dir}`)
}

/**
 * The command with the venv's activate script run first, in the tool's own shell. The path is single-quoted so
 * a folder name can't run anything: Bash writes a ' inside as '\'', PowerShell doubles it (and its curly forms).
 */
export const activated = (shell: Shell, script: string, command: string): string =>
  shell === 'Bash'
    ? `source '${script.replace(/'/g, `'\\''`)}' && ${command}`
    : `& '${(isWindowsPath(script) ? script.replaceAll('/', '\\') : script).replace(/['‘’‚‛]/g, q => q + q)}'; ${command}`

// The activate script of the nearest .venv in the folder or up to 4 above it.
async function findVenv($: EngineInterface, dir: string, scripts: string[]): Promise<string | null> {
  for (let d = dir, i = 0; d && i < 5; d = parent(d), i++) {
    for (const s of scripts) if (await $.fs.exists(`${d}/.venv/${s}`)) return `${d}/.venv/${s}`
  }
  return null
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, { id: 'venv-auto:rule', text: RULE, scope: 'session' as const }] }
  })

  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    if ((e.tool !== 'Bash' && e.tool !== 'PowerShell') || !needsVenv(e.command)) return next(e)
    const cwd = await $.session.cwd()
    const home = e.command.includes('~') ? ((isWindowsPath(cwd) ? await $.env.get('USERPROFILE') : await $.env.get('HOME')) ?? '') : ''
    const script = await findVenv($, dirOf(e.command, cwd, home), SCRIPTS[e.tool])
    if (!script) return next(e)
    return next({ ...e, command: activated(e.tool, script, e.command) })
  })
}
