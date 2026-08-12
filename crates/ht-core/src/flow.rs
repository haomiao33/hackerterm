use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::Duration;

/// 未确认字节数的滑动窗口：超过高水位就该暂停读 PTY，降到低水位再恢复（XOFF/XON 语义）。
///
/// 接入点：`SessionManager::open` 里的读线程在循环开头检查 `should_pause()`、
/// 暂停时调 [`FlowWindow::wait_for_resume`] 阻塞等待、读到数据后调 `on_sent`；
/// `SessionManager::ack`（对应 `session.ack` 方法）调 `on_ack`。高/低水位的默认
/// 取值见 [`crate::limits::FLOW_HIGH_WATER_BYTES`] 与
/// [`crate::limits::FLOW_LOW_WATER_BYTES`]。
///
/// ── 为什么是条件变量而不是自旋轮询 ───────────────────────────────────────
///
/// 这里原先是 `while !should_resume() && !is_closed() { sleep(2ms) }`：每个会话
/// 一个读线程，暂停期间每秒醒 500 次。产品核心要求写的是「10+ 并发会话」，那就是
/// 每秒数千次纯无效唤醒；而且恢复还要多等最多一个轮询间隔。VS Code 对应的实现
/// （`src/vs/platform/terminal/node/terminalProcess.ts`）是纯事件驱动的
/// `ptyProcess.pause()` / `resume()`，在 `acknowledgeDataEvent` 里立刻恢复，
/// 没有任何轮询。换成 `Condvar` 之后：暂停期间零 CPU，`on_ack` / `close` /
/// `clear_unacknowledged` 直接把它叫醒。
///
/// `closed` 是独立于 outstanding 字节计数的第二个退出条件：`SessionManager::close`
/// 会话关闭后，即使从来没有、以后也不会再收到任何 `ack`，暂停中的读线程也必须能
/// 退出等待——"关闭了"和"消费完了"是两件不同的事，不应该用同一个信号表达
/// （对照 `should_resume`：那是纯粹的字节计数条件，不掺关闭语义）。这条语义是
/// 修过的一个 Critical（暂停态会话关闭后读线程永不退出），换成条件变量时必须原样保住，
/// 所以 `close()` 也要 `notify_all`。
pub struct FlowWindow {
    outstanding: AtomicU64,
    high: u64,
    low: u64,
    closed: AtomicBool,
    /// 只用来给 `Condvar` 配对，不保护任何数据——真正的状态都在上面的原子量里。
    /// 它存在的唯一理由是消灭丢唤醒：等待方在持有它的情况下判定谓词并进入
    /// `wait`，通知方在改完原子量之后必须也拿一次它（见 `wake`）。
    gate: Mutex<()>,
    resumable: Condvar,
}

/// [`FlowWindow::wait_for_resume`] 的三种结局。读线程按这三种情况分别处理。
#[derive(Debug, PartialEq, Eq)]
pub enum ResumeOutcome {
    /// 未确认字节数降破低水位，可以继续读 PTY。
    Resumed,
    /// 会话已关闭，读线程应当退出。
    Closed,
    /// 整整一个看门狗周期内未确认字节数**一个字节都没减少**：ack 通路已经断了。
    /// 详见 [`FlowWindow::wait_for_resume`] 的文档。
    Stalled {
        /// 判定停摆那一刻的未确认字节数。
        unacknowledged_bytes: u64,
        /// 停摆判定用的等待时长（毫秒）。
        stalled_ms: u64,
    },
}

impl FlowWindow {
    /// 高水位必须严格大于低水位，否则暂停/恢复会在同一个阈值上抖动。
    pub fn new(high: u64, low: u64) -> Self {
        assert!(low < high, "low water mark must be below high");
        Self {
            outstanding: AtomicU64::new(0),
            high,
            low,
            closed: AtomicBool::new(false),
            gate: Mutex::new(()),
            resumable: Condvar::new(),
        }
    }

    /// 记录又发送（读到并推给渲染层）了 `n` 字节，尚未确认。
    pub fn on_sent(&self, n: u64) {
        self.outstanding.fetch_add(n, Ordering::SeqCst);
    }

