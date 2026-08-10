use portable_pty::{CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

pub type DataOut = Arc<dyn Fn(String, Vec<u8>) + Send + Sync>;

pub struct Session {
    pub id: String,
    pair: PtyPair,
    writer: Box<dyn Write + Send>,
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
        todo!()
    }

    pub fn write(&self, id: &str, bytes: &[u8]) {
        todo!()
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        todo!()
    }

    /// 中断信号走这里，不排在输出数据队列后面。
    pub fn signal_int(&self, id: &str) {
        todo!()
    }

    pub fn close(&self, id: &str) {
        todo!()
    }
}
