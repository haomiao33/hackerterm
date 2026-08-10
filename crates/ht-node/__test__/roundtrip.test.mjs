import test from 'node:test'
import assert from 'node:assert/strict'
import { start, send } from '../index.js'
import { Envelope, Hello } from '../../../src/ui/common/protocol/hackerterm.ts'

test('hello handshake round-trips through napi', async () => {
  const received = []
  start((buf) => received.push(Buffer.from(buf)))

  const payload = Hello.encode({
    protocolMajor: 1, protocolMinor: 0, minSupportedMajor: 1,
    implVersion: 'test', capabilities: ['terminal'],
  }).finish()

  send(Buffer.from(Envelope.encode({
    request: { id: 1, method: 'hello', payload },
  }).finish()))

  await new Promise((r) => setTimeout(r, 200))

  assert.equal(received.length, 1)
  const env = Envelope.decode(received[0])
  assert.equal(env.response.id, 1)
  const coreHello = Hello.decode(env.response.payload)
  assert.equal(coreHello.protocolMajor, 1)
  assert.ok(coreHello.capabilities.includes('terminal'))
})
