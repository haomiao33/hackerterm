use ht_core::Core;
use ht_proto::pb::{envelope, response, Envelope, Request, SessionOpenRequest, SessionOpenResponse};
use ht_proto::{decode_envelope, encode_envelope};
use prost::Message;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn core_with_sink() -> (Arc<Mutex<Vec<Vec<u8>>>>, Arc<Mutex<Vec<(String, Vec<u8>)>>>, Core) {
    let ctrl = Arc::new(Mutex::new(Vec::new()));
    let data = Arc::new(Mutex::new(Vec::new()));
    let c = ctrl.clone();
    let d = data.clone();
    let core = Core::new_with_data(
        Box::new(move |b| c.lock().unwrap().push(b)),
        Box::new(move |sid, b| d.lock().unwrap().push((sid, b))),
    );
    (ctrl, data, core)
}

fn open_session(core: &Core, ctrl: &Arc<Mutex<Vec<Vec<u8>>>>) -> String {
    let payload = SessionOpenRequest {
        shell: String::new(),
        cols: 80,
        rows: 24,
        cwd: String::new(),
    }
    .encode_to_vec();
    core.handle_inbound(&encode_envelope(&Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 1,
            method: "session.open".into(),
            payload,
        })),
    }));

    let out = ctrl.lock().unwrap();
    let env = decode_envelope(out.last().expect("no response")).unwrap();
    let Some(envelope::Kind::Response(r)) = env.kind else { panic!() };
    let Some(response::Result::Payload(p)) = r.result else { panic!("open failed") };
    SessionOpenResponse::decode(&p[..]).unwrap().session_id
}

#[test]
fn opening_a_session_returns_an_id_and_produces_output() {
    let (ctrl, data, core) = core_with_sink();
    let sid = open_session(&core, &ctrl);
    assert!(!sid.is_empty());

    // shell 启动后一定会打印提示符
    std::thread::sleep(Duration::from_millis(1500));
    let got = data.lock().unwrap();
    assert!(!got.is_empty(), "expected shell output on the data channel");
    assert_eq!(got[0].0, sid);
}

#[test]
fn writing_to_a_session_echoes_back() {
    let (ctrl, data, core) = core_with_sink();
    let sid = open_session(&core, &ctrl);
    std::thread::sleep(Duration::from_millis(1000));
    data.lock().unwrap().clear();

    core.write_data(&sid, b"echo hackerterm_marker\n");
    std::thread::sleep(Duration::from_millis(1500));

    let got = data.lock().unwrap();
    let all: Vec<u8> = got.iter().flat_map(|(_, b)| b.clone()).collect();
    let text = String::from_utf8_lossy(&all);
    assert!(
        text.contains("hackerterm_marker"),
        "expected marker in output, got: {text}"
    );
}

#[test]
fn closing_a_session_emits_exit_event() {
    let (ctrl, _data, core) = core_with_sink();
    let sid = open_session(&core, &ctrl);
    std::thread::sleep(Duration::from_millis(800));

    core.handle_inbound(&encode_envelope(&Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 2,
            method: "session.close".into(),
            payload: ht_proto::pb::SessionCloseRequest { session_id: sid.clone() }.encode_to_vec(),
        })),
    }));
    std::thread::sleep(Duration::from_millis(500));

    let out = ctrl.lock().unwrap();
    let saw_exit = out.iter().any(|b| {
        matches!(decode_envelope(b).map(|e| e.kind),
            Ok(Some(envelope::Kind::Event(ev))) if ev.topic == "session.exit")
    });
    assert!(saw_exit, "expected a session.exit event");
}
