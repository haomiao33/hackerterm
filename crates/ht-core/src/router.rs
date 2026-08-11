//! 方法路由分发：`Request.method` -> 具体处理逻辑。
//!
//! 从 `lib.rs` 拆出来的唯一职责是「路由」，不涉及 Core 的构造、出站编码或事件发射
//! 编排（那些留在 `lib.rs`）。`route` 仍以 `impl Core` 的形式出现在这里——Rust 的
//! 可见性按模块树而非文件划分，`router` 是 crate 根的子模块，所以能直接访问
//! `Core` 的私有字段（`sessions`）和私有方法（`outbound_clone_for_events`），
//! 不需要额外开放可见性。

use crate::dispatch::{self, unknown_method, Handled};
use crate::Core;
use ht_proto::pb::{Hello, Request};
use prost::Message;
use std::sync::Arc;

impl Core {
    pub(crate) fn route(&self, req: &Request) -> Handled {
        match req.method.as_str() {
            "hello" => {
                // 对端的 Hello 解析失败也不致命：M0 只回自己的能力集
                let _peer = Hello::decode(&req.payload[..]).ok();
                Ok(crate::hello::core_hello().encode_to_vec())
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
                // 读线程停止（干净 EOF 或真错误）跟子进程退出是两件不同的事——读线程
                // 可能在子进程还活着的时候就先死了（比如管道读错误），这种情况下
                // session.exit 永远不会发，渲染层只会看到数据永久停止、毫无解释。
                // 这里把 crate::session::ReadStopReason 映射成已有的
                // SessionStateEvent（Closed/Failed），复用现成的协议消息，不需要
                // 改 proto/ 里的 schema。
                let out_for_state = self.outbound_clone_for_events();
                let on_read_stopped = Arc::new(move |sid: String, reason: crate::session::ReadStopReason| {
                    let (state, error) = match reason {
                        crate::session::ReadStopReason::Eof => {
                            (ht_proto::pb::SessionState::Closed, None)
                        }
                        crate::session::ReadStopReason::Error(detail) => (
                            ht_proto::pb::SessionState::Failed,
                            Some(dispatch::err(
                                ht_proto::pb::ErrorCode::Internal,
                                "err.session.read_stopped",
                                detail,
                            )),
                        ),
                    };
                    let payload = ht_proto::pb::SessionStateEvent {
                        session_id: sid,
                        state: state as i32,
                        error,
                    }
                    .encode_to_vec();
                    out_for_state("session.state", payload);
                });
                let id = self
                    .sessions
                    .open(&r.shell, r.cols as u16, r.rows as u16, &r.cwd, on_exit, on_read_stopped)
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
            "session.ack" => {
                let r = ht_proto::pb::SessionAckRequest::decode(&req.payload[..])
                    .map_err(|e| dispatch::err(ht_proto::pb::ErrorCode::InvalidArgument,
                                               "err.proto.bad_payload", e.to_string()))?;
                self.sessions.ack(&r.session_id, r.bytes_consumed);
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
}
