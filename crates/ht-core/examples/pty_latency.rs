//! PTY 往返时延的**纯 Rust** 测点：从 `SessionManager::write` 调用开始，到读线程
//! 把回传字节交给 `data_out` 回调为止。
//!
//! 对应任务里的 t2 → t3 那一段（Rust 侧写入 PTY 之后 → Rust 侧从 PTY 读回），它
//! 覆盖的是：写 PTY 主端的系统调用 + 内核行规程回显 + 读线程被唤醒 + 读系统调用。
//! 换句话说，这就是「ConPTY / PTY 本身」那部分开销，不含 napi、不含 MessagePort、
//! 不含 xterm。
//!
//! 这是一个**新增文件**，没有改动 crates/ 下任何既有代码一行：埋点做成外部
//! example 而不是往 session.rs 里插时间戳，就是为了完全不碰运行时行为。
//!
//! 跑法：`cargo run -p ht-core --release --example pty_latency`
//! 最后一行会打印 `PTY_LATENCY_JSON {"samples_ms":[...]}`，供 e2e/latency.ts 解析。

use ht_core::session::{FlowStallReport, ReadStopReason, SessionManager};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 采样次数。几十次才谈得上中位数/p95，单次测量只是噪声。
const SAMPLES: usize = 60;
/// 会话刚开起来时 shell 的横幅/提示符还在往外吐，先晾一会儿再开始量。
const WARMUP_MS: u64 = 800;
/// 两次采样之间的间隔，避免上一轮的回传和下一轮的写入挤在一起。
const GAP_MS: u64 = 20;
/// 单次往返的等待上限。正常是毫秒级，超过这个数说明这一轮丢了，跳过不计。
const ROUNDTRIP_TIMEOUT_MS: u64 = 2000;

fn main() {
    let (tx, rx) = mpsc::channel::<()>();
    let data_out: Arc<dyn Fn(String, Vec<u8>) + Send + Sync> = Arc::new(move |_sid, _bytes| {
        // 只关心"回传发生在什么时刻"，内容不重要。发送失败（接收端已丢弃）忽略。
        let _ = tx.send(());
    });

    let manager = SessionManager::new(data_out);
    let session_id = manager
        .open(
            "",
            80,
            24,
            "",
            Arc::new(|_id, _code| {}),
            Arc::new(|_id, _reason: ReadStopReason| {}),
            // 时延测量只写一个字节、立刻读回来，未确认字节数永远贴着 0，
            // 流控停摆看门狗不可能触发；这里给个空回调即可。
            Arc::new(|_id, _report: FlowStallReport| {}),
        )
        .expect("open pty session");

    std::thread::sleep(Duration::from_millis(WARMUP_MS));
    while rx.try_recv().is_ok() {} // 排空热身期间攒下的回传

    let mut samples_ms: Vec<f64> = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        while rx.try_recv().is_ok() {} // 每轮开始前再排空一次，保证配对是一一对应的
        let started = Instant::now();
        // 写一个可打印字符：无论从端有没有 shell 在跑，PTY 的行规程都会把它回显
        // 回主端，所以这一段量到的是 PTY 自己的往返，不掺 shell 的调度抖动。
        manager.write(&session_id, b"x");
        match rx.recv_timeout(Duration::from_millis(ROUNDTRIP_TIMEOUT_MS)) {
            Ok(()) => samples_ms.push(started.elapsed().as_secs_f64() * 1000.0),
            Err(_) => eprintln!("一轮往返超时，跳过"),
        }
        std::thread::sleep(Duration::from_millis(GAP_MS));
    }

    manager.close(&session_id);

    let json: Vec<String> = samples_ms.iter().map(|v| format!("{v:.4}")).collect();
    println!("PTY_LATENCY_JSON {{\"samples_ms\":[{}]}}", json.join(","));
}
