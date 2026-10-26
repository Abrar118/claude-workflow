import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { QueueItem } from '../types'

const PANE = 'prompt-queue'
const STORE_KEY = 'items'

const items = atom({ plugin: 'prompt-queue', key: 'items' } as const, [])
const editing = atom({ plugin: 'prompt-queue', key: 'editing' } as const, null)

// Claude's palette in mid tones, the same as prompt-deck's band.
const C = { ok: '#8ff0a4', warn: '#ffa348', bad: '#f66151', info: '#99c1f1', next: '#ff7800', muted: '#9a9996' } as const

export function addItem(list: readonly QueueItem[], text: string): QueueItem[] {
  const id = Math.max(0, ...list.map(x => x.id)) + 1
  return [...list, { id, text, status: 'queued' }]
}

// Writes the queue to the session and to the store, so it outlives a restart.
async function save($: EngineInterface, change: (list: QueueItem[]) => QueueItem[]) {
  const next = await update($, items, change)
  await $.store.set(STORE_KEY, next.filter(x => x.status === 'queued'))
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Queue', columns: 52 })

async function send($: EngineInterface, id: number) {
  const item = (await read($, items)).find(x => x.id === id)
  if (!item || item.status !== 'queued') return
  await save($, list => list.map(x => (x.id === id ? { ...x, status: 'sending' } : x)))
  try {
    // Runs as its own turn once Claude is idle.
    await $.prompt.submit({ text: item.text, asUser: true })
    await save($, list => list.filter(x => x.id !== id))
  } catch {
    await save($, list => list.map(x => (x.id === id ? { ...x, status: 'queued' } : x)))
    $.ui.toast('Could not send that prompt; it is still in the queue')
  }
}

async function discard($: EngineInterface, id: number) {
  await save($, list => list.filter(x => x.id !== id))
  await update($, editing, current => (current === id ? null : current))
}

async function saveEdit($: EngineInterface, id: number, text: string) {
  const value = text.trim()
  if (value) await save($, list => list.map(x => (x.id === id ? { ...x, text: value } : x)))
  await update($, editing, () => null)
}

async function add($: EngineInterface, text: string) {
  const value = text.trim()
  if (value) await save($, list => addItem(list, value))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // immediate: typed while Claude works, they run at Enter instead of waiting in Claude Code's input queue.
    await $.command.register({ name: 'add-queue', description: 'Queue a prompt to send later', argumentHint: '<prompt>', immediate: true })
    await $.command.register({ name: 'queue', description: 'Open the prompt queue', immediate: true })
    const kept = await $.store.get(STORE_KEY)
    if (Array.isArray(kept) && kept.length > 0) {
      await update($, items, () => (kept as QueueItem[]).map(x => ({ ...x, status: 'queued' as const })))
      void openPane($)
    }
    return result
  })

  on('command.run', { command: 'add-queue' }, async ($, e) => {
    const text = e.args.trim()
    await openPane($)
    if (!text) return { text: 'Queue opened. Type an idea in its box, or use /add-queue <prompt>.' }
    await add($, text)
    const count = (await read($, items)).filter(x => x.status === 'queued').length
    return { text: `Queued (${count} waiting).` }
  })

  on('command.run', { command: 'queue' }, async $ => {
    await openPane($)
    return { text: 'Queue opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const list = await read($, items)
    const editingId = await read($, editing)
    const waiting = list.filter(x => x.status === 'queued').length

    return (
      <Box flexDirection="column" width={e.props.bodyColumns} paddingX={1} minHeight={e.props.scroll.bodyRows} backgroundColor="#1d1d20">
        <Text>
          <Text color={C.next} bold>Queue</Text>
          <Text color={C.muted}> · {waiting} waiting</Text>
        </Text>
        <Input key="new" placeholder="Add an idea… (Enter to queue)" submitLabel="Queue" onSubmit={(value: string) => add($, value)} />
        {list.length === 0 && <Text color={C.muted}>Nothing queued. /add-queue &lt;prompt&gt; adds one.</Text>}
        {list.map((item, i) => (
          <Box key={`item-${item.id}`} flexDirection="column" marginTop={1}>
            <Text wrap="wrap">
              <Text color={C.next} bold>{i + 1}. </Text>
              <Text dimColor={item.status === 'sending'}>{item.text}</Text>
            </Text>
            {item.status === 'sending' ? (
              <Text color={C.warn}>   ◷ sends when Claude is free</Text>
            ) : editingId === item.id ? (
              <Input key={`edit-${item.id}`} value={item.text} submitLabel="Save" autoFocus onSubmit={(value: string) => saveEdit($, item.id, value)} />
            ) : (
              <Box gap={1}>
                <Button key={`send-${item.id}`} label="Send" variant="primary" onPress={() => send($, item.id)} />
                <Button key={`modify-${item.id}`} label="Modify" onPress={() => update($, editing, () => item.id)} />
                <Button key={`discard-${item.id}`} label="Discard" onPress={() => discard($, item.id)} />
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
