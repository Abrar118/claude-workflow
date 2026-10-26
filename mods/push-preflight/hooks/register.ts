import type { Register } from 'claude-code'

// The CI gates, in the order CI fails fastest on them.
const CHECKS = ['format:check', 'lint', 'typecheck']
const PUSH = /(^|[;&|]\s*)git\s+push\b(?![^;&|]*--dry-run)/

export const isPush = (command: string): boolean => PUSH.test(command)

/** The scripts of a package.json this repo defines, in check order. */
export const checksIn = (pkgJson: string): string[] => {
  try {
    const scripts = (JSON.parse(pkgJson) as { scripts?: Record<string, string> }).scripts ?? {}
    return CHECKS.filter(c => scripts[c])
  } catch {
    return []
  }
}

const tail = (s: string, n: number) => s.trim().split('\n').slice(-n).join('\n')

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isPush(e.command)) return next(e)
    const cwd = await $.session.cwd()
    const checks = checksIn(await ($.fs.read(`${cwd}/package.json`) as Promise<string>).catch(() => ''))
    if (checks.length === 0) return next(e)
    if (!(await $.fs.exists(`${cwd}/node_modules`))) {
      $.ui.toast('push-preflight: node_modules missing, checks skipped (npm install to enable)')
      return next(e)
    }
    for (const check of checks) {
      $.ui.status(`push-preflight: ${check}…`)
      const r = await $.process.run(['npm', 'run', '-s', check], { cwd, timeoutMs: 300_000 }).catch(() => null)
      if (!r || r.exitCode !== 0) {
        $.ui.status(undefined)
        $.ui.toast(`push-preflight: ${check} failed, push blocked`)
        const out = r ? tail(`${r.stdout}\n${r.stderr}`, 30) : 'could not run it'
        return { deny: `push-preflight: \`npm run ${check}\` failed, so the push was blocked (CI would fail too). Fix it, then push again.\n${out}` }
      }
    }
    $.ui.status(undefined)
    return next(e)
  })
}
