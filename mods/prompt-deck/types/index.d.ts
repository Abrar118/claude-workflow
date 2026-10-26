export type Ms = number
export type Git = {
  branch: string
  ahead: number
  behind: number
  hasUpstream: boolean
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
} | null
/** The branch's open pull request and its review decision. */
export type Pr = { number: number; review: string } | null

declare module 'claude-code' {
  interface PluginState {
    'prompt-deck': {
      lastTurnAt: Ms
      now: Ms
      hint: string
      git: Git
      /** Tokens at which the session auto-compacts; null when the engine gives none. */
      compactAt: number | null
      pr: Pr
    }
  }
}
