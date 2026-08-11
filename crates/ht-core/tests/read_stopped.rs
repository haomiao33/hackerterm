//! 新增测试文件（不改动任何已有测试文件）：验证 session.rs 读线程停止时
//! （之前是 `Ok(0) | Err(_) => break` 完全静默）现在会经 session.state 事件
//! 报出来，不再是"数据永久不再来、但没人知道为什么"的黑洞状态。
//!
//! 背景：真机（Windows 11）日志显示握手后只收到 3 条数据（约 448B 的 shell
//! 横幅+提示符），远低于流控高水位（1MB），排除流控卡住；之后用户敲了 200
//! 多次键也再没有一条新数据回来——最可能的解释就是读线程静默退出了，但之前
//! 完全没有任何信号能证实。

use ht_core::Core;
use ht_proto::pb::{
    envelope, response, Envelope, Request, SessionOpenRequest, SessionOpenResponse, SessionState,
};
use ht_proto::{decode_envelope, encode_envelope};
use prost::Message;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 跟 tests/session.rs 里同名函数逻辑一致：Rust 集成测试之间不共享辅助模块
/// （没有 tests/common/），每个测试文件各自一份是这套测试基建已有的模式。
fn core_with_sink() -> (Arc<Mutex<Vec<Vec<u8>>>>, Arc<Mutex<Vec<(String, Vec<u8>)>>>, Core) {
    let ctrl = Arc::new(Mutex::new(Vec::new()));
    let data = Arc::new(Mutex::new(Vec::new()));
    let c = ctrl.clone();
    let d = data.clone();
    let core = Core::new_with_data(
        Arc::new(move |b| c.lock().unwrap().push(b)),
        Box::new(move |sid, b| d.lock().unwrap().push((sid, b))),
    );
    (ctrl, data, core)
}

fn open_session(core: &Core, ctrl: &Arc<Mutex<Vec<Vec<u8>>>>) -> String {
    let payload = SessionOpenRequest { shell: String::new(), cols: 80, rows: 24, cwd: String::new() }
        .encode_to_vec();
    core.handle_inbound(&encode_envelope(&Envelope {
        kind: Some(envelope::Kind::Request(Request { id: 1, method: "session.open".into(), payload })),
    }));
    let out = ctrl.lock().unwrap();
    let env = decode_envelope(out.last().expect("no response")).unwrap();
    let Some(envelope::Kind::Response(r)) = env.kind else { panic!() };
    let Some(response::Result::Payload(p)) = r.result else { panic!("open failed") };
    SessionOpenResponse::decode(&p[..]).unwrap().session_id
}

fn find_session_state_event(
    ctrl: &Arc<Mutex<Vec<Vec<u8>>>>,
) -> Option<ht_proto::pb::SessionStateEvent> {
    let out = ctrl.lock().unwrap();
    out.iter().find_map(|b| {
        let env = decode_envelope(b).ok()?;
        let envelope::Kind::Event(ev) = env.kind? else { return None };
        if ev.topic != "session.state" {
            return None;
        }
        ht_proto::pb::SessionStateEvent::decode(&ev.payload[..]).ok()
    })
}

/// session.close() 已经在 tests/session.rs 里被验证过会 kill 子进程、触发
/// on_exit（session.exit 事件）。这条测试确认同一次关闭也会让读线程停止，
/// 并且新增的 session.state 事件把这个事实报出来——不再是修复前那样，读
/// 线程 `Ok(0) | Err(_) => break` 完全静默，外面永远不知道数据为什么不来了。
#[test]
fn closing_a_session_reports_read_thread_stop_via_session_state() {
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

    // 读线程停止是异步的：子进程被 kill 后，阻塞在 reader.read() 上的读线程
    // 要等 OS 真正回收 PTY 相关句柄才会解除阻塞。轮询等它出现，比固定 sleep
    // 更不容易在慢环境下抖动。
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let saw_state = loop {
        if find_session_state_event(&ctrl).is_some() {
            break true;
        }
        if std::time::Instant::now() >= deadline {
            break false;
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    assert!(
        saw_state,
        "expected a session.state event after the read thread stopped following session.close, \
         got none within 5s — the read thread's stop-reporting path may still be silent"
    );

    let state_event = find_session_state_event(&ctrl).expect("session.state event should decode");
    assert_eq!(state_event.session_id, sid);
    // Eof 或 Error 都是合理结果（取决于 kill 之后 OS 具体怎么收尾管道），
    // 但绝不能是 UNKNOWN/CONNECTED——那意味着映射逻辑本身没做对。
    assert!(
        state_event.state == SessionState::Closed as i32
            || state_event.state == SessionState::Failed as i32,
        "expected session.state to be Closed or Failed, got {}",
        state_event.state
    );
}

/// 负向对照：健康、仍在运行的会话不应该无缘无故报出 session.state——避免
/// 修复引入误报（比如把正常的轮询/等待也误判成"读线程停了"）。
#[test]
fn a_healthy_session_does_not_report_read_thread_stop() {
    let (ctrl, _data, core) = core_with_sink();
    let sid = open_session(&core, &ctrl);
    std::thread::sleep(Duration::from_millis(1500));

    assert!(
        find_session_state_event(&ctrl).is_none(),
        "a healthy, still-running session ({sid}) should not emit session.state — \
         got a spurious one, which would mean the fix over-fires"
    );
}
