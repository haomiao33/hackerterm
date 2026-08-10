pub mod dispatch;
pub mod hello;
pub mod session;

pub use hello::{MIN_SUPPORTED_MAJOR, PROTOCOL_MAJOR, PROTOCOL_MINOR};

use dispatch::{unknown_method, Handled};
use ht_proto::pb::{envelope, response, Envelope, Hello, Request, Response};
use ht_proto::{decode_envelope, encode_envelope};
use prost::Message;
use session::{DataOut, SessionManager};
use std::sync::Arc;

pub type Outbound = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

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

    fn route(&self, req: &Request) -> Handled {
        match req.method.as_str() {
            "hello" => {
                // 对端的 Hello 解析失败也不致命：M0 只回自己的能力集
                let _peer = Hello::decode(&req.payload[..]).ok();
                Ok(hello::core_hello().encode_to_vec())
            }
            "session.open" => {
                use ht_proto::pb::{SessionOpenRequest, SessionOpenResponse};
                let r = SessionOpenRequest::decode(&req.payload[..]).map_err(|e| {
                    dispatch::err(ht_proto::pb::ErrorCode::InvalidArgument,
                                  "err.proto.bad_payload", e.to_string())
                })?;
                let out = self.outbound_clone_for_events();
                let on_exit = Arc::new(move |sid: String, code: i32| {
                    let payload = ht_proto::pb::SessionExitEvent { session_id: sid, exit_code: code }
                        .encode_to_vec();
                    out("session.exit", payload);
                });
                let id = self
                    .sessions
                    .open(&r.shell, r.cols as u16, r.rows as u16, &r.cwd, on_exit)
                    .map_err(|e| dispatch::err(ht_proto::pb::ErrorCode::ConnectFailed,
                                               "err.session.open_failed", e.to_string()))?;
                Ok(SessionOpenResponse { session_id: id }.encode_to_vec())
            }
            "session.resize" => {
                let r = ht_proto::pb::SessionResizeRequest::decode(&req.payload[..])
                    .map_err(|e| dispatch::err(ht_proto::pb::ErrorCode::InvalidArgument,
                                               "err.proto.bad_payload", e.to_string()))?;
                self.sessions.resize(&r.session_id, r.cols as u16, r.rows as u16);
                Ok(ht_proto::pb::Empty {}.encode_to_vec())
            }
            "session.signal" => {
                let r = ht_proto::pb::SessionSignalRequest::decode(&req.payload[..])
                    .map_err(|e| dispatch::err(ht_proto::pb::ErrorCode::InvalidArgument,
                                               "err.proto.bad_payload", e.to_string()))?;
                if r.signal == ht_proto::pb::Signal::Int as i32 {
                    self.sessions.signal_int(&r.session_id);
                }
                Ok(ht_proto::pb::Empty {}.encode_to_vec())
            }
            "session.close" => {
                let r = ht_proto::pb::SessionCloseRequest::decode(&req.payload[..])
                    .map_err(|e| dispatch::err(ht_proto::pb::ErrorCode::InvalidArgument,
                                               "err.proto.bad_payload", e.to_string()))?;
                // 只 kill 子进程，不在这里直接 emit：唯一的 session.exit 发射点是
                // open() 里等待线程的 on_exit 回调（子进程退出后自然触发），
                // 避免这里再发一次导致重复事件（VS Code terminalProcess.ts 的单发射点模式）。
                self.sessions.close(&r.session_id);
                Ok(ht_proto::pb::Empty {}.encode_to_vec())
            }
            other => Err(unknown_method(other)),
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

    pub(crate) fn emit(&self, topic: &str, payload: Vec<u8>) {
        let env = Envelope {
            kind: Some(envelope::Kind::Event(ht_proto::pb::Event {
                topic: topic.to_string(),
                payload,
            })),
        };
        (self.outbound)(encode_envelope(&env));
    }
}
