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
        Arc::new(move |b| c.lock().unwrap().push(b)),
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

#[test]
fn closing_a_session_emits_exit_exactly_once() {
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
    // 第二次 emit 来自子进程退出后等待线程的 on_exit 回调，需要等更久才会出现
    std::thread::sleep(Duration::from_millis(1500));

    let out = ctrl.lock().unwrap();
    let exit_count = out
        .iter()
        .filter(|b| {
            matches!(decode_envelope(b).map(|e| e.kind),
                Ok(Some(envelope::Kind::Event(ev))) if ev.topic == "session.exit")
        })
        .count();
    assert_eq!(
        exit_count, 1,
        "expected exactly one session.exit event, got {exit_count}"
    );
}

/// `session.ack` 是 Task 6 新增的 RPC 端点，之前零测试覆盖。
/// 这条只验证路由是通的、返回的是成功响应而不是 Error——不涉及流控语义本身
/// （流控语义见下面的 `read_thread_waits_for_low_water_before_resuming`）。
#[test]
fn session_ack_is_routed_without_error() {
    let (ctrl, _data, core) = core_with_sink();
    let sid = open_session(&core, &ctrl);
    std::thread::sleep(Duration::from_millis(500));

    core.handle_inbound(&encode_envelope(&Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 2,
            method: "session.ack".into(),
            payload: ht_proto::pb::SessionAckRequest {
                session_id: sid.clone(),
                bytes_consumed: 4096,
            }
            .encode_to_vec(),
        })),
    }));

    let out = ctrl.lock().unwrap();
    let env = decode_envelope(out.last().expect("no response to session.ack")).unwrap();
    let Some(envelope::Kind::Response(r)) = env.kind else {
        panic!("expected a Response envelope for session.ack, got something else");
    };
    match r.result {
        Some(response::Result::Payload(_)) => {} // success, as expected
        Some(response::Result::Error(e)) => {
            panic!(
                "session.ack returned an error instead of success: code={:?} key={} detail={}",
                e.code, e.key, e.detail
            );
        }
        None => panic!("session.ack response had no result at all"),
    }
}

