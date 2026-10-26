import { expect, test } from 'claude-code/testing'

import { isError } from '../hooks/register'

test('stack traces count as errors; ordinary prompts do not', () => {
  expect(isError('Caused by: org.flywaydb.core.api.FlywayException: boom\n\tat org.flyway.Foo.bar(Foo.java:12)\n\tat x.y(Z.java:1)')).toBe(true)
  expect(isError('Traceback (most recent call last):\n  File "a.py", line 1\nValueError: bad')).toBe(true)
  expect(isError('fix the login screen please')).toBe(false)
  expect(isError('add an Error: label to the form')).toBe(false)
})
