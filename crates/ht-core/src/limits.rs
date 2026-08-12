//! 集中所有可调参数：终端 I/O 与流控相关的缓冲区大小、水位线等。
//!
//! 规则：禁止在其他模块里出现裸数值字面量（除 `0`/`1`/`-1`），一律在这里定义
//! 具名常量，并在注释里标注单位 + 来源。来源分两种：
//! - **暂定值**：还没有实测数据支撑，后续压测/评审可能改动。
//! - **实测值**：已经用具体的测量/压测结果验证过，改动前请先看清楚测量方法是否还成立。
//!
//! Task 7 的压测会直接扫描这个文件里的常量组合，所以任何新参数都必须加在这里，
//! 不要散落在调用点。

/// PTY 单次读取的缓冲区大小（字节）。
///
/// 来源：暂定值。Task 7 压测后按实测结果调整（候选范围待压测给出）。
pub const READ_BUFFER_BYTES: usize = 64 * 1024;

/// 流控高水位（字节）：渲染层未确认（已从 PTY 读出但尚未被 xterm 消费并 ack）的字节数
/// 一旦超过这个阈值，读线程就暂停继续读 PTY，防止无限攒积内存。
///
/// 来源：暂定值。Task 7 压测将在 [256KB, 1MB, 4MB] 中扫出最优值，当前先用 1MB 占位。
pub const FLOW_HIGH_WATER_BYTES: u64 = 1_048_576;

/// 流控低水位（字节）：未确认字节数降到此值以下，读线程才恢复读 PTY。
///
/// 来源：暂定值，取高水位的 1/4。Task 7 压测确认最终比例。
pub const FLOW_LOW_WATER_BYTES: u64 = 262_144;

/// 读线程暂停期间的 **ack 停摆看门狗周期**（毫秒）。
///
/// 注意这**不是轮询间隔**：读线程已经改成条件变量阻塞等待（见
/// [`crate::flow::FlowWindow::wait_for_resume`]），正常恢复完全由 `on_ack` /
/// `close` 的通知驱动，暂停期间零 CPU。这个超时只用来发现一种故障：
/// 整整一个周期内未确认字节数一个字节都没降，说明 ack 通路断了（`session.ack`
/// 请求失败、响应丢失、渲染层记账出错都会导致这个结果），此时读线程会强制清零
/// 未确认窗口并把这件事上报出去，而不是永久冻在那里。
///
/// 来源：暂定值。取 5 秒的理由是它必须远大于两个正常量级——渲染层的 ack 空闲
/// 兜底（[`FLOW_ACK_IDLE_FLUSH_MS`] = 200ms）和 xterm 消费一整个高水位窗口
/// （1 MiB，实测远不到 1 秒）——否则会把"消费得慢"误判成"通路断了"；同时又要
/// 短到用户不会把它当成永久卡死（人对"卡住了"的容忍度大约就是几秒）。
/// Task 7 压测后按实测调整。
pub const FLOW_PAUSE_STALL_TIMEOUT_MS: u64 = 5_000;

/// 渲染层累计消费多少字节才发一次 `session.ack`（字节）。
///
/// **硬约束：必须 <= [`FLOW_LOW_WATER_BYTES`]**，下面有编译期断言。理由照搬
/// VS Code `src/vs/platform/terminal/common/terminal.ts` 里 `CharCountAckSize`
/// 的注释：ack 批量一旦大于低水位，读线程因高水位暂停之后，渲染层攒着的那批
/// 未达阈值的 ack 永远发不出去，未确认字节数就永远降不到低水位以下，
/// `should_resume()` 恒为 false——终端从此彻底卡死，且不报任何错。
///
/// 消费方在 TypeScript 侧（`src/ui/common/ack-batcher.ts`，经
/// `src/ui/common/limits.ts` 镜像）：ack 是渲染层发起的，Rust 这边没有调用点。
/// 之所以仍然把值定义在这里，是因为上面那条硬约束的另一个操作数
/// （[`FLOW_LOW_WATER_BYTES`]）只可能住在这个文件里，两个操作数分处两种语言
/// 谁都看不见谁，正是最容易长出静默故障的地方。TS 侧的镜像由
/// `src/ui/common/limits.test.ts` 解析本文件源码做漂移校验。
///
/// 来源：暂定值。取低水位的 1/4，跟本文件里高/低水位之间已有的 1/4 关系一致，
/// 给硬约束留 4 倍余量（VS Code 那边 `CharCountAckSize == LowWatermarkChars`，
/// 恰好压在约束边界上，我们不必这么冒险）。64 KiB 也远大于任何一次按键回显的
/// 量级，足以把"每个按键两趟控制面往返"这个开销整个消掉。
pub const FLOW_ACK_BATCH_BYTES: u64 = 65_536;

/// 攒着的 ack 最多滞留多久就强制冲出去（毫秒）。
///
/// 消费方同样在 TypeScript 侧（见 [`FLOW_ACK_BATCH_BYTES`] 的说明）。
///
/// 来源：暂定值。它不影响正确性（未冲刷的残留量天然被
/// [`FLOW_ACK_BATCH_BYTES`] 封顶），影响的是**下一次洪水的起跑线**：没有兜底
/// 的话，一段安静期结束时最多有 64 KiB 已被消费却仍被核心记为未确认的虚账，
/// 真正刷屏时会让高水位提前撞上。200ms 远低于人对终端响应的感知阈值，
/// 又远高于一次按键回显的往返（本机实测整程 1ms 量级），不会把合批打散。
pub const FLOW_ACK_IDLE_FLUSH_MS: u64 = 200;

/// PTY 出向数据的合批窗口（毫秒）。
///
/// 消费方在 TypeScript 侧（`src/ui/common/data-batcher.ts`，在 core-host
/// 里接在 napi 数据回调和数据面 MessagePort 之间），理由同
/// [`FLOW_ACK_BATCH_BYTES`]：值集中在本文件，TS 侧镜像由单元测试校验漂移。
///
/// 来源：暂定值，取自 VS Code `src/vs/platform/terminal/common/
/// terminalDataBuffering.ts` 的 `throttleBy: number = 5`。**但合批策略跟
/// VS Code 不同**：VS Code 是纯尾沿节流（第一块也要等满 5ms），我们是首沿 +
/// 续窗（空闲后的第一块立即发，窗口内后续块合并），这样孤立的按键回显零额外
/// 延迟，而稳态刷屏的消息率跟 VS Code 一样是每窗口一条。取舍理由写在
/// `data-batcher.ts` 的类注释里。
pub const DATA_BATCH_WINDOW_MS: u64 = 5;

/// 编译期守住"ack 批量 <= 低水位"这条硬约束。
///
/// 写成编译期断言而不是注释里的口头约定：这条约束一旦被破坏，症状是终端在一次
/// 刷屏之后永久冻结、不报任何错，属于本项目最难查的那类故障；而它被破坏的方式
/// 恰恰是有人来调参（Task 7 压测就要扫这些常量）。让它在 `cargo build` 就红。
const _: () = assert!(
    FLOW_ACK_BATCH_BYTES <= FLOW_LOW_WATER_BYTES,
    "FLOW_ACK_BATCH_BYTES 必须 <= FLOW_LOW_WATER_BYTES，否则读线程因高水位暂停后，\
     渲染层攒着的 ack 永远达不到阈值发不出去，未确认字节数降不到低水位以下，\
     终端永久冻结（VS Code CharCountAckSize <= LowWatermarkChars 同理）"
);
