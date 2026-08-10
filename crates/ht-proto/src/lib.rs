pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/hackerterm.v1.rs"));
}

pub use prost::DecodeError;

pub fn encode_envelope(_env: &pb::Envelope) -> Vec<u8> {
    todo!()
}

pub fn decode_envelope(_bytes: &[u8]) -> Result<pb::Envelope, DecodeError> {
    todo!()
}
