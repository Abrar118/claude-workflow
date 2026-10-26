import { expect, test } from 'claude-code/testing'

import { addItem } from '../hooks/register'

test('items get increasing ids that never repeat after a discard', async () => {
  let list = addItem([], 'first idea')
  list = addItem(list, 'second idea')
  expect(list.map(x => `${x.id}:${x.text}:${x.status}`)).toEqual(['1:first idea:queued', '2:second idea:queued'])
  expect(addItem([{ id: 5, text: 'kept', status: 'queued' }], 'new').at(-1)!.id).toBe(6)
})
