import { describe, expect, it, vi } from 'vitest'
import { Envelope } from './hackerterm'
import { ProtocolClient } from './client'

describe('ProtocolClient', () => {
  it('resolves a request when the matching response arrives', async () => {
    const sent: Uint8Array[] = []
    const client = new ProtocolClient({ send: (b) => sent.push(b) })

    const pending = client.request('hello', new Uint8Array([1]))

    const req = Envelope.decode(sent[0]).request!
    client.handleInbound(
      Envelope.encode({ response: { id: req.id, payload: new Uint8Array([9]) } }).finish(),
    )

    await expect(pending).resolves.toEqual(new Uint8Array([9]))
  })

  it('rejects with the structured error, not a rendered string', async () => {
    const client = new ProtocolClient({ send: () => {} })
    const pending = client.request('nope', new Uint8Array())
    const id = 1

    client.handleInbound(
      Envelope.encode({
        response: {
          id,
          error: { code: 1, key: 'err.proto.unknown_method', params: {}, detail: 'x', retryable: false },
        },
      }).finish(),
    )

    await expect(pending).rejects.toMatchObject({ key: 'err.proto.unknown_method' })
  })

  it('ignores events with unknown topics instead of throwing', () => {
    const client = new ProtocolClient({ send: () => {} })
    expect(() =>
      client.handleInbound(
        Envelope.encode({ event: { topic: 'never.seen', payload: new Uint8Array() } }).finish(),
      ),
    ).not.toThrow()
  })

  it('delivers events to subscribers', () => {
    const client = new ProtocolClient({ send: () => {} })
    const fn = vi.fn()
    client.on('session.exit', fn)

    client.handleInbound(
      Envelope.encode({ event: { topic: 'session.exit', payload: new Uint8Array([5]) } }).finish(),
    )

    expect(fn).toHaveBeenCalledWith(new Uint8Array([5]))
  })
})
