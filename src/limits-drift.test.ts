/**
 * 跨语言常量漂移校验：`src/ui/common/limits.ts` 是 `crates/ht-core/src/limits.rs`
 * 的镜像，这里直接解析 Rust 源码，逐个断言两边的数字一致，并守住那条硬约束。
 *
 * 为什么值得专门写一条测试：ack 批量必须 <= 低水位，而这条约束的两个操作数
 * 一个在 TypeScript（批量，渲染层用）、一个在 Rust（低水位，读线程用）。两边
 * 谁都看不见谁，改错了不报错、不崩，症状是"终端在一次刷屏之后永久冻结"——
 * 本项目最难查的那一类。Rust 侧已经有编译期断言守低水位这一半，这条测试守的
 * 是 TS 镜像跟 Rust 真值之间那一半。
 *
 * 放在 `src/` 根而不是 `src/ui/common/`：那个目录的 eslint 规则禁止 `node:*`
 * 导入（分层约束），而这条测试必须读文件。`src/message-port-transfer.test.ts`
 * 已经是同样的安排。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DATA_BATCH_WINDOW_MS, FLOW_ACK_BATCH_BYTES, FLOW_ACK_IDLE_FLUSH_MS,
} from './ui/common/limits'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIMITS_RS = path.join(REPO_ROOT, 'crates/ht-core/src/limits.rs')

const source = readFileSync(LIMITS_RS, 'utf8')

/** 从 limits.rs 里读一个 `pub const NAME: type = 123_456;` 的数值。 */
function rustConst(name: string): number {
  const m = new RegExp(`pub const ${name}\\s*:\\s*\\w+\\s*=\\s*([0-9_]+)\\s*;`).exec(source)
  if (!m) throw new Error(`没在 ${LIMITS_RS} 里找到常量 ${name}——是被改名或删掉了吗？`)
  return Number(m[1].replace(/_/g, ''))
}

describe('limits.ts 与 crates/ht-core/src/limits.rs 的一致性', () => {
  it.each([
    ['FLOW_ACK_BATCH_BYTES', FLOW_ACK_BATCH_BYTES],
    ['FLOW_ACK_IDLE_FLUSH_MS', FLOW_ACK_IDLE_FLUSH_MS],
    ['DATA_BATCH_WINDOW_MS', DATA_BATCH_WINDOW_MS],
  ])('%s 的 TS 镜像与 Rust 真值一致', (name, tsValue) => {
    expect(tsValue, `${name} 在 limits.rs 和 limits.ts 里对不上——` +
      '限值的唯一真相在 limits.rs，改了那边就得同步这边').toBe(rustConst(name))
  })

  it('ack 批量 <= 低水位（否则暂停后永远等不到能恢复的那一刻）', () => {
    // 依据：VS Code src/vs/platform/terminal/common/terminal.ts 对
    // CharCountAckSize <= LowWatermarkChars 的注释。违反它的症状是终端在一次
    // 刷屏之后彻底冻死，且不报任何错。
    const lowWater = rustConst('FLOW_LOW_WATER_BYTES')
    expect(FLOW_ACK_BATCH_BYTES).toBeLessThanOrEqual(lowWater)
  })

  it('低水位 < 高水位（迟滞带必须存在，否则在阈值上抖动）', () => {
    expect(rustConst('FLOW_LOW_WATER_BYTES')).toBeLessThan(rustConst('FLOW_HIGH_WATER_BYTES'))
  })

  it('ack 空闲兜底远小于流控停摆看门狗周期', () => {
    // 反过来的话，正常会话会在渲染层还没来得及把残留 ack 冲出去之前就被
    // 判定成"ack 通路断了"，看门狗从兜底变成误报源，背压被白白废掉。
    expect(FLOW_ACK_IDLE_FLUSH_MS * 2).toBeLessThan(rustConst('FLOW_PAUSE_STALL_TIMEOUT_MS'))
  })
})
