import type { EngineInterface, Register } from 'claude-code'

const PY = /(^|[;&|(]\s*)(python3?|pip3?|pytest|jupyter)\b/
const HAS_ENV = /activate|\.venv\/bin\/|\bconda\b|\buv run\b|\bpoetry run\b/
const RULE =
  'In folders with a .venv, the venv-auto mod activates it for python, pip and pytest commands. ' +
  'Do not add `source .venv/bin/activate` yourself.'

/** Whether the command runs Python tools without a venv already set up. */
export const needsVenv = (command: string): boolean => PY.test(command) && !HAS_ENV.test(command)

/** The folder the command runs in: a leading `cd <dir> &&`, else the session's folder. */
export const dirOf = (command: string, cwd: string): string => {
  const m = /^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*&&/.exec(command)
  const dir = m ? (m[2] ?? m[3] ?? m[4]!).replace(/^~(?=\/|$)/, '') : ''
  if (!dir) return cwd
  return dir.startsWith('/') ? dir : `${cwd}/${dir}`
}

// The nearest .venv in the folder or up to 4 above it.
async function findVenv($: EngineInterface, dir: string): Promise<string | null> {
  let d = dir.replace(/\/+$/, '')
  for (let i = 0; i < 5 && d; i++) {
    if (await $.fs.exists(`${d}/.venv/bin/activate`)) return `${d}/.venv`
    d = d.slice(0, d.lastIndexOf('/'))
  }
  return null
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, { id: 'venv-auto:rule', text: RULE, scope: 'session' as const }] }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!needsVenv(e.command)) return next(e)
    const home = (await $.process.run(['sh', '-c', 'printf %s "$HOME"']).catch(() => null))?.stdout ?? ''
    const cmd = e.command.replace(/^(\s*cd\s+)~(?=\/|\s)/, `$1${home}`)
    const venv = await findVenv($, dirOf(cmd, await $.session.cwd()))
    if (!venv) return next(e)
    return next({ ...e, command: `source "${venv}/bin/activate" && ${e.command}` })
  })
}