/// 暴露 session.rs:94 的流控 bug：读线程暂停后应该等未确认字节数降到
/// **低水位**（FLOW_LOW_WATER_BYTES）以下才恢复读 PTY（session.rs:91、
/// limits.rs:27 的注释，以及 flow.rs `FlowWindow::new` 里 `assert!(low < high)`
/// 存在的理由都这么写），但实际代码里读线程的自旋循环写的是
/// `while read_flow.should_pause()`，只要未确认字节数一降回**高水位**以下
/// 就会退出自旋、恢复读取——`should_resume()` 在生产代码里从未被调用过。
///
/// 复现思路：
/// 1. 用 `yes` 让某个会话持续产出，把未确认字节数推过高水位；
/// 2. 只 ack 一部分，让未确认字节数落在「低水位 < x < 高水位」这个区间——
///    按文档，这个区间里读线程应该继续保持暂停；
/// 3. 等一段远大于轮询间隔（`FLOW_PAUSE_POLL_INTERVAL_MS` = 2ms）的时间，
///    看有没有新数据被读出来。有，就说明它错误地恢复了。
///
/// 高低水位阈值都从 `ht_core::limits` 读，不写死字面量——Task 7 压测会调它们。
#[test]
fn read_thread_waits_for_low_water_before_resuming() {
    use ht_core::limits::{FLOW_HIGH_WATER_BYTES, FLOW_LOW_WATER_BYTES};

    let (ctrl, data, core) = core_with_sink();
    let sid = open_session(&core, &ctrl);

    // 等 shell 就绪，跟其它 session 测试里用的经验值一致。
    std::thread::sleep(Duration::from_millis(1000));

    // 持续产出的命令：把未确认字节数推过高水位。
    core.write_data(&sid, b"yes\n");

    fn total_bytes_for(data: &Arc<Mutex<Vec<(String, Vec<u8>)>>>, sid: &str) -> u64 {
        data.lock()
            .unwrap()
            .iter()
            .filter(|(s, _)| s == sid)
            .map(|(_, b)| b.len() as u64)
            .sum()
    }

    // 未确认字节数 == 迄今为止通过数据通道收到的总字节数，因为这个会话
    // 从开始到现在还没有被 ack 过。等它越过高水位。
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if total_bytes_for(&data, &sid) >= FLOW_HIGH_WATER_BYTES {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "5s 内未能让输出越过高水位（{FLOW_HIGH_WATER_BYTES} 字节）——`yes` 是否真的在产出？"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    // 稳定化：此刻读线程应该已经卡在暂停自旋里（不管 bug 存在与否，暂停触发条件
    // 本身没问题），总字节数应该不再增长。用「连续两次相隔 50ms 的读数相等」
    // 代替固定 sleep，避免测量到还在增长的过渡期，读数更确定。
    let mut n1 = total_bytes_for(&data, &sid);
    let stabilize_deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        std::thread::sleep(Duration::from_millis(50));
        let now = total_bytes_for(&data, &sid);
        if now == n1 {
            break;
        }
        n1 = now;
        assert!(
            std::time::Instant::now() < stabilize_deadline,
            "2s 内读线程一直没有停止产出，说明连高水位暂停本身都没生效——\
             这比我们要找的 bug 更严重，先别往下走了"
        );
    }

    // 只 ack 一部分，把未确认字节数降到「低水位 < x < 高水位」区间的中点——
    // 按文档，这个区间里读线程应该继续保持暂停，直到降破低水位。
    let target_outstanding = (FLOW_HIGH_WATER_BYTES + FLOW_LOW_WATER_BYTES) / 2;
    assert!(
        target_outstanding > FLOW_LOW_WATER_BYTES && target_outstanding < FLOW_HIGH_WATER_BYTES,
        "水位中点没有落在低高水位之间，测试前提不成立（检查 limits.rs 里的水位定义）"
    );
    assert!(
        n1 > target_outstanding,
        "总字节数 {n1} 应该已经超过中点 {target_outstanding}（前面已经等它越过了高水位 {FLOW_HIGH_WATER_BYTES}）"
    );
    let ack_amount = n1 - target_outstanding;

    core.handle_inbound(&encode_envelope(&Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 3,
            method: "session.ack".into(),
            payload: ht_proto::pb::SessionAckRequest {
                session_id: sid.clone(),
                bytes_consumed: ack_amount,
            }
            .encode_to_vec(),
        })),
    }));

    // 轮询间隔是 2ms（FLOW_PAUSE_POLL_INTERVAL_MS）：500ms 远够让「正确实现」
    // 稳稳地停在暂停态，也远够让「有 bug 的实现」明显恢复读取并吐出大量新数据
    // （`yes` 吐字节的速度远高于 500ms 内几 KB 的量级）。
    std::thread::sleep(Duration::from_millis(500));
    let n2 = total_bytes_for(&data, &sid);

    // 不管下面的断言成不成立，先关掉会话——别让 `yes` 在后面的测试里继续占 CPU。
    core.handle_inbound(&encode_envelope(&Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 4,
            method: "session.close".into(),
            payload: ht_proto::pb::SessionCloseRequest { session_id: sid.clone() }.encode_to_vec(),
        })),
    }));

    assert_eq!(
        n2, n1,
        "未确认字节数被 ack 降到 {target_outstanding}（低水位 {FLOW_LOW_WATER_BYTES} < x < 高水位 \
         {FLOW_HIGH_WATER_BYTES}，按文档应该继续暂停）之后，读线程又多产出了 {} 字节——\
         说明它只等 outstanding 降回高水位以下（should_pause() 变 false）就恢复读 PTY 了，\
         而不是像注释承诺的那样等到 should_resume()（降破低水位）。这正是 \
         session.rs:94 `while read_flow.should_pause()` 的已知缺陷：should_resume() \
         在生产代码里从未被调用。",
        n2.saturating_sub(n1)
    );
}

