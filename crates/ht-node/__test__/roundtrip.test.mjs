import test from 'node:test'
import assert from 'node:assert/strict'
import { start, send } from '../index.js'

test('bytes sent into core come back through the callback', async () => {
  const received = []
  start((buf) => received.push(Buffer.from(buf)))

  send(Buffer.from([1, 2, 3]))

  await new Promise((r) => setTimeout(r, 100))

  assert.equal(received.length, 1)
  // M0 阶段核心把收到的字节原样回声，用于验证通道
  assert.deepEqual([...received[0]], [1, 2, 3])
})
