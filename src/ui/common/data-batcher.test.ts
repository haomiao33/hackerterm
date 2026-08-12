import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataBatcher } from './data-batcher'
import { DATA_BATCH_WINDOW_MS } from './limits'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** 把收到的块摊平成一个数字数组，断言读起来直观些。 */
const flat = (chunks: Uint8Array[]): number[][] => chunks.map((c) => [...c])

describe('DataBatcher', () => {
  it('孤立的一块立即发出，不加任何延迟', () => {
    // 这是本项目跟 VS Code 取舍不同的那一点：VS Code 的 TerminalDataBufferer
    // 第一块也要等满 throttleBy(5ms)，对一次按键回显那 5ms 是纯粹的延迟惩罚。
    const got: Uint8Array[] = []
    const b = new DataBatcher((d) => got.push(d), 5)

    b.push(new Uint8Array([1, 2, 3]))

    // 一个定时器都还没推进，它就应该已经出去了。
    expect(flat(got), '空闲后的第一块必须零延迟发出').toEqual([[1, 2, 3]])
  })

  it('窗口内接连到达的块合并成一条', () => {
    const got: Uint8Array[] = []
    const b = new DataBatcher((d) => got.push(d), 5)

    b.push(new Uint8Array([1]))      // 首块，立即出
    b.push(new Uint8Array([2, 3]))   // 窗口内，攒着
    b.push(new Uint8Array([4]))      // 窗口内，攒着
    expect(flat(got)).toEqual([[1]])

    vi.advanceTimersByTime(5)
    expect(flat(got), '窗口到期时后两块应该合成一条').toEqual([[1], [2, 3, 4]])
  })

  it('持续刷屏时稳态是每个窗口一条消息，不会退化成合一条发一条', () => {
    // "首块立即发"最容易踩的坑：窗口到期后回到空闲态，于是下一块又被当成
    // 首块单发，合批率被腰斩。这里用一个每毫秒来一块的持续流做探针。
    const got: Uint8Array[] = []
    const b = new DataBatcher((d) => got.push(d), 5)

    for (let i = 0; i < 100; i++) {
      b.push(new Uint8Array([i & 0xff]))
      vi.advanceTimersByTime(1)
    }

    // 100 块、100ms、窗口 5ms → 理想是 1（首块）+ 20（每窗口一条）左右。
    // 放宽到 <= 25 条：真退化成"合一条发一条"会是 ~34 条，退化成完全不合批
    // 是 100 条，这个界都能抓住。
    expect(got.length, `100 块连续数据被拆成了 ${got.length} 条消息——合批退化了`)
      .toBeLessThanOrEqual(25)
    expect(got.length, '也不该少到说明有数据被吞了').toBeGreaterThan(1)

    // 一个字节都不能丢，顺序也不能乱。
    const all = got.flatMap((c) => [...c])
    expect(all).toEqual(Array.from({ length: 100 }, (_, i) => i & 0xff))
  })

  it('安静下来之后窗口关闭，下一块重新享受零延迟', () => {
    const got: Uint8Array[] = []
    const b = new DataBatcher((d) => got.push(d), 5)

    b.push(new Uint8Array([1]))
    vi.advanceTimersByTime(50) // 窗口内什么都没来，回到空闲态
    expect(flat(got)).toEqual([[1]])

    b.push(new Uint8Array([2]))
    expect(flat(got), '安静之后的第一块必须又是立即发').toEqual([[1], [2]])
  })

  it('合批不改变字节内容与顺序', () => {
    const got: Uint8Array[] = []
    const b = new DataBatcher((d) => got.push(d), 5)

    b.push(new Uint8Array([10]))
    b.push(new Uint8Array([20, 21]))
    b.push(new Uint8Array([30, 31, 32]))
    vi.advanceTimersByTime(5)

    expect(got.flatMap((c) => [...c])).toEqual([10, 20, 21, 30, 31, 32])
  })

  it('空块被忽略，不会平白开一个窗口', () => {
    const got: Uint8Array[] = []
    const b = new DataBatcher((d) => got.push(d), 5)

    b.push(new Uint8Array([]))
    expect(got).toEqual([])

    b.push(new Uint8Array([7]))
    expect(flat(got), '前面那个空块不该把窗口开起来、害这一块被延迟').toEqual([[7]])
  })

  it('dispose 停掉窗口并丢弃攒着的数据', () => {
    const got: Uint8Array[] = []
    const b = new DataBatcher((d) => got.push(d), 5)

    b.push(new Uint8Array([1]))
    b.push(new Uint8Array([2]))
    expect(b.bufferedBytes).toBe(1)

    b.dispose()
    vi.advanceTimersByTime(1000)

    expect(flat(got), 'dispose 之后不该再往已关闭的端口上写').toEqual([[1]])
    expect(b.bufferedBytes).toBe(0)
  })

  it('默认窗口取自 limits，不是就地写死的魔数', () => {
    const got: Uint8Array[] = []
    const b = new DataBatcher((d) => got.push(d))

    b.push(new Uint8Array([1]))
    b.push(new Uint8Array([2]))
    vi.advanceTimersByTime(DATA_BATCH_WINDOW_MS - 1)
    expect(flat(got)).toEqual([[1]])
    vi.advanceTimersByTime(1)
    expect(flat(got)).toEqual([[1], [2]])
  })
})
