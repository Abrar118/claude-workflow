import { expect, mock, test } from 'claude-code/testing'

import { flowTodos, outText, promptLine, parseChanged, readCheck, readTodos, settleJobs, syncJobs } from '../hooks/register'
import { buildTree } from '../hooks/tree'

const SCROLL = { offset: 0, bodyRows: 20 }
const PANE = {
  plugin: 'agent-panel',
  component: 'Pane',
  requestId: 'agent-panel',
  props: { title: 'Activity', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: SCROLL, view: {} },
} as const
const BAND = {
  plugin: 'agent-panel',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 80, scroll: SCROLL, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const

// The terminal draws text; the desktop draws cards (SVG), whose words ride in each card's alt.
const shows = async (ui: { find: (q: { text: RegExp }) => Promise<unknown>; drawn: () => Promise<unknown> }, surface: string, re: RegExp) =>
  (surface === 'terminal' ? (await ui.find({ text: re })) !== undefined : re.test(JSON.stringify(await ui.drawn())))

test('a subagent shows in the band while it runs, then as done in the panel', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.agent.spawn({ prompt: 'look', description: 'Review the diff', subagentType: 'Explore' })
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ text: /1 running: Review the diff/ })).toBeDefined()
    await band.unmount()
  }

  await clock.advance(84_000)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'a1' })
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await shows(pane, surface, surface === 'terminal' ? /AGENTS/ : /0 running, 1 done/)).toBe(true)
    expect(await shows(pane, surface, surface === 'terminal' ? /Review the diff/ : /Done: Review the diff/)).toBe(true)
    expect(await shows(pane, surface, /1:24/)).toBe(true)
    await pane.unmount()
  }

  const cleared = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await cleared.press({ key: 'clear' })
  await cleared.unmount()
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await shows(pane, surface, /no agents this session/i)).toBe(true)
  }
})

test('progress draws the bar and the plan; a subagent reports its steps', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a2' }))

  await $.tool.call({
    tool: 'mcp__agent-panel__progress',
    title: 'Retrieval reruns',
    phase: 'delegate',
    tasks: [{ title: 'Run R01-R05' }, { title: 'Run R06-R10', agent: 'general-purpose', after: [1] }],
  })
  await $.agent.spawn({ prompt: 'go', description: 'Run R01-R05', subagentType: 'general-purpose' })
  await $.tool.call({ tool: 'mcp__agent-panel__step', agentId: 'a2', done: 1, total: 4, note: 'loading model' })
  await $.tool.call({ tool: 'mcp__agent-panel__progress', done: 1 })

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ text: /Tasks 1\/2/ })).toBeDefined()
    expect(await band.find({ text: '50%' })).toBeDefined()
    expect(await band.find({ key: 'panel', text: '×2' })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await shows(pane, surface, /1\/4( ·)? loading model/)).toBe(true)
    expect(await shows(pane, surface, surface === 'terminal' ? /2\. Run R06-R10/ : /Planned task 2: Run R06-R10/)).toBe(true)
    expect(await shows(pane, surface, surface === 'terminal' ? /1\. Run R01-R05/ : /Planned task 1/)).toBe(false)
    await pane.unmount()
  }

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'dismiss' })
  expect(await band.find({ text: /Tasks/ })).toBeUndefined()
})

test('the main conversation shows: its steps, its task list and its background jobs', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: 'Bash' } as never, () => ({ result: 'ok', text: 'Command running in background with ID: bk42' }) as never)
  on('tool.call', { tool: 'Read' } as never, () => ({ result: 'ok', text: 'x' }) as never)
  on('tool.call', { tool: 'TodoWrite' } as never, () => ({ result: 'ok', text: 'ok' }) as never)

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Download the models', status: 'completed', activeForm: 'Downloading the models' },
      { content: 'Fix stale notes', status: 'in_progress', activeForm: 'Fixing stale notes' },
      { content: 'Run the pilot', status: 'pending', activeForm: 'Running the pilot' },
    ],
  } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/notes.md' } as never)
  await $.tool.call({ tool: 'Bash', command: 'python scripts/pilot.py', description: 'Pilot run', run_in_background: true } as never)

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await shows(pane, surface, surface === 'terminal' ? /Fixing stale notes/ : /Task list: 1 of 3 done/)).toBe(true)
    expect(await shows(pane, surface, surface === 'terminal' ? /Pilot run/ : /Running background task: Pilot run/)).toBe(true)
    await pane.unmount()
  }
})

