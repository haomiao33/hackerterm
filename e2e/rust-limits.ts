/**
 * 从 `crates/ht-core/src/limits.rs` 直接读流控参数的真值。
 *
 * 为什么压测不能把 1MiB / 256KiB / 5s 这些数字抄一份到测试里：压测的**结论**是
 * "这组水位在真实数据量下管用"，一旦测试里的数字和 limits.rs 里的数字各自独立
 * 存在，调参的人改了 limits.rs、测试却还在拿旧数字断言，结论就自动失效而且没人
 * 知道——压测反过来变成了误导。limits.rs 顶部那句"Task 7 的压测会直接扫描这个
 * 文件里的常量组合"说的就是这件事。
 *
 * 解析方式抄的是 `src/limits-drift.test.ts` 里的 `rustConst`（那条测试守的是
 * TS 镜像与 Rust 真值的一致性）。之所以不去 import 它：那是个 `.test.ts`，
 * 归 `vitest run src` 管；端到端跑的是另一份配置，跨过去 import 会把单元测试
 * 文件拖进端到端的模块图里。三行正则，各自持有比耦合便宜。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './electron-app'

const LIMITS_RS = path.join(REPO_ROOT, 'crates/ht-core/src/limits.rs')
const source = readFileSync(LIMITS_RS, 'utf8')

/** 读一个 `pub const NAME: type = 123_456;` 的数值。 */
export function rustLimit(name: string): number {
  const m = new RegExp(`pub const ${name}\\s*:\\s*\\w+\\s*=\\s*([0-9_]+)\\s*;`).exec(source)
  if (!m) throw new Error(`没在 ${LIMITS_RS} 里找到常量 ${name}——是被改名或删掉了吗？`)
  return Number(m[1].replace(/_/g, ''))
}

/** 未确认字节数超过它，读线程暂停读 PTY。 */
export const FLOW_HIGH_WATER_BYTES = rustLimit('FLOW_HIGH_WATER_BYTES')
/** 未确认字节数降到它以下，读线程恢复。 */
export const FLOW_LOW_WATER_BYTES = rustLimit('FLOW_LOW_WATER_BYTES')
/** 暂停期间等这么久还没等到任何 ack，就判定 ack 通路断了，强制清零窗口。 */
export const FLOW_PAUSE_STALL_TIMEOUT_MS = rustLimit('FLOW_PAUSE_STALL_TIMEOUT_MS')
/** 渲染层累计消费多少字节发一次 ack。 */
export const FLOW_ACK_BATCH_BYTES = rustLimit('FLOW_ACK_BATCH_BYTES')
