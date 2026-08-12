/**
 * `crates/ht-core/src/limits.rs` 里那些**由 TypeScript 侧消费**的可调参数的镜像。
 *
 * 为什么源头在 Rust 而消费方在 TS：这几个参数描述的是同一套终端 I/O 流控策略，
 * 而这套策略的另一半（高/低水位、读缓冲区大小）本来就只能写在 Rust 里。把批处理
 * 参数散到 TS 这边单独定义，就等于让"ack 批量 ≤ 低水位"这条硬约束的两个操作数
 * 分处两种语言、谁都看不见谁——那正是本项目最怕的那种"看着对、就是不工作"。
 * 所以：**限值的唯一真相在 limits.rs**（带单位后缀与「暂定值/实测值」出处注释），
 * 这里只做镜像，并由 `limits.test.ts` 逐个解析 limits.rs 的源码做漂移校验，
 * 任何一边改了数字而另一边没跟上，单元测试立刻变红。
 *
 * 纯常量模块：不依赖 DOM / Electron / Node（`ui/common` 分层规则强制）。
 */

/**
 * 累计消费多少字节才发一次 `session.ack`（字节）。镜像
 * `limits.rs::FLOW_ACK_BATCH_BYTES`。
 *
 * **硬约束：必须 <= `limits.rs::FLOW_LOW_WATER_BYTES`。** 理由照搬 VS Code
 * `src/vs/platform/terminal/common/terminal.ts` 里 `CharCountAckSize` 的那条
 * 注释：一旦 ack 批量大于低水位，读线程因高水位暂停之后，渲染层攒着的那批
 * 未达阈值的 ack 永远发不出去，未确认字节数就永远降不到低水位以下，
 * `should_resume()` 恒为 false —— 终端从此彻底卡死，而且不报任何错。
 */
export const FLOW_ACK_BATCH_BYTES = 65_536

/**
 * 攒着的 ack 最多滞留多久就强制冲出去（毫秒）。镜像
 * `limits.rs::FLOW_ACK_IDLE_FLUSH_MS`。
 */
export const FLOW_ACK_IDLE_FLUSH_MS = 200

/**
 * PTY 出向数据的合批窗口（毫秒）。镜像 `limits.rs::DATA_BATCH_WINDOW_MS`。
 */
export const DATA_BATCH_WINDOW_MS = 5
