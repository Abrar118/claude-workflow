import type { EngineInterface, Register } from 'claude-code'

const RISKY: [RegExp, string][] = [
  // includes the +refspec form (`git push origin +main`)
  [/\bgit\s+push\b[^;&|\n]*(\s--force\b|\s-f\b|--force-with-lease|\s\+[\w./-])/, 'force push'],
  // -r / -R / -rf / -Rf / -r -f / --recursive anywhere in the flags; not `git rm`, not `docker run --rm`
  [/(?<![\w.-])(?<!\bgit\s)rm\s(?:[^;&|\n]*\s)?(-[fiIdv]*[rR][fiIrRdv]*|--recursive)(?![\w-])/, 'recursive delete'],
  [/\bgit\s+reset\s+--hard\b/, 'hard reset'],
  [/\bgit\s+(clean\s+-[a-zA-Z]*f|checkout\s+--\s+\.)/, 'discard local files'],
  [/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, 'destructive SQL'],
  [/\bflyway\s*clean\b|\bflyway\b.*\bclean\b|flywayClean/i, 'flyway clean'],
  // the branch name must end there: `main-menu` and `master-plan` are not main
  [/\bgit\s+push\b[^;&|\n]*\s\+?(\S+:)?(main|master)(?![\w./-])/, 'push to main'],
]
// `docker compose up` on the default file, or a named file that is not the dev one.
const PROD_COMPOSE = /(^|[;&|(]\s*|\bsudo\s+)docker[- ]compose\b(?![^;&|]*\s-f\s+\S*dev)[^;&|]*\bup\b/
// No refspec named, so it pushes the current branch: any flags or remote, optional HEAD and redirects.
const BARE_PUSH = /\bgit\s+push(\s+-\S+)*(\s+(?!-)[^\s;&|]+(\s+HEAD)?)?(\s+[12]?>>?&?\s*\S+)*\s*($|[;&|\n])/
// .env and .env.local etc., but not the committed .env.example / .sample / .template
const ENV_FILE = /(^|\/)\.env(?!\.(example|sample|template)$)(\.[^/]+)?$/i
export const isEnvFile = (path: string) => ENV_FILE.test(path)

export const risk = (command: string) => RISKY.find(([r]) => r.test(command))?.[1]
export const isProdCompose = (command: string) => PROD_COMPOSE.test(command)
export const isBarePush = (command: string) => BARE_PUSH.test(command)

// Risks that depend on where the command runs: the branch it pushes, or a folder with a dev compose file.
async function contextRisk($: EngineInterface, command: string): Promise<string | undefined> {
  const cwd = await $.session.cwd()
  if (isBarePush(command)) {
    const r = await $.process.run(['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
    if (r && /^(main|master)$/.test(r.stdout.trim())) return 'push to main'
  }
  if (isProdCompose(command) && (await $.fs.exists(`${cwd}/docker-compose-dev.yml`).catch(() => false))) return 'production docker compose up (this folder has docker-compose-dev.yml)'
  return undefined
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const what = risk(e.command) ?? (await contextRisk($, e.command))
    if (!what) return next(e)
    // Block first: it is the focused option, so a reflexive Enter is the safe answer.
    const answer = await $.ui.ask(`Claude wants to run a ${what}: ${e.command.slice(0, 160)}. Allow it?`, ['Block', 'Allow']).catch(() => 'Block')
    return answer === 'Allow' ? next(e) : { deny: `safety-guard: the user blocked this ${what}.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'safety-guard: its check failed, so the command was blocked. Ask the user to run it.' }))

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    if (!ENV_FILE.test(e.file_path)) return next(e)
    const answer = await $.ui.ask(`Claude wants to change ${e.file_path}. Allow it?`, ['Block', 'Allow']).catch(() => 'Block')
    return answer === 'Allow' ? next(e) : { deny: `safety-guard: the user blocked editing ${e.file_path}.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'safety-guard: its check failed, so the edit was blocked.' }))
}
