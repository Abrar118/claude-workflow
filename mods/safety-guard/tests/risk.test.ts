import { expect, test } from 'claude-code/testing'

import { isBarePush, isEnvFile, isMerge, isProdCompose, risk } from '../hooks/register'

test('risky commands are named; safe ones pass', () => {
  expect(risk('git push --force origin main')).toBe('force push')
  expect(risk('rm -rf build')).toBe('recursive delete')
  expect(risk('psql -c "drop table users"')).toBe('destructive SQL')
  expect(risk('./gradlew flywayClean')).toBe('flyway clean')
  expect(risk('rm file.txt')).toBeUndefined()
})

test('pushes to main and the production compose file are caught', () => {
  expect(risk('git push origin main')).toBe('push to main')
  expect(risk('git push origin HEAD:master')).toBe('push to main')
  expect(risk('git push origin RB-12')).toBeUndefined()
  expect(risk('git push origin feature/main-menu')).toBeUndefined()
  expect(isBarePush('git push')).toBe(true)
  expect(isBarePush('git push -u origin RB-12')).toBe(false)
  expect(isProdCompose('docker compose up -d --build')).toBe(true)
  expect(isProdCompose('docker-compose -f docker-compose.yml up')).toBe(true)
  expect(isProdCompose('docker compose -f docker-compose-dev.yml up -d --build')).toBe(false)
  expect(isProdCompose('docker compose down')).toBe(false)
})

test('recursive deletes and force pushes in their other spellings are caught', () => {
  for (const c of ['rm -r dir', 'rm -R dir', 'rm -r -f dir', 'rm --recursive dir', 'rm -Rf dir', 'cd x && rm -fr y'])
    expect(risk(c)).toBe('recursive delete')
  for (const c of ['git rm -r --cached dir', 'docker run --rm img', 'rm -f file', 'npm run rm-r'])
    expect(risk(c)).not.toBe('recursive delete')
  expect(risk('git push origin +main')).toBe('force push')
  expect(risk('git push origin +feature/x')).toBe('force push')
})

test('a branch merely starting with main is not main', () => {
  expect(risk('git push origin main-menu')).toBeUndefined()
  expect(risk('git push origin master-plan')).toBeUndefined()
  expect(risk('git push origin main.v2')).toBeUndefined()
  expect(risk('git push -u origin main')).toBe('push to main')
})

test('every form of a bare push is seen; a named refspec is not', () => {
  for (const c of ['git push', 'git push origin', 'git push -u origin', 'git push origin HEAD', 'git push upstream', 'git push 2>&1', 'git push && echo ok'])
    expect(isBarePush(c)).toBe(true)
  for (const c of ['git push -u origin RB-12', 'git push origin feature/x']) expect(isBarePush(c)).toBe(false)
})

test('.env files are guarded; the committed templates are not', () => {
  for (const p of ['/p/.env', '/p/.env.local', '/p/.ENV.production', '.env']) expect(isEnvFile(p)).toBe(true)
  for (const p of ['/p/.env.example', '/p/.env.sample', '/p/.env.template', '/p/.envrc', '/p/env.ts']) expect(isEnvFile(p)).toBe(false)
})

test('Block is the first option, and a failing check blocks', async ($, on) => {
  let options: unknown
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      options = (e as never as { questions: { options: { label: string }[] }[] }).questions[0]!.options.map(o => o.label)
      return { deny: 'dismissed' }
    }
    return { result: 'ran' }
  })
  on('session.cwd', () => {
    throw new Error('boom')
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)
  expect(options).toEqual(['Block', 'Allow'])
  expect(JSON.stringify(r)).toMatch(/blocked/)
  // A bare push asks for the cwd; that failing must block, not let the push through.
  const failed = await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(JSON.stringify(failed)).toMatch(/check failed/)
})

test('force flags inside a cluster and refs/heads/main are caught', () => {
  for (const c of ['git push -fu origin feat', 'git push -uf origin feat']) expect(risk(c)).toBe('force push')
  expect(risk('git push origin HEAD:refs/heads/main')).toBe('push to main')
  expect(risk('git push --follow-tags origin feat')).toBeUndefined()
  expect(risk('git push -u origin feat')).toBeUndefined()
})

test('shell writes to .env files are caught; templates and reads are not', () => {
  for (const c of ['echo A=1 > .env', 'echo A=1 >> /p/.env.local', 'printf x | tee .env', 'printf x | tee -a "/p/.env"'])
    expect(risk(c)).toBe('.env write')
  for (const c of ['echo A=1 > .env.example', 'cat .env', 'cp .env.example .envrc']) expect(risk(c)).toBeUndefined()
})

