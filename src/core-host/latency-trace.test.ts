import { describe, expect, it } from 'vitest'
import { LatencyTrace, LATENCY_TRACE_ENABLED, LATENCY_TRACE_PREFIX } from './latency-trace'

/**
 * 这个埋点唯一的产出就是"哪一次出向对应哪一次入向"，配对错了它给出的分段就是
 * 假的——而假的时延数字比没有数字更糟（会直接把优化投到错误的地方）。所以这里
 * 逐个把会配错的情形钉死。
 */
function collect(): { lines: string[], trace: LatencyTrace } {
  const lines: string[] = []
  return { lines, trace: new LatencyTrace((line) => lines.push(line)) }
}

function parse(line: string): { seq: number, ms: number, orphanOutbound: number, overlappedInbound: number } {
  expect(line.startsWith(LATENCY_TRACE_PREFIX)).toBe(true)
  return JSON.parse(line.slice(LATENCY_TRACE_PREFIX.length))
}

describe('LatencyTrace', () => {
  it('默认关闭：没有 HT_LATENCY_TRACE=1 就不启用', () => {
    // 这条是防呆：这个开关一旦被误改成默认开启，生产热路径上就会多出时钟读取
    // 和跨进程上报，而且没人会注意到。
    expect(LATENCY_TRACE_ENABLED).toBe(process.env.HT_LATENCY_TRACE === '1')
    expect(LATENCY_TRACE_ENABLED).toBe(false)
  })

  it('一入一出配成一个样本，取的是两个时刻的差', () => {
    const { lines, trace } = collect()
    trace.inbound(100)
    trace.outbound(100.75)
    expect(lines).toHaveLength(1)
    expect(parse(lines[0])).toMatchObject({ seq: 1, ms: 0.75 })
  })

  it('没有入向的出向不产生样本，只计数（会话横幅就是这种）', () => {
    const { lines, trace } = collect()
    trace.outbound(10)
    trace.outbound(11)
    expect(lines).toHaveLength(0)
    trace.inbound(20)
    trace.outbound(21)
    expect(parse(lines[0])).toMatchObject({ seq: 1, ms: 1, orphanOutbound: 2 })
  })

  it('一次按键回来多块数据：只有第一块配对，其余记成 orphan', () => {
    // PowerShell 实测一次按键的回显分两批回来。第二批不能也算一个样本，
    // 否则样本数会比按键数多——Windows CI 上 60 次按键量出 61 个样本正是这类
    // 配对错乱的信号。
    const { lines, trace } = collect()
    trace.inbound(0)
    trace.outbound(1)
    trace.outbound(3)
    expect(lines).toHaveLength(1)
    expect(parse(lines[0]).ms).toBe(1)

    trace.inbound(10)
    trace.outbound(11)
    expect(parse(lines[1])).toMatchObject({ seq: 2, ms: 1, orphanOutbound: 1 })
  })

  it('上一轮还没等到出向就又来了入向：计入 overlappedInbound，时刻取新的那次', () => {
    const { lines, trace } = collect()
    trace.inbound(0)
    trace.inbound(5) // 上一轮丢了
    trace.outbound(6)
    expect(parse(lines[0])).toMatchObject({ seq: 1, ms: 1, overlappedInbound: 1 })
  })
})
