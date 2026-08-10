pub mod dispatch;
pub mod hello;

pub use hello::{MIN_SUPPORTED_MAJOR, PROTOCOL_MAJOR, PROTOCOL_MINOR};

use dispatch::Handled;
use ht_proto::pb::Request;

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
        todo!()
    }

    fn route(&self, req: &Request) -> Handled {
        todo!()
    }

    fn reply(&self, id: u64, result: Handled) {
        todo!()
    }

    pub(crate) fn emit(&self, topic: &str, payload: Vec<u8>) {
        todo!()
    }
}
