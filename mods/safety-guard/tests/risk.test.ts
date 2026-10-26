import { expect, test } from 'claude-code/testing'

import { isBarePush, isEnvFile, isProdCompose, risk } from '../hooks/register'

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
