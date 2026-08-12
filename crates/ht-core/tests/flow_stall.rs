//! 新增测试文件：**ack 丢失导致终端永久冻结**这条真实路径的端到端护栏。
//!
//! 这条路径此前一直存在、但从没被任何测试覆盖过：
//! `session.ack` 走请求-应答的控制面，`boot.ts` 里失败只 `catch` 打一行日志，
//! 那批字节就再也不会被确认了。未确认字节数越攒越高，一旦过高水位，读线程就
//! 永久暂停——终端彻底冻住，不抛异常、不报错、日志里也只有"数据不来了"。
//! 本轮的 ack 批处理还会放大它：以前一次丢几个字节，以后一次丢一整批。
//!
//! 修复是给核心加一个看门狗 + 强制清零出口（VS Code
//! `TerminalProcess.clearUnacknowledgedChars()` 的等价物）。这个文件验证的正是
//! 那个出口：**谁都不 ack 的会话最终必须自己恢复，并且把自愈这件事报出来。**

use ht_core::Core;
use ht_proto::pb::{envelope, response, Envelope, Request, SessionOpenRequest, SessionOpenResponse};
use ht_proto::{decode_envelope, encode_envelope};
use prost::Message;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 跟 tests/session.rs、tests/read_stopped.rs 里同名函数一致：Rust 集成测试之间
/// 不共享辅助模块（没有 tests/common/），每个测试文件各自一份是既有模式。
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
    let payload =
        SessionOpenRequest { shell: String::new(), cols: 80, rows: 24, cwd: String::new() }
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

/// 刷屏命令，口径与 tests/session.rs 里的 `flood_command_bytes` 一致。
#[cfg(windows)]
fn flood_command_bytes() -> &'static [u8] {
    b"while ($true) { 'hackerterm' }\r\n"
}
#[cfg(not(windows))]
fn flood_command_bytes() -> &'static [u8] {
    b"yes hackerterm\n"
}

fn total_bytes_for(data: &Arc<Mutex<Vec<(String, Vec<u8>)>>>, sid: &str) -> u64 {
    data.lock()
        .unwrap()
        .iter()
        .filter(|(s, _)| s == sid)
        .map(|(_, b)| b.len() as u64)
        .sum()
}

fn find_flow_stalled_event(
    ctrl: &Arc<Mutex<Vec<Vec<u8>>>>,
) -> Option<ht_proto::pb::SessionFlowStalledEvent> {
    let out = ctrl.lock().unwrap();
    out.iter().find_map(|b| {
        let env = decode_envelope(b).ok()?;
        let envelope::Kind::Event(ev) = env.kind? else { return None };
        if ev.topic != "session.flow_stalled" {
            return None;
        }
        ht_proto::pb::SessionFlowStalledEvent::decode(&ev.payload[..]).ok()
    })
}

fn close(core: &Core, sid: &str) {
    core.handle_inbound(&encode_envelope(&Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 99,
            method: "session.close".into(),
            payload: ht_proto::pb::SessionCloseRequest { session_id: sid.to_string() }
                .encode_to_vec(),
        })),
    }));
}

