use ht_proto::pb::{envelope, Envelope, Request};
use ht_proto::{decode_envelope, encode_envelope};

#[test]
fn request_survives_roundtrip() {
    let env = Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 42,
            method: "session.open".to_string(),
            payload: vec![9, 8, 7],
        })),
    };

    let bytes = encode_envelope(&env);
    let back = decode_envelope(&bytes).expect("decode should succeed");

    match back.kind {
        Some(envelope::Kind::Request(r)) => {
            assert_eq!(r.id, 42);
            assert_eq!(r.method, "session.open");
            assert_eq!(r.payload, vec![9, 8, 7]);
        }
        other => panic!("expected Request, got {other:?}"),
    }
}

#[test]
fn unknown_bytes_fail_cleanly() {
    // 0xFF 开头不是合法的 protobuf tag，必须返回 Err 而不是 panic
    let err = decode_envelope(&[0xFF, 0xFF, 0xFF]);
    assert!(err.is_err());
}
