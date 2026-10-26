export type Status = 'open' | 'right' | 'wrong' | 'changed'

export type Assumption = {
  /** Shown as A<id>. */
  id: number
  text: string
  /** What in the task led to it; empty when not given. */
  why: string
  /** The other reasonable choice; empty when not given. */
  alternative: string
  /** What was being built when it was made; empty when not given. */
  area: string
  status: Status
  /** What it should be instead, typed by the person; empty unless changed. */
  correction: string
  /** True once the person's verdict on it was sent to Claude. */
  isSent: boolean
  /** True when a subagent made it. */
  isFromAgent: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'assumption-log': {
      items: Assumption[]
      /** Ids of the cards drawn open. */
      expanded: number[]
      /** True once the pane opened itself this session. */
      hasOpened: boolean
      /** Id of the card whose correction box is open. */
      editing: number | null
      /** Id of the last verdict given, undoable until it is sent; null when none. */
      lastVerdict: number | null
    }
  }
}
