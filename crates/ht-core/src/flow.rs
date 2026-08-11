use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// 未确认字节数的滑动窗口：超过高水位就该暂停读 PTY，降到低水位再恢复（XOFF/XON 语义）。
///
/// 接入点：`SessionManager::open` 里的读线程在循环开头轮询 `should_pause()`、
/// 读到数据后调 `on_sent`；`SessionManager::ack`（对应 `session.ack` 方法）调
/// `on_ack`。高/低水位的默认取值见 [`crate::limits::FLOW_HIGH_WATER_BYTES`]
/// 与 [`crate::limits::FLOW_LOW_WATER_BYTES`]。
///
/// `closed` 是独立于 outstanding 字节计数的第二个退出条件：`SessionManager::close`
/// 会话关闭后，即使从来没有、以后也不会再收到任何 `ack`，暂停中的读线程也必须能
/// 退出自旋——"关闭了"和"消费完了"是两件不同的事，不应该用同一个信号表达
/// （对照 `should_resume`：那是纯粹的字节计数条件，不掺关闭语义）。
pub struct FlowWindow {
    outstanding: AtomicU64,
    high: u64,
    low: u64,
    closed: AtomicBool,
}

impl FlowWindow {
    /// 高水位必须严格大于低水位，否则暂停/恢复会在同一个阈值上抖动。
    pub fn new(high: u64, low: u64) -> Self {
        assert!(low < high, "low water mark must be below high");
        Self { outstanding: AtomicU64::new(0), high, low, closed: AtomicBool::new(false) }
    }

    /// 记录又发送（读到并推给渲染层）了 `n` 字节，尚未确认。
    pub fn on_sent(&self, n: u64) {
        self.outstanding.fetch_add(n, Ordering::SeqCst);
    }

    /// 记录渲染层确认消费了 `n` 字节。渲染层报的数字不可信，需要饱和减法防下溢。
    pub fn on_ack(&self, n: u64) {
        // fetch_update + saturating_sub：渲染层可能因为竞态/bug 报出超过
        // outstanding 的数字，这里绝不能 panic 或下溢成一个巨大的 u64。
        let _ = self.outstanding.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |cur| {
            Some(cur.saturating_sub(n))
        });
    }

    /// 当前未确认字节数。
    pub fn outstanding(&self) -> u64 {
        self.outstanding.load(Ordering::SeqCst)
    }

    /// 未确认字节数是否已达到/超过高水位，读线程应当暂停读 PTY。
    pub fn should_pause(&self) -> bool {
        self.outstanding() >= self.high
    }

    /// 未确认字节数是否已降到低水位以下，读线程可以恢复读 PTY。
    pub fn should_resume(&self) -> bool {
        self.outstanding() < self.low
    }

    /// 标记会话已关闭：暂停中的读线程应立即退出自旋，不再等待任何 ack。
    /// 由 `SessionManager::close` 在 remove 会话时调用。
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    /// 会话是否已关闭。读线程用它作为暂停自旋的第二个退出条件。
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}
