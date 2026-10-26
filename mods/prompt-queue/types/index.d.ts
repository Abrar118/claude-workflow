export type QueueItem = {
  id: number
  text: string
  status: 'queued' | 'sending'
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-queue': {
      items: QueueItem[]
      /** Id of the item being modified in place. */
      editing: number | null
    }
  }
}
