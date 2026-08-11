import { log } from './log'

/**
 * 主进程（src/main/startup-timing.ts）和 core-host（src/core-host/index.ts）
 * 送过来的时间戳都是 `Date.now()`（epoch 毫秒）——这是跨进程唯一天然可比
 * 的时钟，`process.hrtime.bigint()` 在不同进程里各自有独立的任意零点，
 * 没法互相相减。
 *
 * 这里换算成跟页面自己 `log()` 那套 "+Xms" 前缀同一条时间轴上的偏移量：
 * `performance.timeOrigin` 就是 `performance.now() === 0` 那一刻对应的
 * epoch 时间，送来的 epoch 时间戳减掉它，就是"相对页面开始加载多少毫秒"。
 * 发生在页面开始加载之前的事件（比如 app.whenReady、ht-node 原生模块
 * 加载）算出来是负数，这是预期行为，不是 bug——恰恰是这份埋点要回答的
 * "97 秒到底花在页面加载前还是加载后" 的问题。
 */
export function logStartupTiming(timings: Record<string, number>): void {
  const pageOriginEpochMs = performance.timeOrigin
  for (const [label, epochMs] of Object.entries(timings)) {
    const offsetMs = Math.round(epochMs - pageOriginEpochMs)
    const sign = offsetMs < 0 ? '' : '+'
    log(`${label}: ${sign}${offsetMs}ms (epoch 换算, 与本日志 +Xms 前缀同轴)`)
  }
}