test('a task notification settles the job it names; the todo list reads TodoWrite', () => {
  const job = { id: 'tu1', taskId: 'bk42', kind: 'shell' as const, label: 'Pilot', startedAt: 0, status: 'running' as const }
  expect(settleJobs([job], '<task-notification><task-id>bk42</task-id><status>completed</status></task-notification>', 9)[0]).toMatchObject({ status: 'done', endedAt: 9 })
  expect(settleJobs([job], '<task-id>bk42</task-id><status>failed</status>', 9)[0]).toMatchObject({ status: 'failed' })
  expect(settleJobs([job], '<task-id>other</task-id><status>completed</status>', 9)[0]).toMatchObject({ status: 'running' })
  expect(readTodos({ todos: [{ content: 'A', status: 'in_progress', activeForm: 'Doing A' }, { content: '' }] })).toEqual([{ text: 'A', now: 'Doing A', status: 'in_progress' }])
})

test('files changed, test results, failures and a job tail show in the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run' as never, () => ({ value: { exitCode: 0, stdout: 'epoch 2/10\r\repoch 3/10\n', stderr: '' } }) as never)
  on('session.start', () => ({ cwd: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register' as never, () => ({ value: undefined }) as never)
  on('tool.call', { tool: 'Edit' } as never, () => ({ result: 'ok', text: 'ok' }) as never)
  on('tool.call', { tool: 'Write' } as never, () => ({ result: 'ok', text: 'ok' }) as never)
  on('tool.call', { tool: 'Read' } as never, () => ({ isError: true, result: 'nope', text: 'File not found: /x/y.md' }) as never)
  on('tool.call', { tool: 'Bash' } as never, (_: unknown, e: { command?: string }) =>
    (e.command?.includes('pytest')
      ? { result: 'x', text: '=== 2 failed, 40 passed ===\nFAILED tests/a.py::test_one - boom' }
      : { result: 'x', text: 'Command running in background with ID: bk7. Output is being written to: /tmp/bk7.output' }) as never)
  await $.session.start({ source: 'startup', cwd: '/repo' })
  await $.turn.start({ text: 'go', turnId: 't1' } as never).catch(() => undefined)

  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.py', old_string: 'a', new_string: 'b\nc' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.py' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/b.py' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/x/y.md' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pytest tests/' } as never)
  await $.tool.call({ tool: 'Bash', command: 'python pilot.py', run_in_background: true } as never)
  await clock.advance(4500)

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    // Mid-run the tree lights the edited files with their line counts.
    expect(await shows(pane, surface, surface === 'terminal' ? /✎ a\.py/ : /src\/a\.py \+2 −1/)).toBe(true)
    expect(await shows(pane, surface, surface === 'terminal' ? /pytest tests\/ · 40 passed, 2 failed/ : /pytest tests\/ failed, 40 passed, 2 failed/)).toBe(true)
    expect(await shows(pane, surface, surface === 'terminal' ? /epoch 3\/10/ : /Latest output: epoch 3\/10/)).toBe(true)
    await pane.unmount()
  }
})

test('parsers read test counts, the first failure and tool output', () => {
  expect(readCheck('pytest', '=== 2 failed, 40 passed ===\nFAILED tests/a.py::t - x', false)).toEqual({ isOk: false, summary: '40 passed, 2 failed', firstFailure: 'tests/a.py::t' })
  expect(readCheck('npm test', 'all good', false)).toMatchObject({ isOk: true, summary: 'ok' })
  expect(outText({ result: { stdout: 'a', stderr: 'b', exitCode: 0 } })).toBe('a\nb')
})

test('a section folds to one line and comes back', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: 'Edit' } as never, () => ({ result: 'ok', text: 'ok' }) as never)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a9' }))
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.py' } as never)
  await $.agent.spawn({ prompt: 'x', description: 'Check things', subagentType: 'Explore' })

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await shows(pane, 'desktop', /Files: 1 changed in last run/)).toBe(true)
  expect(await shows(pane, 'desktop', /Running: Check things|Run.*Check things/)).toBe(true)
  await pane.press({ key: 'fold-files' })
  expect(await shows(pane, 'desktop', /changed in last run/)).toBe(false)
  await pane.press({ key: 'fold-agents' })
  expect(await shows(pane, 'desktop', /Check things/)).toBe(false)
  await pane.press({ key: 'fold-files' })
  await pane.press({ key: 'fold-agents' })
  expect(await shows(pane, 'desktop', /Files: 1 changed in last run/)).toBe(true)
  expect(await shows(pane, 'desktop', /Check things/)).toBe(true)
})

test('only what runs now is listed, and it opens to the whole command', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: 'Read' } as never, () => ({ result: 'ok', text: 'ok' }) as never)
  let release: () => void = () => undefined
  on('tool.call', { tool: 'Bash' } as never, () => new Promise(r => { release = () => r({ result: 'ok', text: 'done' } as never) }) as never)

  await $.tool.call({ tool: 'Read', file_path: '/repo/old.md' } as never)
  const running = $.tool.call({ tool: 'Bash', command: 'python scripts/download_models.py --all --verify' } as never)
  for (let i = 0; i < 50; i++) await Promise.resolve()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await shows(pane, 'desktop', /Running Bash for 0:00: python scripts\/download_models/)).toBe(true)
  expect(await shows(pane, 'desktop', /old\.md/)).toBe(false)
  const more = await pane.findAll({ type: 'Button' })
  const key = more.map(b => (b as { key?: string }).key).find(k => k?.startsWith('more-'))!
  await pane.press({ key })
  expect(await shows(pane, 'desktop', /--verify/)).toBe(true)

  release()
  await running
  expect(await shows(pane, 'desktop', /Running Bash/)).toBe(false)
})

