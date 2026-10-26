export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = {
  title: string
  /** The subagent type the task is planned for; empty when not given. */
  agent: string
  after: number[]
}

export type Flow = {
  title: string
  total: number
  done: number
  phase: Phase
  isFinished: boolean
  tasks: PlannedTask[]
}

export type RunStatus = 'running' | 'done' | 'failed'

export type Run = {
  id: string
  type: string
  description: string
  model: string
  effort?: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  /** Size of the last request: what the subagent's context holds now. */
  contextTokens: number
  contextMax: number
  requests: number
  /** Reported by the subagent itself through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
  /** Tokens this subagent has sent and written, cache reads left out. */
  tokens?: number
  /** The last tool the subagent called, as one short line. */
  activity?: string
}

/** One tool call of the main conversation. */
export type Call = {
  id: string
  tool: string
  /** The tool and its first text argument, as one short line. */
  summary: string
  startedAt: number
  endedAt?: number
  status: RunStatus
  /** First line of the error, when it failed. */
  error?: string
  /** The whole command or argument, for the card's expanded view. */
  detail?: string
}

/** A background task the main conversation started (a shell command or a monitor). */
export type Job = {
  id: string
  /** The id the engine gave the task; used to match its end notification. */
  taskId?: string
  kind: 'shell' | 'monitor'
  label: string
  startedAt: number
  endedAt?: number
  status: RunStatus
  note?: string
  /** The file the task writes its output to, when the engine named one. */
  outputPath?: string
  /** The last lines of that file, refreshed while the task runs. */
  tail?: string[]
}

/** One line of the model's own task list (TodoWrite, TaskCreate). */
export type Todo = {
  id?: string
  text: string
  /** What it is doing now, shown while in progress; empty when not given. */
  now: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Whether the main conversation is mid-turn, and since when. */
export type Main = {
  isWorking: boolean
  /** When the current turn started; 0 before any. */
  turnStartedAt: number
  /** What the person asked for in the current (or last) turn, one line. */
  prompt?: string
  /** When the last turn ended; 0 before any. */
  turnEndedAt?: number
}

/** A file the main conversation is editing or edited in the current run, relative to the project. */
export type FileEdit = {
  path: string
  isEditing: boolean
  added: number
  removed: number
}

/** A test or build command and how it ended. */
export type Check = {
  id: string
  command: string
  isOk: boolean
  /** `42 passed, 1 failed`, or the exit status when no counts could be read. */
  summary: string
  /** The first failing test, when one could be read. */
  firstFailure?: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-panel': {
      runs: Run[]
      now: number
      flow: Flow | null
      /** The flow (or 'session') the panel last opened itself for. */
      openedFor: string
      calls: Call[]
      jobs: Job[]
      todos: Todo[]
      /** When the task list last changed. */
      todosAt: number
      /** Ids of running calls drawn open. */
      openCalls: string[]
      main: Main
      files: FileEdit[]
      /** The project's files (git's tracked and untracked), relative to root. */
      tree: string[]
      root: string
      /** Files git reports as changed (modified, staged or untracked), relative to root. */
      changed: string[]
      /** Dirs of the tree the person opened. */
      openDirs: string[]
      /** Keys of the pane's sections the person folded. */
      collapsed: string[]
      checks: Check[]
    }
  }
}
