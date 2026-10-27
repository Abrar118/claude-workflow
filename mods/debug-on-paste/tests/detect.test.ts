import { expect, test } from 'claude-code/testing'

import { isError } from '../hooks/register'

test('stack traces count as errors; ordinary prompts do not', () => {
  expect(isError('Caused by: org.flywaydb.core.api.FlywayException: boom\n\tat org.flyway.Foo.bar(Foo.java:12)\n\tat x.y(Z.java:1)')).toBe(true)
  expect(isError('Traceback (most recent call last):\n  File "a.py", line 1\nValueError: bad')).toBe(true)
  expect(isError('fix the login screen please')).toBe(false)
  expect(isError('add an Error: label to the form')).toBe(false)
})

test('PowerShell errors count, in Windows PowerShell 5.1 and PowerShell 7 layouts', () => {
  expect(isError("Get-Item : Cannot find path 'C:\\x' because it does not exist.\nAt line:1 char:1\n+ Get-Item C:\\x\n    + CategoryInfo          : ObjectNotFound: (C:\\x:String) [Get-Item], ItemNotFoundException")).toBe(true)
  expect(isError("Get-Item: C:\\scripts\\a.ps1:3\nLine |\n   3 |  Get-Item C:\\x\n     |  ~~~~~~~~~~~~~\n     | Cannot find path 'C:\\x' because it does not exist.")).toBe(true)
  expect(isError('in PowerShell, list the files\nthen sort them by size\nand show the top 5')).toBe(false)
})
