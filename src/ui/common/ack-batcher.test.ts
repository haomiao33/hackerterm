import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AckBatcher } from './ack-batcher'
import { FLOW_ACK_BATCH_BYTES, FLOW_ACK_IDLE_FLUSH_MS } from './limits'

/**
 * 用假定时器：空闲兜底的行为必须被断言，但没人愿意让单元测试真的等 200ms，
 * 更不愿意让它在慢机器上抖成随机失败。
 */
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('AckBatcher', () => {
  it('达到阈值前一条 ack 都不发', () => {
    const sent: number[] = []
    const b = new AckBatcher((n) => sent.push(n), 100, 1000)

    b.consumed(30)
    b.consumed(30)
    b.consumed(39) // 累计 99，还差 1

    expect(sent).toEqual([])
    expect(b.pendingBytes).toBe(99)
  })

  it('达到阈值时把攒着的量合并成一次发出去', () => {
    const sent: number[] = []
    const b = new AckBatcher((n) => sent.push(n), 100, 1000)

    b.consumed(30)
    b.consumed(30)
    b.consumed(40) // 累计 100，达到阈值

    expect(sent).toEqual([100])
    expect(b.pendingBytes).toBe(0)
  })

  it('每个按键的回显不再各自触发一次控制面往返', () => {
    // 这条是本次改动要消灭的那个开销的直接探针：一个按键的回显在 PowerShell
    // 上会分两批数据回来，原实现是两趟请求-应答。
    const sent: number[] = []
    const b = new AckBatcher((n) => sent.push(n))

    for (let i = 0; i < 200; i++) {
      b.consumed(1)
      b.consumed(2)
    }

    expect(sent, `200 次按键回显（每次两批）不该产生任何 ack——` +
      `阈值是 ${FLOW_ACK_BATCH_BYTES}B，这点量连零头都不到`).toEqual([])
  })

  it('空闲超时把没达到阈值的残留冲出去', () => {
    const sent: number[] = []
    const b = new AckBatcher((n) => sent.push(n), 100, 1000)

    b.consumed(10)
    vi.advanceTimersByTime(999)
    expect(sent, '还没到空闲超时就不该发').toEqual([])

    vi.advanceTimersByTime(1)
    expect(sent).toEqual([10])
    expect(b.pendingBytes).toBe(0)
  })

  it('空闲定时器只挂在第一笔未冲刷字节上，持续流入时也一定会到期', () => {
    // 反面是"每来一笔就重置定时器"：那样持续刷屏时兜底永远不触发，等于没有。
    const sent: number[] = []
    const b = new AckBatcher((n) => sent.push(n), 10_000, 1000)

    for (let i = 0; i < 20; i++) {
      b.consumed(10)
      vi.advanceTimersByTime(100) // 每 100ms 来一笔，累计 2000ms
    }

    expect(sent.length, '累计远超一个空闲周期，兜底必须已经触发过').toBeGreaterThan(0)
  })

  it('没有攒着的字节时 flush 不发空 ack', () => {
    const sent: number[] = []
    const b = new AckBatcher((n) => sent.push(n), 100, 1000)

    b.flush()
    b.consumed(0)
    b.consumed(-5)
    vi.advanceTimersByTime(10_000)

    expect(sent).toEqual([])
  })

  it('发送失败的那批字节会退回来，下一次冲刷时一起重发', () => {
    // 这是「ack 一丢，核心侧那批字节永远不被确认，累积过高水位后终端永久
    // 冻结」这条静默失效路径的探针。批处理会把单次损失从几字节放大成一整批。
    const sent: number[] = []
    let failNext = true
    const b: AckBatcher = new AckBatcher((n) => {
      sent.push(n)
      if (failNext) {
        failNext = false
        b.returnUnacknowledged(n) // 模拟 client.request 的 catch 分支
      }
    }, 100, 1000)

    b.consumed(100)
    expect(sent).toEqual([100])
    expect(b.pendingBytes, '失败的那批必须还在账上，不能凭空消失').toBe(100)

    b.consumed(50)
    vi.advanceTimersByTime(1000)
    expect(sent, '重发时应该把退回的 100 和新的 50 合在一起').toEqual([100, 150])
    expect(b.pendingBytes).toBe(0)
  })

  it('持续失败时按空闲周期退避重试，不打成死循环', () => {
    // returnUnacknowledged 若走 consumed 的阈值判断，退回的量（本身就 >= 阈值）
    // 会立刻触发重发 → 再失败 → 再重发，同步死循环把 CPU 打满。
    const sent: number[] = []
    const b: AckBatcher = new AckBatcher((n) => {
      sent.push(n)
      b.returnUnacknowledged(n) // 永远失败
    }, 100, 1000)

    b.consumed(100)
    expect(sent.length, '第一次发送 + 退回，不该原地再发一次').toBe(1)

    vi.advanceTimersByTime(1000)
    expect(sent.length, '一个空闲周期后重试一次').toBe(2)
    vi.advanceTimersByTime(1000)
    expect(sent.length, '再一个周期再重试一次').toBe(3)
  })

  it('dispose 之后不再冲刷（对端已经没人处理这条 ack 了）', () => {
    const sent: number[] = []
    const b = new AckBatcher((n) => sent.push(n), 100, 1000)

    b.consumed(10)
    b.dispose()
    vi.advanceTimersByTime(10_000)

    expect(sent).toEqual([])
  })

  it('默认阈值/空闲周期取自 limits，不是就地写死的魔数', () => {
    const sent: number[] = []
    const b = new AckBatcher((n) => sent.push(n))

    b.consumed(FLOW_ACK_BATCH_BYTES - 1)
    expect(sent).toEqual([])
    b.consumed(1)
    expect(sent).toEqual([FLOW_ACK_BATCH_BYTES])

    b.consumed(1)
    vi.advanceTimersByTime(FLOW_ACK_IDLE_FLUSH_MS)
    expect(sent).toEqual([FLOW_ACK_BATCH_BYTES, 1])
  })
})
