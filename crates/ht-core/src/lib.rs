pub mod dispatch;
pub mod hello;

pub use hello::{MIN_SUPPORTED_MAJOR, PROTOCOL_MAJOR, PROTOCOL_MINOR};

use dispatch::{unknown_method, Handled};
use ht_proto::pb::{envelope, response, Envelope, Hello, Request, Response};
use ht_proto::{decode_envelope, encode_envelope};
use prost::Message;

pub type Outbound = Box<dyn Fn(Vec<u8>) + Send + Sync>;

pub struct Core {
    outbound: Outbound,
}

impl Core {
    pub fn new(outbound: Outbound) -> Self {
        Self { outbound }
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
            other => Err(unknown_method(other)),
        }
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