/// 模拟 ack 彻底丢失：刷屏推过高水位，然后**一次 ack 都不发**。
///
/// 断言两件事，缺一不可：
/// 1. 会话最终自己恢复了产出——不再是永久冻结；
/// 2. 自愈这件事经 `session.flow_stalled` 事件报了出来——不是静默恢复。
///
/// 第 2 条和第 1 条一样重要：强制清零等于放弃背压，如果它悄悄发生，一个真实的
/// ack 链路故障就永远不会被发现，只会留下"内存偶尔涨得厉害"这种查无可查的症状。
#[test]
fn a_session_whose_acks_are_all_lost_recovers_and_reports_it() {
    use ht_core::limits::{FLOW_HIGH_WATER_BYTES, FLOW_PAUSE_STALL_TIMEOUT_MS};

    let (ctrl, data, core) = core_with_sink();
    let sid = open_session(&core, &ctrl);

    // 等 shell 就绪，跟其它 session 测试里用的经验值一致。
    std::thread::sleep(Duration::from_millis(1000));
    core.write_data(&sid, flood_command_bytes());

    // 等未确认字节数越过高水位（这个会话从头到尾没被 ack 过，累计收到的字节数
    // 就等于未确认字节数）。
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if total_bytes_for(&data, &sid) >= FLOW_HIGH_WATER_BYTES {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "10s 内未能让输出越过高水位（{FLOW_HIGH_WATER_BYTES} 字节）——刷屏命令是否真的在产出？"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    // 稳定化：确认读线程真的停了（进入了暂停等待），而不是还在追高水位的路上。
    let mut frozen_at = total_bytes_for(&data, &sid);
    let stabilize_deadline = Instant::now() + Duration::from_secs(3);
    loop {
        std::thread::sleep(Duration::from_millis(50));
        let now = total_bytes_for(&data, &sid);
        if now == frozen_at {
            break;
        }
        frozen_at = now;
        assert!(
            Instant::now() < stabilize_deadline,
            "3s 内读线程一直没有停止产出，说明高水位暂停本身就没生效——本测试的前提不成立"
        );
    }

    // 一个 ack 都不发，等满一个看门狗周期再多留一点余量。
    // 修复前：读线程在这里永远等下去，下面两条断言都会红。
    let wait = Duration::from_millis(FLOW_PAUSE_STALL_TIMEOUT_MS) + Duration::from_secs(2);
    std::thread::sleep(wait);

    let after = total_bytes_for(&data, &sid);
    let stalled = find_flow_stalled_event(&ctrl);

    // 先收摊，别让刷屏命令占着 CPU 影响后面的测试。
    close(&core, &sid);

    assert!(
        after > frozen_at,
        "ack 全部丢失后等了 {wait:?}，会话仍然一个字节都没再产出（冻结在 {frozen_at} 字节）——\
         这就是「ack 一丢，终端永久冻结、且没有任何恢复路径」那条静默失效路径。\
         核心必须有一个强制清零未确认窗口的自愈出口（VS Code clearUnacknowledgedChars 等价物）。"
    );

    let ev = stalled.expect(
        "会话恢复了，但没有任何 session.flow_stalled 事件——静默自愈同样不可接受：\
         强制清零是放弃背压的降级处理，不报出来的话，真实的 ack 链路故障永远不会被发现",
    );
    assert_eq!(ev.session_id, sid);
    assert!(
        ev.unacknowledged_bytes >= FLOW_HIGH_WATER_BYTES,
        "上报的被丢弃字节数 {} 应该不小于高水位 {FLOW_HIGH_WATER_BYTES}（那正是它卡住的原因）",
        ev.unacknowledged_bytes
    );
    assert_eq!(
        ev.stalled_ms, FLOW_PAUSE_STALL_TIMEOUT_MS,
        "上报的停摆时长应该就是看门狗周期"
    );
}

/// 负向对照：正常 ack 的会话不该冒出 `session.flow_stalled`。
///
/// 少了这条，"每隔几秒清一次未确认窗口"这种把背压整个废掉的实现也能让上面那条
/// 测试变绿。
#[test]
fn a_normally_acked_session_never_reports_a_flow_stall() {
    use ht_core::limits::FLOW_PAUSE_STALL_TIMEOUT_MS;

    let (ctrl, data, core) = core_with_sink();
    let sid = open_session(&core, &ctrl);
    std::thread::sleep(Duration::from_millis(1000));
    core.write_data(&sid, flood_command_bytes());

    // 老老实实地跟着 ack：每 50ms 把新收到的字节全部确认掉，未确认字节数始终
    // 贴着 0，读线程根本不会暂停，看门狗自然也没有触发的机会。
    let mut acked: u64 = 0;
    let until = Instant::now() + Duration::from_millis(FLOW_PAUSE_STALL_TIMEOUT_MS) + Duration::from_secs(1);
    let mut req_id = 10u64;
    while Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
        let total = total_bytes_for(&data, &sid);
        if total > acked {
            req_id += 1;
            core.handle_inbound(&encode_envelope(&Envelope {
                kind: Some(envelope::Kind::Request(Request {
                    id: req_id,
                    method: "session.ack".into(),
                    payload: ht_proto::pb::SessionAckRequest {
                        session_id: sid.clone(),
                        bytes_consumed: total - acked,
                    }
                    .encode_to_vec(),
                })),
            }));
            acked = total;
        }
    }

    let stalled = find_flow_stalled_event(&ctrl);
    close(&core, &sid);

    assert!(
        stalled.is_none(),
        "一直被正常 ack 的会话报出了 session.flow_stalled（丢弃了 {} 字节）——\
         看门狗误报，等于把背压整个废掉",
        stalled.map(|e| e.unacknowledged_bytes).unwrap_or(0)
    );
}
