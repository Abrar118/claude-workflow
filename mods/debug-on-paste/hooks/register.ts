import type { Register } from 'claude-code'

// ponytail: regex heuristic; tune the patterns if it fires on non-errors.
const SIGNALS = [
  /Caused by: /,
  /Traceback \(most recent call last\)/,
  /^\s+at [\w$.<>]+\(.*\)$/m, // Java/JS stack frames
  /^#\d+\s+.+\(package:/m, // Dart/Flutter frames
  /\b\w+(Exception|Error): /,
  /FAILURE: Build failed/,
  /^E\/flutter/m,
  /error TS\d+:/,
]

export const isError = (text: string) => text.includes('\n') && SIGNALS.filter(r => r.test(text)).length >= 1 && text.split('\n').length >= 3

export const register: Register = on => {
  on('prompt.submit', ($, e, next) => {
    if (e.origin.kind !== 'composer' || e.text.startsWith('/') || !isError(e.text)) return next(e)
    $.ui.toast('Error detected: using systematic debugging')
    const hint = 'The user pasted an error. Use the superpowers:systematic-debugging skill: reproduce and find the root cause before changing code.'
    return next({ ...e, context: [...(e.context ?? []), hint] })
  })
}
