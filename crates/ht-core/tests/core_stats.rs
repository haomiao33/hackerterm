//! 新增测试文件：`core.stats` —— 把「当前还有几个 PTY 读线程活着」这个数字
//! 经控制面暴露出去。
//!
//! 为什么需要它：`live_read_threads()` 此前只有测试在调，真机上读线程死没死
//! 完全不可见。读线程停止的**正常**路径已经会经 `session.state` 报出来，
//! 但 panic 会直接跳过那条上报路径，而"数据永远不再来"正是本项目反复出现的
//! 症状。事件只能证明发生过什么，证明不了此刻还剩几个线程活着——所以要一个
//! 随时可查的计数，而不是又一个事件。

use ht_core::Core;
use ht_proto::pb::{
    envelope, response, CoreStatsRequest, CoreStatsResponse, Envelope, Request, SessionOpenRequest,
    SessionOpenResponse,
};
use ht_proto::{decode_envelope, encode_envelope};
use prost::Message;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn core_with_sink() -> (Arc<Mutex<Vec<Vec<u8>>>>, Core) {
    let ctrl = Arc::new(Mutex::new(Vec::new()));
    let c = ctrl.clone();
    let core = Core::new_with_data(
        Arc::new(move |b| c.lock().unwrap().push(b)),
        Box::new(|_, _| {}),
    );
    (ctrl, core)
}

fn last_payload(ctrl: &Arc<Mutex<Vec<Vec<u8>>>>) -> Vec<u8> {
    let out = ctrl.lock().unwrap();
    let env = decode_envelope(out.last().expect("没有任何出站消息")).unwrap();
    let Some(envelope::Kind::Response(r)) = env.kind else {
        panic!("最后一条出站消息不是响应")
    };
    match r.result {
        Some(response::Result::Payload(p)) => p,
        Some(response::Result::Error(e)) => {
            panic!("请求返回了错误：code={:?} key={} detail={}", e.code, e.key, e.detail)
        }
        None => panic!("响应里没有 result"),
    }
}

fn request(core: &Core, ctrl: &Arc<Mutex<Vec<Vec<u8>>>>, id: u64, method: &str, payload: Vec<u8>) -> Vec<u8> {
    core.handle_inbound(&encode_envelope(&Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id,
            method: method.into(),
            payload,
        })),
    }));
    last_payload(ctrl)
}

fn live_read_threads_via_protocol(core: &Core, ctrl: &Arc<Mutex<Vec<Vec<u8>>>>, id: u64) -> u32 {
    let p = request(core, ctrl, id, "core.stats", CoreStatsRequest {}.encode_to_vec());
    CoreStatsResponse::decode(&p[..]).unwrap().live_read_threads
}

/// 计数必须真的随会话生命周期变化——不能是一个恒为 0 或恒为 1 的假接口。
///
/// 这条测试专门堵"只测方法存在"这种假测试：开会话前是 0，开了之后是 1，
/// 关掉并等读线程退出之后回到 0，三个点都断言。
#[test]
fn core_stats_reports_live_read_threads_across_a_session_lifecycle() {
    let (ctrl, core) = core_with_sink();

    assert_eq!(
        live_read_threads_via_protocol(&core, &ctrl, 1),
        0,
        "还没开任何会话，存活读线程数应该是 0"
    );

    let payload =
        SessionOpenRequest { shell: String::new(), cols: 80, rows: 24, cwd: String::new() }
            .encode_to_vec();
    let p = request(&core, &ctrl, 2, "session.open", payload);
    let sid = SessionOpenResponse::decode(&p[..]).unwrap().session_id;

    assert_eq!(
        live_read_threads_via_protocol(&core, &ctrl, 3),
        1,
        "开了一条会话之后，存活读线程数应该是 1——这个数字要是不动，\
         这个诊断接口就等于没有（真机上照样看不出读线程死没死）"
    );

    request(
        &core,
        &ctrl,
        4,
        "session.close",
        ht_proto::pb::SessionCloseRequest { session_id: sid }.encode_to_vec(),
    );

    // 读线程退出是异步的（要等 OS 真正解除 reader.read() 的阻塞），轮询等它归零。
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut id = 5;
    let final_count = loop {
        let n = live_read_threads_via_protocol(&core, &ctrl, id);
        id += 1;
        if n == 0 || Instant::now() >= deadline {
            break n;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(final_count, 0, "会话关闭 5s 后存活读线程数仍是 {final_count}，应该已经归零");
}