/// Critical：暂停态的读线程在会话关闭后永远无法退出。
///
/// 链条：`should_resume()` 只能靠 `FlowWindow::on_ack` 变真；`on_ack` 只能经
/// `SessionManager::ack(id, n)` → `sessions.lock().get(id)` 触达；而
/// `SessionManager::close(id)` 第一件事就是 `sessions.lock().remove(id)`——
/// 移除之后 `get(id)` 恒为 `None`，`ack` 直接短路返回，`on_ack` 永远不会被调，
/// `should_resume()` 永远是 `false`。读线程卡在 session.rs 里那个
/// `while !read_flow.should_resume() { sleep(...) }` 自旋里，永远走不到
/// `reader.read()`，也就永远不会因为 PTY EOF/错误而 `break` 退出。
///
/// `close()` 里的 `killer.kill()` 救不了：它杀的是子进程，但读线程根本没有
/// 阻塞在 `reader.read()` 上，它卡在内层 `while` 自旋里，子进程死不死跟这个
/// 自旋没有关系。`read_flow` 是 `Arc` clone 出来给读线程的，`Session` 从
/// `sessions` 这个 map 里被 remove/drop 也不会让读线程的这份 `Arc` 失效。
///
/// 复现思路：
/// 1. 用 `yes` 把未确认字节数推过高水位，让读线程进入暂停自旋；
/// 2. 确认此时活跃读线程数 >= 1（`live_read_threads()`）；
/// 3. 发 `session.close`；
/// 4. 轮询等待 `live_read_threads()` 降到 0，给足够宽松的超时（3s）——
///    正确实现里 close 应该让读线程很快退出；有 bug 的实现里它永远不会降到 0，
///    这条测试就应该在超时后失败。
///
/// `live_read_threads()` 是编排者与开发 agent 对齐的诊断接口，此刻还不存在，
/// 所以这个测试目前应该在编译期就失败（`SessionManager`/`Core` 没有这个方法）。
/// 等开发 agent 实现之后，如果只是简单地让 `close()` 多做一步"标记该退出"但
/// 没有真正打断内层自旋（比如没有把 `killer.kill()` 换成能唤醒 `reader.read()`
/// 的手段、或者没有给自旋加一个"会话已关闭"的退出条件），这条测试应该会在
/// 步骤 4 超时失败，而不是变成又一个只测"方法存在"的空测试。
#[test]
fn closing_a_paused_session_terminates_its_read_thread() {
    use ht_core::limits::FLOW_HIGH_WATER_BYTES;

    let (ctrl, data, core) = core_with_sink();
    let sid = open_session(&core, &ctrl);

    // 等 shell 就绪，跟其它 session 测试里用的经验值一致。
    std::thread::sleep(Duration::from_millis(1000));

    // 持续产出的命令：把未确认字节数推过高水位，让读线程进入暂停自旋。
    core.write_data(&sid, b"yes\n");

    fn total_bytes_for(data: &Arc<Mutex<Vec<(String, Vec<u8>)>>>, sid: &str) -> u64 {
        data.lock()
            .unwrap()
            .iter()
            .filter(|(s, _)| s == sid)
            .map(|(_, b)| b.len() as u64)
            .sum()
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if total_bytes_for(&data, &sid) >= FLOW_HIGH_WATER_BYTES {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "5s 内未能让输出越过高水位（{FLOW_HIGH_WATER_BYTES} 字节）——`yes` 是否真的在产出？"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    // 稳定化：确认读线程确实已经停止产出（进入了暂停自旋），而不是还在追高水位的路上。
    let mut last = total_bytes_for(&data, &sid);
    let stabilize_deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        std::thread::sleep(Duration::from_millis(50));
        let now = total_bytes_for(&data, &sid);
        if now == last {
            break;
        }
        last = now;
        assert!(
            std::time::Instant::now() < stabilize_deadline,
            "2s 内读线程一直没有停止产出，说明连高水位暂停本身都没生效——\
             这条测试的前提（读线程已进入暂停自旋）不成立"
        );
    }

    assert!(
        core.live_read_threads() >= 1,
        "暂停自旋期间，活跃读线程数应该 >= 1，实际是 {}",
        core.live_read_threads()
    );

    // 在暂停态直接关闭会话——这正是 Critical 复现的关键一步。
    core.handle_inbound(&encode_envelope(&Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 4,
            method: "session.close".into(),
            payload: ht_proto::pb::SessionCloseRequest { session_id: sid.clone() }.encode_to_vec(),
        })),
    }));

    // 轮询等待读线程真正退出，最多给 3 秒——远比 500Hz 的轮询间隔（2ms）宽松，
    // 只要 close() 正确处理了暂停中的读线程，应该在毫秒级就降到 0。
    let close_deadline = std::time::Instant::now() + Duration::from_secs(3);
    let last_count = loop {
        let n = core.live_read_threads();
        if n == 0 || std::time::Instant::now() >= close_deadline {
            break n;
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    assert_eq!(
        last_count, 0,
        "session.close 之后 3000ms，活跃读线程数仍然是 {last_count}（应该是 0）——\
         暂停态的读线程卡在 `while !read_flow.should_resume()` 自旋里退不出来：\
         `close()` 只 remove 了 map 里的 Session 并 kill 了子进程，但读线程既不阻塞在\
         `reader.read()`（kill 唤不醒它），也没有其它方式知道会话已经关闭，于是永远\
         500Hz 空转到进程结束。"
    );
}

/// 补测试盲区：`read_thread_waits_for_low_water_before_resuming` 只验证了负向
/// （"ack 不够时确实没恢复"），审核指出没有任何测试断言"ack 够了以后确实恢复了"。
/// 如果读线程压根不会恢复（比如卡死、或者恢复条件写反了导致永远为 false），
/// 前一条测试照样是绿的——这条测试专门堵这个盲区。
///
/// 复现思路：
/// 1. 用 `yes` 把未确认字节数推过高水位，记下此刻的累计字节数 n1；
/// 2. ack 足够多，让未确认字节数降到**低水位以下**（而不是像负向测试那样只降到
///    低高水位中点）；
/// 3. 等一小段时间；
/// 4. 断言累计字节数 n2 明显大于 n1——读线程确实恢复读 PTY 了。
#[test]
fn read_thread_resumes_after_enough_ack() {
    use ht_core::limits::{FLOW_HIGH_WATER_BYTES, FLOW_LOW_WATER_BYTES};

    let (ctrl, data, core) = core_with_sink();
    let sid = open_session(&core, &ctrl);

    std::thread::sleep(Duration::from_millis(1000));

    core.write_data(&sid, b"yes\n");

    fn total_bytes_for(data: &Arc<Mutex<Vec<(String, Vec<u8>)>>>, sid: &str) -> u64 {
        data.lock()
            .unwrap()
            .iter()
            .filter(|(s, _)| s == sid)
            .map(|(_, b)| b.len() as u64)
            .sum()
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if total_bytes_for(&data, &sid) >= FLOW_HIGH_WATER_BYTES {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "5s 内未能让输出越过高水位（{FLOW_HIGH_WATER_BYTES} 字节）——`yes` 是否真的在产出？"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    // 稳定化：确认读线程确实已经停止产出。
    let mut n1 = total_bytes_for(&data, &sid);
    let stabilize_deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        std::thread::sleep(Duration::from_millis(50));
        let now = total_bytes_for(&data, &sid);
        if now == n1 {
            break;
        }
        n1 = now;
        assert!(
            std::time::Instant::now() < stabilize_deadline,
            "2s 内读线程一直没有停止产出，说明连高水位暂停本身都没生效——\
             这条测试的前提（读线程已进入暂停自旋）不成立"
        );
    }

    // ack 到明显低于低水位，确保落在 should_resume() 为真的区间，而不是卡在中点。
    // 未确认字节数此刻等于 n1（还没被 ack 过）；把它 ack 到低水位的一半。
    let target_outstanding = FLOW_LOW_WATER_BYTES / 2;
    assert!(
        n1 > target_outstanding,
        "总字节数 {n1} 应该已经超过目标 outstanding {target_outstanding}\
         （前面已经等它越过了高水位 {FLOW_HIGH_WATER_BYTES}）"
    );
    let ack_amount = n1 - target_outstanding;

    core.handle_inbound(&encode_envelope(&Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 3,
            method: "session.ack".into(),
            payload: ht_proto::pb::SessionAckRequest {
                session_id: sid.clone(),
                bytes_consumed: ack_amount,
            }
            .encode_to_vec(),
        })),
    }));

    // 给读线程足够时间被轮询唤醒并恢复读取（轮询间隔 2ms，500ms 绰绰有余）。
    std::thread::sleep(Duration::from_millis(500));
    let n2 = total_bytes_for(&data, &sid);

    // 不管断言成不成立，先关掉会话——别让 `yes` 占着 CPU。
    core.handle_inbound(&encode_envelope(&Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 4,
            method: "session.close".into(),
            payload: ht_proto::pb::SessionCloseRequest { session_id: sid.clone() }.encode_to_vec(),
        })),
    }));

    assert!(
        n2 > n1 + FLOW_LOW_WATER_BYTES / 4,
        "ack 到 outstanding = {target_outstanding}（明显低于低水位 {FLOW_LOW_WATER_BYTES}）\
         之后等了 500ms，累计字节数只从 {n1} 长到 {n2}，涨幅不明显——读线程看起来没有\
         真正恢复读 PTY。ack 够了以后读线程应该能继续大量产出（`yes` 的产出速度远高于\
         这个涨幅门槛）。"
    );
}
