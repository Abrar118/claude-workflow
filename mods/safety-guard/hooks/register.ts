import type { EngineInterface, Register } from 'claude-code'

const RISKY: [RegExp, string][] = [
  // includes the +refspec form (`git push origin +main`)
  // -f alone or in a cluster (`-fu`), --force, --force-with-lease, or a +refspec (`git push origin +main`)
  [/\bgit\s+push\b[^;&|\n]*(\s--force\b|\s-[a-zA-Z]*f[a-zA-Z]*(?![\w-])|--force-with-lease|\s\+[\w./-])/, 'force push'],
  // -r / -R / -rf / -Rf / -r -f / --recursive anywhere in the flags; not `git rm`, not `docker run --rm`
  [/(?<![\w.-])(?<!\bgit\s)rm\s(?:[^;&|\n]*\s)?(-[fiIdv]*[rR][fiIrRdv]*|--recursive)(?![\w-])/, 'recursive delete'],
  [/\bgit\s+reset\s+--hard\b/, 'hard reset'],
  [/\bgit\s+(clean\s+-[a-zA-Z]*f|checkout\s+--\s+\.)/, 'discard local files'],
  [/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, 'destructive SQL'],
  [/\bflyway\s*clean\b|\bflyway\b.*\bclean\b|flywayClean/i, 'flyway clean'],
  // the branch name must end there: `main-menu` and `master-plan` are not main
  [/\bgit\s+push\b[^;&|\n]*\s\+?(\S+:)?(refs\/heads\/)?(main|master)(?![\w./-])/, 'push to main'],
  // Merging a PR lands it on its base branch, usually main: always ask.
  [/\bgh\s+pr\s+merge\b|\bgh\s+api\b[^;&|\n]*\/(pulls\/\d+\/merge|merges)\b/, 'PR merge'],
  // Switching to main and merging in one command.
  [/\bgit\s+(checkout|switch)\s+(main|master)(?![\w./-])[^\n]*\bgit\s+merge(?![\w-])/, 'merge into main'],
]
// A merge that changes the current branch: not `git merge --abort`/`--quit` (only right after merge), not `git merge-base`.
const MERGE = /\bgit\s+merge(?![\w-])(?!\s+--(abort|quit)\b)/
// Where a shell redirect or tee writes: `> .env`, `>> /p/.env.local`, `tee -a ".env"`. Not `2>&1`.
const WRITE_TARGET = /(?:[^<>&\d]>>?|\btee(?:\s+-a)?)\s*["']?([^\s;&|"'<>]+)/g
// `docker compose up` on the default file, or a named file that is not the dev one.
const PROD_COMPOSE = /(^|[;&|(]\s*|\bsudo\s+)docker[- ]compose\b(?![^;&|]*\s-f\s+\S*dev)[^;&|]*\bup\b/
// No refspec named, so it pushes the current branch: any flags or remote, optional HEAD and redirects.
const BARE_PUSH = /\bgit\s+push(\s+-\S+)*(\s+(?!-)[^\s;&|]+(\s+HEAD)?)?(\s+[12]?>>?&?\s*\S+)*\s*($|[;&|\n])/
// .env and .env.local etc., but not the committed .env.example / .sample / .template
const ENV_FILE = /(^|\/)\.env(?!\.(example|sample|template)$)(\.[^/]+)?$/i
export const isEnvFile = (path: string) => ENV_FILE.test(path)

// `git -C x push`, `git -c k=v merge`, `git --git-dir=x push`: drop git's own options so the checks see `git push`.
const GIT_OPTS = /\bgit((?:\s+(?:-[cC]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path)\s+\S+|--[\w-]+(?:=\S+)?|-[pP]))+)(?=\s)/g
const plain = (command: string) => command.replace(GIT_OPTS, 'git')

export const writesEnvFile = (command: string) => [...command.matchAll(WRITE_TARGET)].some(m => isEnvFile(m[1]!))
export const isMerge = (command: string) => MERGE.test(plain(command))
export const risk = (command: string) =>
  RISKY.find(([r]) => r.test(plain(command)))?.[1] ?? (writesEnvFile(command) ? '.env write' : undefined)
export const isProdCompose = (command: string) => PROD_COMPOSE.test(command)
export const isBarePush = (command: string) => BARE_PUSH.test(plain(command))

// Risks that depend on where the command runs: the branch it pushes, or a folder with a dev compose file.
// The folder the command runs in: one leading `cd <dir> &&`, else the session's folder.
// Null (unknown, so the guard asks) for any other way of changing folder or repo:
// a later or second cd, pushd, git -C, --git-dir, --work-tree, GIT_DIR or GIT_WORK_TREE.
const ELSEWHERE = /\bpushd\b|\bgit\b[^;&|\n]*\s-C\b|--git-dir\b|--work-tree\b|\bGIT_(DIR|WORK_TREE)=/
const dirOf = (command: string, cwd: string): string | null => {
  const cds = (command.match(/(?<![\w.-])cd(?![\w.-])/g) ?? []).length
  const m = /^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*&&/.exec(command)
  if (ELSEWHERE.test(command) || cds > 1 || (cds === 1 && !m)) return null
  const dir = m ? (m[2] ?? m[3] ?? m[4]!) : ''
  return !dir ? cwd : dir.startsWith('/') ? dir : `${cwd}/${dir}`
}

// The checked-out branch, or null when git can't tell.
async function branchIn($: EngineInterface, dir: string | null): Promise<string | null> {
  if (dir === null) return null
  const r = await $.process.run(['git', '-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout.trim() : null
}

async function contextRisk($: EngineInterface, command: string): Promise<string | undefined> {
  const cwd = await $.session.cwd()
  const dir = dirOf(command, cwd)
  if (isBarePush(command)) {
    const branch = await branchIn($, dir)
    if (branch === null) return 'push (could not tell which branch it pushes)'
    if (/^(main|master)$/.test(branch)) return 'push to main'
  }
  if (isMerge(command)) {
    const branch = await branchIn($, dir)
    if (branch === null) return 'merge (could not tell which branch it merges into)'
    if (/^(main|master)$/.test(branch)) return 'merge into main'
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

  // The GitHub MCP server's merge tool: merging a PR always needs the person's OK.
  on('tool.call', { tool: /merge_pull_request$/ }, async ($, e, next) => {
    const pr = e as unknown as { owner?: string; repo?: string; pullNumber?: number }
    const which = pr.repo ? ` ${pr.owner}/${pr.repo}#${pr.pullNumber}` : ''
    const answer = await $.ui.ask(`Claude wants to merge pull request${which}. Allow it?`, ['Block', 'Allow']).catch(() => 'Block')
    return answer === 'Allow' ? next(e) : { deny: `safety-guard: the user blocked merging pull request${which}.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'safety-guard: its check failed, so the merge was blocked.' }))
}
