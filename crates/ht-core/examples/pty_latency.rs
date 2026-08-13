//! PTY 往返时延的**纯 Rust** 测点：从 `SessionManager::write` 调用开始，到读线程
//! 把回传字节交给 `data_out` 回调为止。
//!
//! 覆盖的是：写 PTY 主端的系统调用 → 从端那头的程序（shell 或别的什么）把这个
//! 字节回显出来 → 读线程被唤醒 → 读系统调用。**注意"回显是谁做的"这件事**：
//! 类 Unix 下如果从端跑的是交互式 shell，readline/zle 会把终端设成 raw 模式，
//! 回显由 shell 自己做，这一段就**包含了 shell 每次按键的全部工作**（语法高亮、
//! 整行重绘……）；只有从端程序不碰 termios 时（比如 `cat`），回显才来自内核行
//! 规程。Windows 上没有行规程这回事，ConPTY 的回显一律来自 conhost + 从端程序
//! （PowerShell 的 PSReadLine）。所以这个 example 量到的**不是"PTY 自己"**，
//! 而是"PTY + 从端程序的按键处理"，命名和口径都按这个来（`e2e/shell-cost.ts`
//! 专门量这两者的差）。
//!
//! 这是一个**新增文件**，没有改动 crates/ 下任何既有代码一行：埋点做成外部
//! example 而不是往 session.rs 里插时间戳，就是为了完全不碰运行时行为。
//!
//! 跑法：`cargo run -p ht-core --release --example pty_latency`
//! 最后一行会打印 `PTY_LATENCY_JSON {...}`，供 e2e/latency.ts 解析。
//!
//! 采样节奏由环境变量控制，**默认值必须和 e2e/latency-protocol.ts 里的一致**：
//! 三段测量只有在"晾多久、丢几个预热样本、两轮间隔多少"完全相同的前提下才谈得上
//! 放在一起看。历史教训：这里原本晾 800ms、间隔 20ms，而 NAPI/FULL 两段晾 1000ms、
//! 间隔 120ms，于是这一段整个采样窗口（60×20ms≈1.2s）全都落在 shell 还没热起来的
//! 阶段里，量出来的 p95/max 比它的父集还大——物理上不可能的结果，纯粹是口径不一致
//! 造成的。
//! - `HT_LATENCY_SAMPLES`  正式样本数
//! - `HT_LATENCY_WARMUP`   预热样本数（照样测、照样打印，但标记为预热，由上层丢弃）
//! - `HT_LATENCY_GAP_MS`   两轮之间的间隔
//! - `HT_LATENCY_SETTLE_MS` 会话建立后先晾多久（等 shell 把横幅/提示符吐完）
//! - `HT_LATENCY_SHELL`    从端跑什么程序（空 = 用 SessionManager 的默认 shell）

use ht_core::session::{FlowStallReport, ReadStopReason, SessionManager};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 正式采样次数。几十次才谈得上中位数/p95，单次测量只是噪声。
const DEFAULT_SAMPLES: usize = 60;
/// 预热样本数。头几次往返要几百毫秒（ConPTY/shell 冷启动、首次页错误、JIT），
/// 混进正式样本里会把 p95 抬到毫无意义——实测含预热的 p95 是 11.80ms、丢掉预热
/// 之后是 7.44ms。这些样本照样测、照样上报，只是被标成预热由上层丢弃：**丢了几个、
/// 丢掉的有多大**本身就是要写进报告的证据，静悄悄地丢等于把问题藏起来。
const DEFAULT_WARMUP: usize = 20;
/// 两次采样之间的间隔，避免上一轮的回传和下一轮的写入挤在一起。
const DEFAULT_GAP_MS: u64 = 120;
/// 会话刚开起来时 shell 的横幅/提示符还在往外吐，先晾一会儿再开始量。
const DEFAULT_SETTLE_MS: u64 = 1500;
/// 单次往返的等待上限。正常是毫秒级，超过这个数说明这一轮丢了，跳过不计。
const ROUNDTRIP_TIMEOUT_MS: u64 = 2000;

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn main() {
    let samples_wanted = env_usize("HT_LATENCY_SAMPLES", DEFAULT_SAMPLES);
    let warmup_wanted = env_usize("HT_LATENCY_WARMUP", DEFAULT_WARMUP);
    let gap_ms = env_u64("HT_LATENCY_GAP_MS", DEFAULT_GAP_MS);
    let settle_ms = env_u64("HT_LATENCY_SETTLE_MS", DEFAULT_SETTLE_MS);
    let shell = std::env::var("HT_LATENCY_SHELL").unwrap_or_default();

    let (tx, rx) = mpsc::channel::<()>();
    let data_out: Arc<dyn Fn(String, Vec<u8>) + Send + Sync> = Arc::new(move |_sid, _bytes| {
        // 只关心"回传发生在什么时刻"，内容不重要。发送失败（接收端已丢弃）忽略。
        let _ = tx.send(());
    });

    let manager = SessionManager::new(data_out);
    let session_id = manager
        .open(
            &shell,
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

    std::thread::sleep(Duration::from_millis(settle_ms));
    while rx.try_recv().is_ok() {} // 排空热身期间攒下的回传

    let total = warmup_wanted + samples_wanted;
    let mut all_ms: Vec<f64> = Vec::with_capacity(total);
    // 一次按键的回显被从端分成好几块回来是常态（PowerShell 实测两批）。我们量的是
    // "第一块回来"的时刻，剩下的块在下一轮开始前被排空。这个数字要报出来：它是
    // 判断"三段量的是不是同一件事"的直接证据——如果某一段每轮回来 5 块而另一段
    // 只回来 1 块，那两段的从端程序压根不是同一个东西。
    let mut late_chunks: usize = 0;
    let mut timeouts: usize = 0;
    for _ in 0..total {
        while rx.try_recv().is_ok() {
            late_chunks += 1; // 每轮开始前排空，保证配对是一一对应的
        }
        let started = Instant::now();
        manager.write(&session_id, b"x");
        match rx.recv_timeout(Duration::from_millis(ROUNDTRIP_TIMEOUT_MS)) {
            Ok(()) => all_ms.push(started.elapsed().as_secs_f64() * 1000.0),
            Err(_) => {
                timeouts += 1;
                eprintln!("一轮往返超时，跳过");
            }
        }
        std::thread::sleep(Duration::from_millis(gap_ms));
    }

    manager.close(&session_id);

    // 超时的轮次没有样本，所以不能按"前 warmup 个"去切固定下标——按实际拿到的
    // 样本数重新算一次，前 warmup 个当预热。
    let warmup_taken = warmup_wanted.min(all_ms.len());
    let (warmup, measured) = all_ms.split_at(warmup_taken);
    println!(
        "PTY_LATENCY_JSON {{\"shell\":{},\"settle_ms\":{},\"gap_ms\":{},\
         \"warmup_ms\":[{}],\"samples_ms\":[{}],\"late_chunks\":{},\"timeouts\":{}}}",
        json_string(&shell),
        settle_ms,
        gap_ms,
        join_ms(warmup),
        join_ms(measured),
        late_chunks,
        timeouts,
    );
}

fn join_ms(values: &[f64]) -> String {
    values.iter().map(|v| format!("{v:.4}")).collect::<Vec<_>>().join(",")
}

/// 极简 JSON 字符串转义。shell 路径在 Windows 上带反斜杠，直接塞进 JSON 会把
/// 上层的 `JSON.parse` 弄崩（`"C:\Windows\..."` 里的 `\W` 是非法转义）。
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
