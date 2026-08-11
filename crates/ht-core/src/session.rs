use crate::flow::FlowWindow;
use portable_pty::{ChildKiller, CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub type DataOut = Arc<dyn Fn(String, Vec<u8>) + Send + Sync>;

pub struct Session {
    pub id: String,
    pair: PtyPair,
    writer: Box<dyn Write + Send>,
    /// 独立于 `Child`（已被等待线程 move 走）的杀进程句柄，`close()` 用它主动终止子进程。
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// 防御性去重标记：确保 session.exit 只被等待线程的 on_exit 回调发送一次
    /// （VS Code terminalProcess.ts 用 `_store.isDisposed` 做同样的事，这里用原子 swap）。
    exited: Arc<AtomicBool>,
    /// 未确认字节数的滑动窗口，读线程用它做 XOFF/XON 流控；`ack()` 从这里减。
    flow: Arc<FlowWindow>,
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
    data_out: DataOut,
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
        Self { sessions: Mutex::new(HashMap::new()), data_out }
    }

    pub fn open(
        &self,
        shell: &str,
        cols: u16,
        rows: u16,
        cwd: &str,
        on_exit: Arc<dyn Fn(String, i32) + Send + Sync>,
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
        std::thread::spawn(move || {
            let mut buf = vec![0u8; crate::limits::READ_BUFFER_BYTES];
            loop {
                // 未确认字节数超过高水位：进入暂停，自旋等到真正降回低水位以下
                // （should_resume()）才退出，不能用 !should_pause() 当退出条件——
                // 那样只要降破高水位就恢复，会在高水位附近反复抖动，架空了
                // FlowWindow::new 里 `low < high` 迟滞设计的意义。
                // 用轮询而不是条件变量，因为 ack 来自另一个（控制面）线程，
                // 轮询间隔见 limits::FLOW_PAUSE_POLL_INTERVAL_MS 的注释。
                if read_flow.should_pause() {
                    while !read_flow.should_resume() {
                        std::thread::sleep(std::time::Duration::from_millis(
                            crate::limits::FLOW_PAUSE_POLL_INTERVAL_MS,
                        ));
                    }
                }
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        data_out(read_id.clone(), buf[..n].to_vec());
                        read_flow.on_sent(n as u64);
                    }
                }
            }
        });

        // 等待线程：进程退出后发事件。这是 session.exit 的唯一发射点——
        // 无论子进程自己退出还是 close() 主动 kill 的，都在这里汇合成一次 on_exit。
        let exit_id = id.clone();
        let exited = Arc::new(AtomicBool::new(false));
        let exited_for_wait = exited.clone();
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
            Session { id: id.clone(), pair, writer, killer, exited, flow },
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
            // 主动杀子进程，让等待线程的 child.wait() 醒过来去发那唯一一次 session.exit。
            // 如果进程已经退出了（比如用户自己在 shell 里敲了 exit），kill 会失败，
            // 这里直接吞掉——等待线程早就在路上了，不需要再管。
            let _ = session.killer.kill();
        }
    }
}
