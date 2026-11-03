import type { Register } from 'claude-code'

// ponytail: regex heuristic; tune the patterns if it fires on non-errors.
const SIGNALS = [
  /Caused by: /,
  /Traceback \(most recent call last\)/,
  /^[ \t]+at [\w$.<>]+\(.*\)$/m, // Java/JS stack frames; [ \t] not \s, which re-scans blank-line runs on every line
  /^#\d+\s+.+\(package:/m, // Dart/Flutter frames
  /\b\w+(Exception|Error): /,
  /FAILURE: Build failed/,
  /^E\/flutter/m,
  /error TS\d+:/,
  /^[ \t]*\+ (CategoryInfo|FullyQualifiedErrorId)\s+:/m, // Windows PowerShell 5.1 error records
  /^At (line:\d+|.+:\d+) char:\d+/m,
  /^Line \|\s*$/m, // PowerShell 7's concise error view
]

export const isError = (text: string) => text.includes('\n') && text.split('\n', 3).length >= 3 && SIGNALS.some(r => r.test(text))

export const register: Register = on => {
  on('prompt.submit', ($, e, next) => {
    if (e.origin.kind !== 'composer' || e.text.startsWith('/') || !isError(e.text)) return next(e)
    $.ui.toast('Error detected: using systematic debugging')
    const hint = 'The user pasted an error. Use the superpowers:systematic-debugging skill: reproduce and find the root cause before changing code.'
    return next({ ...e, context: [...(e.context ?? []), hint] })
  })
}
