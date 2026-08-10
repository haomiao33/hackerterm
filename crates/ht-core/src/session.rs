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

        // 读线程：把字节推到数据通道。永远不阻塞控制面。
        let data_out = self.data_out.clone();
        let read_id = id.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; crate::limits::READ_BUFFER_BYTES];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => data_out(read_id.clone(), buf[..n].to_vec()),
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
            Session { id: id.clone(), pair, writer, killer, exited },
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

    pub fn close(&self, id: &str) {
        if let Some(mut session) = self.sessions.lock().unwrap().remove(id) {
            // 主动杀子进程，让等待线程的 child.wait() 醒过来去发那唯一一次 session.exit。
            // 如果进程已经退出了（比如用户自己在 shell 里敲了 exit），kill 会失败，
            // 这里直接吞掉——等待线程早就在路上了，不需要再管。
            let _ = session.killer.kill();
        }
    }
}
