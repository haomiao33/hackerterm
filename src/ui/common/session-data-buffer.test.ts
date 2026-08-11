import { describe, expect, it, vi } from 'vitest'
import { SessionDataBuffer } from './session-data-buffer'

describe('SessionDataBuffer', () => {
  it('flushes data pushed before attach, in arrival order', () => {
    const buffer = new SessionDataBuffer()
    const received: Uint8Array[] = []

    buffer.push('s1', new Uint8Array([1, 2, 3]))
    buffer.push('s1', new Uint8Array([4, 5]))
    buffer.push('s1', new Uint8Array([6]))

    buffer.attach('s1', (data: Uint8Array) => received.push(data))

    expect(received).toEqual([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6]),
    ])
  })

  it('sends data pushed after attach directly to the sink, bypassing the buffer', () => {
    const buffer = new SessionDataBuffer()
    const received: Uint8Array[] = []

    buffer.attach('s1', (data: Uint8Array) => received.push(data))
    buffer.push('s1', new Uint8Array([7, 8, 9]))

    expect(received).toEqual([new Uint8Array([7, 8, 9])])
    expect(buffer.bufferedBytes('s1')).toBe(0)
  })

  it('keeps separate sessions from cross-talking', () => {
    const buffer = new SessionDataBuffer()
    const receivedA: Uint8Array[] = []
    const receivedB: Uint8Array[] = []

    buffer.push('a', new Uint8Array([1]))
    buffer.push('b', new Uint8Array([2]))

    buffer.attach('a', (data: Uint8Array) => receivedA.push(data))

    expect(receivedA).toEqual([new Uint8Array([1])])
    expect(receivedB).toEqual([])
    expect(buffer.bufferedBytes('b')).toBe(1)

    buffer.attach('b', (data: Uint8Array) => receivedB.push(data))

    expect(receivedB).toEqual([new Uint8Array([2])])
    expect(receivedA).toHaveLength(1)
  })

  it('does not throw and does not deliver to a detached sink when pushed after detach', () => {
    const buffer = new SessionDataBuffer()
    const sink = vi.fn()

    buffer.attach('s1', sink)
    buffer.detach('s1')

    expect(() => buffer.push('s1', new Uint8Array([1, 2, 3]))).not.toThrow()
    expect(sink).not.toHaveBeenCalled()
  })

  it('clears the buffer on detach, leaving no residual bytes', () => {
    const buffer = new SessionDataBuffer()

    buffer.push('s1', new Uint8Array([1, 2, 3, 4]))
    expect(buffer.bufferedBytes('s1')).toBe(4)

    buffer.detach('s1')

    expect(buffer.bufferedBytes('s1')).toBe(0)
  })

  it('preserves exact byte content through buffering, not just length', () => {
    const buffer = new SessionDataBuffer()
    const received: Uint8Array[] = []

    const chunk1 = new Uint8Array([0, 255, 128, 1, 254])
    const chunk2 = new Uint8Array([42, 42, 42])

    buffer.push('s1', chunk1)
    buffer.push('s1', chunk2)

    buffer.attach('s1', (data: Uint8Array) => received.push(data))

    expect(received).toHaveLength(2)
    expect(Array.from(received[0])).toEqual(Array.from(chunk1))
    expect(Array.from(received[1])).toEqual(Array.from(chunk2))
  })
})
