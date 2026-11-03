import type { Register } from 'claude-code'

const PROGRESS = 'mcp__agent-panel__progress'
// Calls that keep a task list too.
const LISTS = /^(TodoWrite|TaskCreate|TaskUpdate)$/
// The rule asks for a list on tasks of 3 or more steps.
const EVERY = 3

export const register: Register = on => {
  let sinceUpdate = 0
  let isOpen = false
  let hasList = false

  // Main loop only: subagents report through their own step tool.
  on('turn.start', ($, e, next) => {
    if (!e.agentId && !isOpen) [sinceUpdate, hasList] = [0, false]
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    if (e.tool === PROGRESS || LISTS.test(e.tool)) {
      sinceUpdate = 0
      hasList = true
      if (e.tool === PROGRESS) isOpen = (e as unknown as { finished?: boolean }).finished !== true
      return next(e)
    }
    const result = await next(e)
    if (result.deny !== undefined || ++sinceUpdate % EVERY !== 0) return result
    const note = hasList
      ? `progress-guard: ${sinceUpdate} tool calls since the task list was updated. Call progress now with the new done count.`
      : `progress-guard: ${sinceUpdate} tool calls and no task list. If this task has 3 or more steps, call progress now with title, total, tasks and done.`
    return { ...result, context: [...(result.context ?? []), note] }
  })

  on('turn.complete', ($, e, next) => {
    if (!e.agentId && e.reason === 'answer' && (isOpen || (!hasList && sinceUpdate >= EVERY))) {
      $.ui.toast(isOpen ? 'progress-guard: task list left open' : 'progress-guard: no task list for this turn')
    }
    return next(e)
  })
}