    /// 记录渲染层确认消费了 `n` 字节。渲染层报的数字不可信，需要饱和减法防下溢。
    pub fn on_ack(&self, n: u64) {
        // fetch_update + saturating_sub：渲染层可能因为竞态/bug 报出超过
        // outstanding 的数字，这里绝不能 panic 或下溢成一个巨大的 u64。
        // 对应 VS Code `acknowledgeDataEvent` 里那句
        // `Math.max(this._unacknowledgedCharCount - charCount, 0)`（注释原文
        // "Prevent lower than 0 to heal from errors"），保留。
        let _ = self
            .outstanding
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |cur| {
                Some(cur.saturating_sub(n))
            });
        // 只在真的跨过恢复线时才去碰锁：谓词为假时等待方本来就该继续睡，
        // 不通知不会丢任何东西，而 ack 是热路径（虽然已经批量化了）。
        if self.should_resume() {
            self.wake();
        }
    }

    /// 强制把未确认字节数清零并唤醒暂停中的读线程，返回被丢弃的字节数。
    ///
    /// 这是 VS Code `TerminalProcess.clearUnacknowledgedChars()` 的等价物
    /// （它那边的注释是 "Cleared all unacknowledged chars, forcing resume"）。
    /// 存在的理由是**ack 是可能丢的**：`session.ack` 走请求-应答的控制面，
    /// 请求失败、响应丢失、渲染层记账出错，任何一种都会让那批字节永远得不到确认。
    /// 累积到高水位之后读线程永久暂停，终端彻底冻住，而且不报任何错——正是本项目
    /// 最典型的那类静默失效。有了这个出口，最坏情况从"永久冻结"降级成"丢一次
    /// 流控记账 + 日志里一条明确的告警"。
    ///
    /// 语义上这是**放弃背压**，不是修复：清零之后核心会继续无限制地读 PTY，
    /// 所以调用点必须把它上报出去（见 `session.rs` 的 `on_flow_stalled`），
    /// 绝不允许静默自愈。
    pub fn clear_unacknowledged(&self) -> u64 {
        let previous = self.outstanding.swap(0, Ordering::SeqCst);
        self.wake();
        previous
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

    /// 阻塞等待，直到可以恢复读 PTY、会话关闭、或判定 ack 通路已停摆。
    ///
    /// **暂停期间零 CPU**：靠 `Condvar::wait_timeout` 睡着，由 `on_ack` /
    /// `close` / `clear_unacknowledged` 唤醒。`stall_timeout` 不是轮询间隔，
    /// 是**看门狗周期**——正常恢复完全由通知驱动，超时只用来发现"没人再来 ack 了"。
    ///
    /// 停摆的判据不是"超时了"而是"整整一个周期内 outstanding 一个字节都没降"：
    /// 渲染层只是消费得慢（outstanding 在降、只是还没破低水位）时不该误判，
    /// 那种情况下看门狗重新计时继续等。只有一点进展都没有，才说明 ack 通路真的断了。
    pub fn wait_for_resume(&self, stall_timeout: Duration) -> ResumeOutcome {
        let mut guard = self.gate.lock().unwrap_or_else(PoisonError::into_inner);
        // 参考点：只要 outstanding 相对它有任何下降，就说明 ack 还在流动。
        let mut reference = self.outstanding();
        loop {
            // 谓词判定必须在持有 gate 的情况下做，并且一路持有到进入 wait
            // （`wait_timeout` 会原子地释放锁），否则就是经典的丢唤醒：
            // 判定为假之后、真正睡下之前来的那次 notify 会被彻底错过，
            // 读线程从此永久睡死且不报任何错。
            if self.is_closed() {
                return ResumeOutcome::Closed;
            }
            if self.should_resume() {
                return ResumeOutcome::Resumed;
            }

            let (next_guard, timeout) = self
                .resumable
                .wait_timeout(guard, stall_timeout)
                .unwrap_or_else(PoisonError::into_inner);
            guard = next_guard;

            if !timeout.timed_out() {
                // 被唤醒（或虚假唤醒）：回到循环开头重新判谓词。
                continue;
            }

            let now = self.outstanding();
            if self.is_closed() {
                return ResumeOutcome::Closed;
            }
            if self.should_resume() {
                return ResumeOutcome::Resumed;
            }
            if now < reference {
                // 有进展，只是还没降破低水位：消费方是慢，不是断了。看门狗重新计时。
                reference = now;
                continue;
            }
            return ResumeOutcome::Stalled {
                unacknowledged_bytes: now,
                stalled_ms: stall_timeout.as_millis() as u64,
            };
        }
    }

    /// 标记会话已关闭：暂停中的读线程应立即退出等待，不再等待任何 ack。
    /// 由 `SessionManager::close` 在 remove 会话时调用。
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.wake();
    }

    /// 会话是否已关闭。读线程用它作为等待的第二个退出条件。
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// 唤醒所有等待方。
    ///
    /// 那句看似多余的 `drop(gate.lock())` 是**必须**的，不是仪式：等待方是在持有
    /// `gate` 的情况下判定谓词并进入 `wait` 的，通知方在改完原子量之后也拿一次锁，
    /// 就把两边排成了确定的顺序——要么通知方排在等待方判定谓词之前（等待方随后
    /// 会直接看到新值，根本不会睡），要么排在它已经进入 `wait` 之后（`notify_all`
    /// 一定送达）。少了这一步就是丢唤醒。
    fn wake(&self) {
        drop(self.gate.lock().unwrap_or_else(PoisonError::into_inner));
        self.resumable.notify_all();
    }
}
