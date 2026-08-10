pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/hackerterm.v1.rs"));
}

use prost::Message;
pub use prost::DecodeError;

pub fn encode_envelope(env: &pb::Envelope) -> Vec<u8> {
    let mut buf = Vec::with_capacity(env.encoded_len());
    env.encode(&mut buf).expect("Vec never fails to grow");
    buf
}

pub fn decode_envelope(bytes: &[u8]) -> Result<pb::Envelope, DecodeError> {
    pb::Envelope::decode(bytes)
}
