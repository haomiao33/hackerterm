use crate::flow::{FlowWindow, ResumeOutcome};
use portable_pty::{ChildKiller, CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub type DataOut = Arc<dyn Fn(String, Vec<u8>) + Send + Sync>;

/// 读线程停止的原因。读线程一旦停止，这个会话往后就再也不会有新数据流回渲染层——
/// 之前这个事件完全没人知道（`Ok(0) | Err(_) => break` 静默退出，连日志都没有），
/// 真机排障时只能看见"没有数据"这一个症状，猜不出是干净结束还是出错了。
/// 两种情况区分开上报，让上层（router.rs）能分别映射成
/// `SessionState::Closed`（Eof，PTY 从端正常关闭，比如子进程退出前先关了自己的
/// 输出）和 `SessionState::Failed`（Error，携带具体错误信息，真正的异常）。
pub enum ReadStopReason {
    Eof,
    Error(String),
}

/// 流控停摆自愈的现场：读线程等了整整一个看门狗周期，未确认字节数一个字节都没降，
/// 判定 ack 通路已断，于是强制清零未确认窗口继续读。
///
/// 这件事**必须**被上报（见 `SessionManager::open` 的 `on_flow_stalled`）：
/// 清零等于放弃背压，是"两害相权取其轻"的降级，不是修复。静默自愈会让一个真实的
/// ack 链路故障永远不被发现，只留下"偶尔内存涨得厉害"这种查无可查的症状。
pub struct FlowStallReport {
    /// 被强制丢弃的未确认字节数。
    pub unacknowledged_bytes: u64,
    /// 判定停摆用的等待时长（毫秒）。
    pub stalled_ms: u64,
}

pub struct Session {
    pub id: String,
    pair: PtyPair,
    writer: Box<dyn Write + Send>,
    /// 独立于 `Child`（已被等待线程 move 走）的杀进程句柄，`close()` 用它主动终止子进程。
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// 未确认字节数的滑动窗口，读线程用它做 XOFF/XON 流控；`ack()` 从这里减，
    /// `close()` 从这里标记关闭（见 `FlowWindow::close`）。
    flow: Arc<FlowWindow>,
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
    data_out: DataOut,
    /// 当前存活的 PTY 读线程数量：spawn 前 +1，读线程 `loop` 退出后 -1。
    /// 用于诊断与测试，确认会话关闭后读线程确实退出（见 `live_read_threads`）。
    live_read_threads: Arc<std::sync::atomic::AtomicUsize>,
}

/// 默认 shell。Windows 用 PowerShell，macOS 用登录 shell。
fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

impl SessionManager {
    pub fn new(data_out: DataOut) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            data_out,
            live_read_threads: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    /// 当前存活的 PTY 读线程数量。用于诊断与测试，确认会话关闭后线程确实退出。
    pub fn live_read_threads(&self) -> usize {
        self.live_read_threads.load(Ordering::SeqCst)
    }

    pub fn open(
        &self,
        shell: &str,
        cols: u16,
        rows: u16,
        cwd: &str,
        on_exit: Arc<dyn Fn(String, i32) + Send + Sync>,
        on_read_stopped: Arc<dyn Fn(String, ReadStopReason) + Send + Sync>,
        on_flow_stalled: Arc<dyn Fn(String, FlowStallReport) + Send + Sync>,
    ) -> std::io::Result<String> {
        let sys = NativePtySystem::default();
        let pair = sys
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let mut cmd = CommandBuilder::new(if shell.is_empty() { default_shell() } else { shell.to_string() });
        if !cwd.is_empty() {
            cmd.cwd(cwd);
        }
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        // 拿一个独立于 `child`（下面会被等待线程 move 走）的杀进程句柄，
        // 这样 close() 才能主动终止子进程，而不是被动等 PTY 释放。
        let killer = child.clone_killer();

        let id = uuid::Uuid::new_v4().to_string();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        // 流控窗口：未确认字节数超过高水位就暂停读 PTY，降到低水位再恢复。
        // 水位值来自 limits.rs，不在这里写字面量。
        let flow = Arc::new(FlowWindow::new(
            crate::limits::FLOW_HIGH_WATER_BYTES,
            crate::limits::FLOW_LOW_WATER_BYTES,
        ));

        // 读线程：把字节推到数据通道。永远不阻塞控制面。
        let data_out = self.data_out.clone();
        let read_id = id.clone();
        let read_flow = flow.clone();
        let read_stop_id = id.clone();
        let flow_stall_id = id.clone();
        self.live_read_threads.fetch_add(1, Ordering::SeqCst);
        let live_read_threads = self.live_read_threads.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; crate::limits::READ_BUFFER_BYTES];
            loop {
                // 未确认字节数超过高水位：进入暂停，阻塞等到真正降回低水位以下
                // （Resumed）才继续，不能用 !should_pause() 当恢复条件——那样只要
                // 降破高水位就恢复，会在高水位附近反复抖动，架空了 FlowWindow::new
                // 里 `low < high` 迟滞设计的意义。
                //
                // 等待是**条件变量阻塞**而不是自旋轮询（原先是 2ms 一轮，
                // 每会话每秒 500 次无效唤醒，10+ 并发会话就是每秒数千次），
                // 唤醒由 on_ack / close / clear_unacknowledged 推送，见
                // FlowWindow::wait_for_resume。
                //
                // 三种结局分别对应三件不同的事，都不能少：
                // - Closed：`SessionManager::close` remove 会话之后，`ack` 再也无法
                //   触达这个 flow（`sessions.lock().get(id)` 恒为 None），恢复条件
                //   会永远为假。没有这条出口，等待在会话关闭后就再也醒不来——
                //   `killer.kill()` 杀的是子进程，唤不醒卡在这里（根本没走到
                //   `reader.read()`）的读线程。这是修过的一个 Critical，改成条件变量
                //   之后靠 `close()` 里的 notify_all 保住同样的语义。
                // - Stalled：ack 通路断了。强制清零 + 上报，绝不静默（见下）。
                // - Resumed：正常恢复，继续读。
                if read_flow.should_pause() {
                    match read_flow.wait_for_resume(std::time::Duration::from_millis(
                        crate::limits::FLOW_PAUSE_STALL_TIMEOUT_MS,
                    )) {
                        ResumeOutcome::Closed => break,
                        ResumeOutcome::Resumed => {}
                        ResumeOutcome::Stalled { stalled_ms, .. } => {
                            // 放弃背压换取"不永久冻结"。清零之前先把现场读出来，
                            // 上报的是真正被丢掉的那个数字。
                            let unacknowledged_bytes = read_flow.clear_unacknowledged();
                            on_flow_stalled(
                                flow_stall_id.clone(),
                                FlowStallReport { unacknowledged_bytes, stalled_ms },
                            );
                        }
                    }
                }
                match reader.read(&mut buf) {
                    // `Read::read` 的文档契约：`ErrorKind::Interrupted` 不是真错误，
                    // 调用方应当重试。之前这里把它和真错误混在一起直接 break，
                    // 一次被信号打断的无害系统调用就会被误判成"读线程该退出了"，
                    // 之后这个会话的 PTY 输出永久停止、且完全没有任何日志。
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    // 干净 EOF：PTY 从端正常关闭（通常是子进程退出前先关了自己的
                    // 输出端）。这不是错误，但同样要通知上层——不然渲染层只会看到
                    // "数据永远不再来"，猜不出会话已经结束了。
                    Ok(0) => {
                        on_read_stopped(read_stop_id.clone(), ReadStopReason::Eof);
                        break;
                    }
                    // 真正的读错误：把 `ErrorKind` + 原始错误信息都带出去，这是目前
                    // 唯一能回答"读线程到底为什么停了"的证据来源——之前这个分支
                    // 完全静默，真机排障时只能干瞪眼。
                    Err(e) => {
                        on_read_stopped(
                            read_stop_id.clone(),
                            ReadStopReason::Error(format!("{:?}: {e}", e.kind())),
                        );
                        break;
                    }
                    Ok(n) => {
                        data_out(read_id.clone(), buf[..n].to_vec());
                        read_flow.on_sent(n as u64);
                    }
                }
            }
            live_read_threads.fetch_sub(1, Ordering::SeqCst);
        });

        // 等待线程：进程退出后发事件。这是 session.exit 的唯一发射点——
        // 无论子进程自己退出还是 close() 主动 kill 的，都在这里汇合成一次 on_exit。
        // `exited_for_wait` 是防御性去重标记，确保 on_exit 只被这个线程调一次
        // （VS Code terminalProcess.ts 用 `_store.isDisposed` 做同样的事，这里用原子
        // swap）；只被这个闭包捕获，不需要也不应该存进 `Session`——没有别处会读它，
        // 留在结构体上只是一个死字段。
        let exit_id = id.clone();
        let exited_for_wait = Arc::new(AtomicBool::new(false));
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            if exited_for_wait.swap(true, Ordering::SeqCst) {
                // 已经发过一次了（防御性去重，正常路径不会触发，因为这个线程本身只跑一次）
                return;
            }
            on_exit(exit_id, code);
        });

        self.sessions.lock().unwrap().insert(
            id.clone(),
            Session { id: id.clone(), pair, writer, killer, flow },
        );
        Ok(id)
    }

    pub fn write(&self, id: &str, bytes: &[u8]) {
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            let _ = s.writer.write_all(bytes);
            let _ = s.writer.flush();
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if let Some(s) = self.sessions.lock().unwrap().get(id) {
            let _ = s.pair.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    /// 中断信号走这里，不排在输出数据队列后面。
    pub fn signal_int(&self, id: &str) {
        self.write(id, &[0x03]); // Ctrl+C
    }

    /// 渲染层确认消费了 `n` 字节：降低未确认窗口，读线程据此判断能否恢复读 PTY。
    pub fn ack(&self, id: &str, n: u64) {
        if let Some(s) = self.sessions.lock().unwrap().get(id) {
            s.flow.on_ack(n);
        }
    }

    pub fn close(&self, id: &str) {
        if let Some(mut session) = self.sessions.lock().unwrap().remove(id) {
            // 标记 flow 已关闭：暂停等待中的读线程靠这个（而不是 ack）退出，见
            // FlowWindow::close 的文档注释——remove 之后 ack 再也无法触达这个 flow，
            // 不主动标记关闭的话，暂停中的读线程会永远等不到恢复条件。
            // 换成条件变量之后 `close()` 内部会 notify_all，所以这一行既是"改状态"
            // 也是"发唤醒"，缺一个读线程就永远睡死在 wait 里。
            session.flow.close();
            // 主动杀子进程，让等待线程的 child.wait() 醒过来去发那唯一一次 session.exit。
            // 如果进程已经退出了（比如用户自己在 shell 里敲了 exit），kill 会失败，
            // 这里直接吞掉——等待线程早就在路上了，不需要再管。
            let _ = session.killer.kill();
        }
    }
}
