use ht_core::Core;
use ht_proto::pb::{envelope, Envelope, Hello, Request, Response};
use ht_proto::{decode_envelope, encode_envelope};
use prost::Message;
use std::sync::{Arc, Mutex};

fn collect() -> (Arc<Mutex<Vec<Vec<u8>>>>, Box<dyn Fn(Vec<u8>) + Send + Sync>) {
    let sink = Arc::new(Mutex::new(Vec::new()));
    let s = sink.clone();
    (sink, Box::new(move |b| s.lock().unwrap().push(b)))
}

#[test]
fn hello_is_answered_with_core_hello() {
    let (sink, out) = collect();
    let core = Core::new(out);

    let hello = Hello {
        protocol_major: 1,
        protocol_minor: 0,
        min_supported_major: 1,
        impl_version: "shell-test".into(),
        capabilities: vec!["terminal".into()],
    };
    let req = Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 1,
            method: "hello".into(),
            payload: hello.encode_to_vec(),
        })),
    };
    core.handle_inbound(&encode_envelope(&req));

    let out = sink.lock().unwrap();
    assert_eq!(out.len(), 1);
    let env = decode_envelope(&out[0]).unwrap();
    let Some(envelope::Kind::Response(Response { id, result: Some(r) })) = env.kind else {
        panic!("expected Response");
    };
    assert_eq!(id, 1);
    let ht_proto::pb::response::Result::Payload(p) = r else {
        panic!("expected success payload, got error");
    };
    let core_hello = Hello::decode(&p[..]).unwrap();
    assert_eq!(core_hello.protocol_major, 1);
    assert!(core_hello.capabilities.contains(&"terminal".to_string()));
}

#[test]
fn unknown_method_returns_unknown_method_error() {
    let (sink, out) = collect();
    let core = Core::new(out);

    let req = Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 7,
            method: "does.not.exist".into(),
            payload: vec![],
        })),
    };
    core.handle_inbound(&encode_envelope(&req));

    let out = sink.lock().unwrap();
    let env = decode_envelope(&out[0]).unwrap();
    let Some(envelope::Kind::Response(Response { id, result: Some(r) })) = env.kind else {
        panic!("expected Response");
    };
    assert_eq!(id, 7);
    let ht_proto::pb::response::Result::Error(e) = r else {
        panic!("expected error");
    };
    assert_eq!(e.code, ht_proto::pb::ErrorCode::UnknownMethod as i32);
    // 关键：只给 key，不给成品文案
    assert_eq!(e.key, "err.proto.unknown_method");
    assert!(!e.key.is_empty());
}

#[test]
fn garbage_inbound_does_not_panic() {
    let (sink, out) = collect();
    let core = Core::new(out);
    core.handle_inbound(&[0xFF, 0xFF, 0xFF]);
    // 解不出信封时无法知道 id，只能丢弃，不能崩
    assert_eq!(sink.lock().unwrap().len(), 0);
}
