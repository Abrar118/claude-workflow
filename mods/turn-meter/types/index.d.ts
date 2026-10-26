export type LastTurn = string

declare module 'claude-code' {
  interface PluginState {
    'turn-meter': { last: LastTurn }
  }
}
