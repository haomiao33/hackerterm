pub mod arrow_frame;
pub mod dispatch;
pub mod flow;
pub mod hello;
pub mod limits;
pub mod router;
pub mod session;

pub use hello::{MIN_SUPPORTED_MAJOR, PROTOCOL_MAJOR, PROTOCOL_MINOR};

use dispatch::Handled;
use ht_proto::pb::{envelope, response, Envelope, Response};
use ht_proto::{decode_envelope, encode_envelope};
use session::{DataOut, SessionManager};
use std::sync::Arc;

pub type Outbound = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// Core 编排入站/出站：解信封、分发（见 `router.rs`）、编响应、发事件。
pub struct Core {
    outbound: Outbound,
    sessions: Arc<SessionManager>,
}

impl Core {
    pub fn new(outbound: Outbound) -> Self {
        Self::new_with_data(outbound, Box::new(|_, _| {}))
    }

    pub fn new_with_data(
        outbound: Outbound,
        data_out: Box<dyn Fn(String, Vec<u8>) + Send + Sync>,
    ) -> Self {
        let data: DataOut = Arc::from(data_out);
        Self { outbound, sessions: Arc::new(SessionManager::new(data)) }
    }

    /// 渲染进程写入的键盘数据走这条，不经过 protobuf。
    pub fn write_data(&self, session_id: &str, bytes: &[u8]) {
        self.sessions.write(session_id, bytes);
    }

    /// 当前存活的 PTY 读线程数量。转发 `SessionManager::live_read_threads`。
    ///
    /// 这个数字此前只有测试在用，真机上"读线程到底死没死"完全看不见——而读线程
    /// 静默退出（panic 会直接跳过 `on_read_stopped` 的上报路径）恰恰是"数据永远
    /// 不再来"这个症状最可能的解释。现在它经控制面的 `core.stats` 方法暴露给
    /// 渲染层（见 `router.rs`），能落进页面日志、也能在 DevTools 里随时查。
    pub fn live_read_threads(&self) -> usize {
        self.sessions.live_read_threads()
    }

    /// 入站字节。解不出信封只能丢弃 —— 没有 id 就无法回响应，但绝不能崩。
    pub fn handle_inbound(&self, bytes: &[u8]) {
        let Ok(env) = decode_envelope(bytes) else {
            return;
        };
        if let Some(envelope::Kind::Request(req)) = env.kind {
            let result = self.route(&req);
            self.reply(req.id, result);
        }
    }

    fn outbound_clone_for_events(&self) -> Arc<dyn Fn(&str, Vec<u8>) + Send + Sync> {
        let out = self.outbound.clone();
        Arc::new(move |topic: &str, payload: Vec<u8>| {
            let env = Envelope {
                kind: Some(envelope::Kind::Event(ht_proto::pb::Event {
                    topic: topic.to_string(),
                    payload,
                })),
            };
            out(encode_envelope(&env));
        })
    }

    fn reply(&self, id: u64, result: Handled) {
        let result = match result {
            Ok(payload) => response::Result::Payload(payload),
            Err(e) => response::Result::Error(e),
        };
        let env = Envelope {
            kind: Some(envelope::Kind::Response(Response {
                id,
                result: Some(result),
            })),
        };
        (self.outbound)(encode_envelope(&env));
    }
}