test('PR merges are always caught; merges into main by name are caught', () => {
  for (const c of ['gh pr merge 12 --squash', 'gh pr merge --auto', 'gh api -X PUT repos/o/r/pulls/12/merge'])
    expect(risk(c)).toBe('PR merge')
  for (const c of ['git checkout main && git merge feat', 'git switch master && git merge --no-ff feat'])
    expect(risk(c)).toBe('merge into main')
  expect(risk('git checkout main-menu && git merge feat')).toBeUndefined()
  expect(isMerge('git merge feat')).toBe(true)
  expect(isMerge('git merge --abort')).toBe(false)
  expect(isMerge('git merge-base a b')).toBe(false)
})

test('a git merge while on main asks; on a feature branch it runs', async ($, on) => {
  let branch = 'main'
  let asked = 0
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${branch}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      asked++
      return { deny: 'dismissed' }
    }
    return { result: 'ran' }
  })
  const blocked = await $.tool.call({ tool: 'Bash', command: 'git merge feat' } as never)
  expect(asked).toBe(1)
  expect(JSON.stringify(blocked)).toMatch(/blocked this merge into main/)
  branch = 'feat'
  const ran = await $.tool.call({ tool: 'Bash', command: 'git merge main' } as never)
  expect(asked).toBe(1)
  expect(JSON.stringify(ran)).toMatch(/ran/)
})

test('the GitHub merge-PR tool asks first', async ($, on) => {
  let asked = 0
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      asked++
      return { deny: 'dismissed' }
    }
    return { result: 'merged' }
  })
  const r = await $.tool.call({ tool: 'mcp__plugin_github_github__merge_pull_request', owner: 'o', repo: 'r', pullNumber: 1 } as never)
  expect(asked).toBe(1)
  expect(JSON.stringify(r)).toMatch(/blocked/)
})

test('--abort counts only right after merge, not inside a message', () => {
  expect(isMerge('git merge feat -m "x --abort"')).toBe(true)
  expect(isMerge('git merge --abort')).toBe(false)
  expect(isMerge('git merge --continue')).toBe(true)
})

test('an unknown branch asks for bare pushes and merges; a second cd makes the branch unknown', async ($, on) => {
  const dirs: string[] = []
  let asked = 0
  on('process.run', ($, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    dirs.push(argv[2]!)
    return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      asked++
      return { deny: 'dismissed' }
    }
    return { result: 'ran' }
  })
  await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(asked).toBe(1)
  await $.tool.call({ tool: 'Bash', command: 'cd a && cd b && git merge feat' } as never)
  expect(asked).toBe(2)
  expect(dirs).not.toContain('/repo/a')
})

test('any folder change other than one leading cd makes the branch unknown, so it asks', async ($, on) => {
  let asked = 0
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'feat\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      asked++
      return { deny: 'dismissed' }
    }
    return { result: 'ran' }
  })
  const sneaky = ['true && cd x && git merge feat', '(cd x; git merge feat)', 'pushd x && git merge feat', 'GIT_DIR=/x/.git git merge feat', 'git --git-dir=/x/.git merge feat', 'git --work-tree=/x merge feat', 'git -c a=b -C /x merge feat']
  for (const command of sneaky) await $.tool.call({ tool: 'Bash', command } as never)
  expect(asked).toBe(sneaky.length)
  // One leading cd into a feature branch still runs without asking.
  await $.tool.call({ tool: 'Bash', command: 'cd x && git merge main' } as never)
  expect(asked).toBe(sneaky.length)
})

test('git options before the subcommand do not hide it', () => {
  expect(risk('git -C /x push --force origin a')).toBe('force push')
  expect(risk('git -c core.x=1 push origin main')).toBe('push to main')
  expect(risk('git --git-dir /x/.git push origin main')).toBe('push to main')
  expect(isMerge('git --work-tree=/x merge feat')).toBe(true)
  expect(isBarePush('git -C /x push')).toBe(true)
})

test('git options never hide another command or a push', () => {
  expect(risk('git -C x;rm -rf /')).toBe('recursive delete')
  expect(risk('git --config-env a=B push --force origin x')).toBe('force push')
  expect(risk('git -C "a b" push --force origin x')).toBe('force push')
  expect(risk('gh -R o/r pr merge 3')).toBe('PR merge')
  expect(isMerge('git log --merges')).toBe(false)
  expect(isMerge('git branch --merged')).toBe(false)
})

test('env -C and --chdir make the branch unknown, so it asks', async ($, on) => {
  let asked = 0
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'feat\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      asked++
      return { deny: 'dismissed' }
    }
    return { result: 'ran' }
  })
  for (const command of ['env -C /x git merge feat', 'env --chdir=/x git merge feat', 'env --chdir /x git push'])
    await $.tool.call({ tool: 'Bash', command } as never)
  expect(asked).toBe(3)
})