test('a task list leaves when it is finished or forgotten', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: 'TodoWrite' } as never, () => ({ result: 'ok', text: 'ok' }) as never)
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Review findings', status: 'completed', activeForm: 'Reviewing' }] } as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await shows(pane, 'desktop', /Task list: 1 of 1 done/)).toBe(true)
  await clock.advance(121_000)
  await pane.unmount()
  const later = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await shows(later, 'desktop', /Task list/)).toBe(false)
})

test('a task moved to the background by hand is listed, and the Stop list settles it', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', { tool: 'Bash' } as never, () => ({ result: 'x', text: 'Command was manually backgrounded with ID: bk9. Output is being written to: /tmp/bk9.output' }) as never)
  await $.tool.call({ tool: 'Bash', command: 'python slow.py' } as never)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await shows(pane, 'desktop', /Running background task: python slow\.py/)).toBe(true)
  await pane.unmount()

  const job = { id: 'tu', kind: 'shell' as const, label: 'x', startedAt: 0, status: 'running' as const, taskId: 'bk1' }
  const synced = syncJobs([job], [{ id: 'bk2', type: 'shell', description: 'new one' }, { id: 'sub', type: 'subagent', description: 'agent' }], 5)
  expect(synced.find(j => j.taskId === 'bk1')).toMatchObject({ status: 'done', endedAt: 5 })
  expect(synced.find(j => j.taskId === 'bk2')).toMatchObject({ status: 'running', label: 'new one' })
  expect(synced.some(j => j.taskId === 'sub')).toBe(false)
})

test('the file tree opens the way to a touched file and joins single-dir chains', () => {
  const rows = buildTree(['src/app/main.ts', 'src/app/util.ts', 'docs/readme.md'], [{ path: 'src/app/main.ts', isEditing: true, added: 0, removed: 0 }], [])
  const line = (r: { depth: number; isDir: boolean; name: string; touch: unknown; isChanged: boolean; more?: number }) =>
    `${r.depth}:${r.more ? `…${r.more}` : r.isDir ? r.name + '/' : r.name}${r.touch ? '*' : r.isChanged ? '+' : ''}`
  // Smart: only the touched file shows; its sibling and the unrelated docs/ fold into "… 1 more" rows.
  expect(rows.map(line)).toEqual(['0:src/app/', '1:main.ts*', '1:…1', '0:…1'])
  expect(rows.at(-1)!.path).toBe('')
  // Nothing changed yet: one "… N more" row.
  expect(buildTree(['a/x.ts', 'b/y.ts', 'c.ts'], [], []).map(line)).toEqual(['0:…3'])
  // Opening the root (the more row's path) lists it in full.
  expect(buildTree(['a/x.ts', 'c.ts'], [], ['']).map(line)).toEqual(['0:a/', '0:c.ts'])
  // A git-changed file opens its dir too; a dir the person opened lists everything.
  expect(buildTree(['a/x.ts', 'a/y.ts', 'b/z.ts'], [], [], false, ['b/z.ts']).map(line)).toEqual(['0:b/', '1:z.ts+', '0:…1'])
  expect(buildTree(['a/x.ts', 'a/y.ts'], [], ['a']).map(line)).toEqual(['0:a/', '1:x.ts', '1:y.ts'])
  expect(parseChanged(' M src/a.ts\n?? new.ts\nR  old.ts -> moved.ts\n')).toEqual(['src/a.ts', 'new.ts', 'moved.ts'])
})

test('the reported plan is the task list: done ones ticked, the next one in progress', () => {
  const f = { title: 'Ship', total: 3, done: 1, phase: 'delegate' as const, isFinished: false, tasks: [{ title: 'A', agent: '', after: [] }, { title: 'B', agent: '', after: [] }, { title: 'C', agent: '', after: [] }] }
  expect(flowTodos(f).map(t => t.status)).toEqual(['completed', 'in_progress', 'pending'])
  expect(flowTodos({ ...f, isFinished: true }).every(t => t.status === 'completed')).toBe(true)
  expect(flowTodos(null)).toEqual([])
})

test('with no task list, the task is what the person asked, running then done', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.turn.start({ text: 'fix the   login\nscreen', turnId: 't1' } as never).catch(() => undefined)
  await clock.advance(5000)
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ text: /fix the login screen/ })).toBeDefined()
    await pane.unmount()
  }
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ text: /last done in 0:05/ })).toBeDefined()
  expect(promptLine('<task-notification>x</task-notification>')).toBe('Handling a background task result')
})
