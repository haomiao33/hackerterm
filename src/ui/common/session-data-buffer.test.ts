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

  it('routes to the target session only, even when every session already has a live sink', () => {
    // 上面那条 "keeps separate sessions from cross-talking" 有一个**盲区**：它的两次
    // push 都发生在 attach **之前**，push 那一刻一个 sink 都还没挂上，于是"push 到底
    // 是按 sessionId 路由、还是发给所有人"这件事根本没被执行到。
    //
    // 实测证据（本轮变异验证）：把 push 改成"发给所有已挂载的 sink"（广播），
    // 本文件其余用例连同 e2e/concurrency-core.e2e.ts **全绿通过**。
    // 而真实运行时的形态恰恰相反——十几条会话的数据端口早就都接好了，数据才一块块
    // 地来。这条用例补的就是那个形态。
    const buffer = new SessionDataBuffer()
    const received: Record<string, number[][]> = { a: [], b: [], c: [] }
    for (const id of ['a', 'b', 'c']) {
      buffer.attach(id, (data: Uint8Array) => received[id].push(Array.from(data)))
    }

    buffer.push('b', new Uint8Array([7, 7]))

    expect(received.b).toEqual([[7, 7]])
    // 这两条才是本用例的全部意义：广播的话它们会各多出一条。
    expect(received.a).toEqual([])
    expect(received.c).toEqual([])
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
