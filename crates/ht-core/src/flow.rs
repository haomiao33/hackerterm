use std::sync::atomic::AtomicU64;

/// 未确认字节数的滑动窗口：超过高水位就该暂停读 PTY，降到低水位再恢复（XOFF/XON 语义）。
///
/// 骨架阶段（Task 6 · 阶段一）：字段与构造函数已定型，`on_sent`/`on_ack`/`outstanding`/
/// `should_pause`/`should_resume` 留 `todo!()`，由阶段二实现并接入 `SessionManager` 的
/// 读线程与 `session.ack`。高/低水位的默认取值见 [`crate::limits::FLOW_HIGH_WATER_BYTES`]
/// 与 [`crate::limits::FLOW_LOW_WATER_BYTES`]。
pub struct FlowWindow {
    outstanding: AtomicU64,
    high: u64,
    low: u64,
}

impl FlowWindow {
    /// 高水位必须严格大于低水位，否则暂停/恢复会在同一个阈值上抖动。
    pub fn new(high: u64, low: u64) -> Self {
        assert!(low < high, "low water mark must be below high");
        Self { outstanding: AtomicU64::new(0), high, low }
    }

    /// 记录又发送（读到并推给渲染层）了 `n` 字节，尚未确认。
    pub fn on_sent(&self, _n: u64) {
        todo!("阶段二实现：累加未确认字节数")
    }

    /// 记录渲染层确认消费了 `n` 字节。渲染层报的数字不可信，需要饱和减法防下溢。
    pub fn on_ack(&self, _n: u64) {
        todo!("阶段二实现：饱和减去已确认字节数，防止下溢（渲染层可能报出超过 outstanding 的数）")
    }

    /// 当前未确认字节数。
    pub fn outstanding(&self) -> u64 {
        todo!("阶段二实现：读取 outstanding 原子值")
    }

    /// 未确认字节数是否已达到/超过高水位，读线程应当暂停读 PTY。
    pub fn should_pause(&self) -> bool {
        todo!("阶段二实现：outstanding() >= self.high")
    }

    /// 未确认字节数是否已降到低水位以下，读线程可以恢复读 PTY。
    pub fn should_resume(&self) -> bool {
        todo!("阶段二实现：outstanding() < self.low")
    }
}
