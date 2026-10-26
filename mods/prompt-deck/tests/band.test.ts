import { expect, mock, test } from 'claude-code/testing'

import { issueOf, parseGit, parsePr } from '../hooks/register'

const BAND = {
  plugin: 'prompt-deck',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 80, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

test('the band draws its four rows with icons and meters on both surfaces', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: '# branch.head main\n# branch.ab +0 -0\n', stderr: '' } }))
  mock.clock(on, { now: 1000 })
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { percent: 12, tokens: 24_000, window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 37 }, { kind: 'seven_day', percentUsed: 19 }],
      cost: { usd: 1.94 },
    },
  }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ source: 'startup', cwd: '/repo' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    if (surface === 'terminal') {
      expect(await band.find({ text: /◔ usage/ })).toBeDefined()
      expect(await band.find({ text: /12%/ })).toBeDefined()
      expect(await band.find({ text: /◷ cache/ })).toBeDefined()
      expect(await band.find({ text: /✓ clean/ })).toBeDefined()
      expect(await band.find({ text: /✦ next/ })).toBeDefined()
    } else {
      // The desktop draws one card (SVG); its words ride in the alt.
      const drawn = JSON.stringify(await band.drawn())
      expect(drawn).toMatch(/ctx 12%.*5h 37%.*wk 19%/)
      expect(drawn).toMatch(/cache/)
      expect(drawn).toMatch(/git main, clean/)
      expect(drawn).toMatch(/next/)
      expect(await band.find({ key: 'compact' })).toBeDefined()
    }
    await band.unmount()
  }
})

test('the /limits pane draws cards on the desktop and rows on the terminal', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: '# branch.head main\n', stderr: '' } }))
  mock.clock(on, { now: 1000 })
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { percent: 12, tokens: 24_000, window: 200_000, breakdown: { categories: [{ name: 'Messages', tokens: 9000 }] } },
      rateLimits: [{ kind: 'five_hour', percentUsed: 37 }],
      cost: { usd: 1.94 },
    },
  }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ source: 'startup', cwd: '/repo' })
  const props = { title: 'Usage', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }
  const term = await $.ui.mount({ plugin: 'prompt-deck', component: 'Pane', requestId: 'limits', surface: 'terminal', props } as never)
  expect(await term.find({ text: /PLAN LIMITS/ })).toBeDefined()
  await term.unmount()
  const desk = await $.ui.mount({ plugin: 'prompt-deck', component: 'Pane', requestId: 'limits', surface: 'desktop', props } as never)
  const drawn = JSON.stringify(await desk.drawn())
  expect(drawn).toMatch(/Plan limits: 5-hour 37%/)
  expect(drawn).toMatch(/Cache: Unknown/)
  expect(drawn).toMatch(/Context: 24\.0k of 200\.0k/)
})

test('the band shows the last turn from turn-meter on both surfaces', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: '# branch.head main\n', stderr: '' } }))
  mock.clock(on, { now: 1000 })
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { percent: 12, tokens: 1, window: 200_000 }, rateLimits: [] } }))
  on('state.get', ($, e, next) => (e.plugin === 'turn-meter' ? { value: { value: '12s · 3 tools · ≈$0.05', version: 1 } } : next(e)))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ source: 'startup', cwd: '/repo' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ text: /12s · 3 tools/ })).toBeDefined()
    await band.unmount()
  }
})

test('git status reads branch, upstream, ahead/behind and files by kind', () => {
  const g = parseGit(
    [
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 a b src/a.ts',
      '1 .M N... 100644 100644 100644 a b src/b.ts',
      '1 MM N... 100644 100644 100644 a b src/c.ts',
      'u UU N... 100644 100644 100644 100644 a b c src/d.ts',
      '? notes.txt',
    ].join('\n'),
  )
  expect(g).toEqual({ branch: 'main', ahead: 2, behind: 1, hasUpstream: true, staged: 2, unstaged: 2, untracked: 1, conflicts: 1 })
  expect(parseGit('# branch.head feature\n')?.hasUpstream).toBe(false)
})


test('the branch names its RB issue; gh reports the open PR and its review', () => {
  expect(issueOf('feature/rb-12-login')).toBe('RB-12')
  expect(issueOf('main')).toBe('')
  expect(parsePr('{"number":88,"state":"OPEN","reviewDecision":"CHANGES_REQUESTED"}')).toEqual({ number: 88, review: 'changes requested' })
  expect(parsePr('{"number":88,"state":"OPEN","reviewDecision":""}')).toEqual({ number: 88, review: 'open' })
  expect(parsePr('{"number":7,"state":"MERGED"}')).toBeNull()
  expect(parsePr('not json')).toBeNull()
})
