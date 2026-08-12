//! 新增测试文件：`FlowWindow` 从自旋轮询改成条件变量之后的等待/唤醒语义，
//! 以及 ack 停摆时的强制自愈出口。
//!
//! 这两件事都属于"看着对、不报错、就是不工作"的高危区：
//! - 丢一次唤醒 → 读线程永久睡死，症状只有"数据不来了"；
//! - 少一个自愈出口 → ack 一旦丢失，终端永久冻结，同样只有"数据不来了"。
//! 所以每条都要有能真正变红的断言，不能只测"方法存在"。

use ht_core::flow::{FlowWindow, ResumeOutcome};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 停摆看门狗在单元测试里用的周期。取一个远小于生产值
/// （`limits::FLOW_PAUSE_STALL_TIMEOUT_MS` = 5s）的数，好让测试跑得快；
/// 被测的是机制，不是那个具体数字。
const TEST_STALL_TIMEOUT: Duration = Duration::from_millis(150);

/// 一个"绝不会自己到期"的看门狗周期：用在只想验证等待/唤醒、不想让停摆逻辑
/// 插进来的测试里。
const NEVER_STALL: Duration = Duration::from_secs(3600);

/// 把窗口推到高水位以上（进入该暂停的状态）。
fn pushed_over_high_water() -> Arc<FlowWindow> {
    let w = Arc::new(FlowWindow::new(1000, 200));
    w.on_sent(1500);
    assert!(w.should_pause(), "测试前提：1500 已过高水位 1000");
    w
}

/// 起一个等待线程，返回 (句柄, 是否已返回的标志, 结局槽)。
#[allow(clippy::type_complexity)]
fn spawn_waiter(
    w: Arc<FlowWindow>,
    stall_timeout: Duration,
) -> (
    std::thread::JoinHandle<()>,
    Arc<AtomicBool>,
    Arc<Mutex<Option<ResumeOutcome>>>,
) {
    let returned = Arc::new(AtomicBool::new(false));
    let outcome = Arc::new(Mutex::new(None));
    let r = returned.clone();
    let o = outcome.clone();
    let handle = std::thread::spawn(move || {
        let result = w.wait_for_resume(stall_timeout);
        *o.lock().unwrap() = Some(result);
        r.store(true, Ordering::SeqCst);
    });
    (handle, returned, outcome)
}

/// ack 把未确认字节数降破低水位 → 等待方返回 Resumed。
///
/// 这条同时是"没有丢唤醒"的证明：`wait_for_resume` 在没到看门狗周期时**完全
/// 没有超时兜底**（这里的 NEVER_STALL 是 1 小时），所以只要 `on_ack` 忘了
/// `notify_all`，这个 join 就会永远挂住、测试超时变红。自旋轮询的老实现里
/// 删掉通知是没有任何后果的——这正是这条测试能钉住"事件驱动"的原因。
#[test]
fn ack_below_low_water_wakes_the_waiter() {
    let w = pushed_over_high_water();
    let (handle, returned, outcome) = spawn_waiter(w.clone(), NEVER_STALL);

    // 先确认它真的在等：没有任何人 ack 之前，它不该返回。
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        !returned.load(Ordering::SeqCst),
        "还没有任何 ack，等待方就返回了——恢复条件判反了"
    );

    w.on_ack(1400); // 未确认降到 100，低于低水位 200
    handle.join().expect("等待线程 panic 了");
    assert_eq!(*outcome.lock().unwrap(), Some(ResumeOutcome::Resumed));
}

/// ack 只降到「低水位 < x < 高水位」区间时**不能**唤醒——迟滞必须保住，
/// 否则会在高水位附近抖动。
#[test]
fn partial_ack_above_low_water_does_not_wake_the_waiter() {
    let w = pushed_over_high_water();
    let (_handle, returned, _outcome) = spawn_waiter(w.clone(), NEVER_STALL);

    w.on_ack(900); // 未确认降到 600：低于高水位，但仍高于低水位 200
    std::thread::sleep(Duration::from_millis(150));
    assert!(
        !returned.load(Ordering::SeqCst),
        "未确认字节数 600 仍高于低水位 200，等待方不该恢复"
    );

    // 收尾：让线程能退出，别把它留在那儿。
    w.close();
}

/// 会话关闭必须能唤醒暂停中的读线程。
///
/// 这是之前修过的一个 Critical 的回归护栏：`close()` 会先把 Session 从 map 里
/// remove，之后 `ack` 再也触达不到这个 flow，恢复条件永远为假。改成条件变量后
/// 如果 `close()` 忘了 `notify_all`，读线程就会永远睡死在 `wait` 里——而且比
/// 老的自旋版本更糟：自旋至少还会自己醒过来看一眼 `is_closed()`。
#[test]
fn close_wakes_the_waiter() {
    let w = pushed_over_high_water();
    let (handle, returned, outcome) = spawn_waiter(w.clone(), NEVER_STALL);

    std::thread::sleep(Duration::from_millis(100));
    assert!(!returned.load(Ordering::SeqCst), "测试前提：此刻它应该还在等");

    w.close();
    handle.join().expect("等待线程 panic 了");
    assert_eq!(*outcome.lock().unwrap(), Some(ResumeOutcome::Closed));
}

/// 唤醒延迟必须**明显低于**老实现的轮询间隔（`FLOW_PAUSE_POLL_INTERVAL_MS`
/// = 2ms）。
///
/// 这条是"不再自旋轮询"的定量证据。老实现里恢复延迟服从 [0, 2ms] 的均匀分布，
/// 中位数约 1ms；条件变量推送是几十微秒量级。断言取中位数而不是最大值：
/// 容器/CI 上偶发的调度抖动会把最大值打飞，但打不动中位数。阈值 500µs 留了
/// 一个数量级的余量——足够宽到不会因为机器慢而抖，又足够窄到一旦有人改回
/// 2ms 轮询就必红（那时中位数会是 ~1000µs）。
#[test]
fn wake_latency_is_far_below_the_old_poll_interval() {
    const CYCLES: usize = 100;
    let mut latencies_us: Vec<u128> = Vec::with_capacity(CYCLES);

    for _ in 0..CYCLES {
        let w = pushed_over_high_water();
        let woke_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let slot = woke_at.clone();
        let ww = w.clone();
        let handle = std::thread::spawn(move || {
            let _ = ww.wait_for_resume(NEVER_STALL);
            // 线程自己记录醒来的时刻，把 join/线程销毁的开销排除在测量之外。
            *slot.lock().unwrap() = Some(Instant::now());
        });

        // 确保它真的睡下去了再计时，否则量到的是"还没开始等"。
        std::thread::sleep(Duration::from_millis(5));
        let notified_at = Instant::now();
        w.on_ack(1400);
        handle.join().expect("等待线程 panic 了");

        let woke = woke_at.lock().unwrap().expect("等待线程没记下醒来时刻");
        latencies_us.push(woke.duration_since(notified_at).as_micros());
    }

    latencies_us.sort_unstable();
    let median = latencies_us[latencies_us.len() / 2];
    assert!(
        median < 500,
        "唤醒延迟中位数 {median}µs 不该接近老实现 2ms 轮询的量级（中位数约 1000µs）——\
         读线程是不是又回到 sleep 轮询了？全部样本（µs）：{latencies_us:?}"
    );
}

/// 谁都不 ack 时，看门狗必须在一个周期后判定停摆并把现场带出来。
///
/// 这就是「ack 丢失 → 终端永久冻结」那条真实路径的探针：没有这个出口，
/// `wait_for_resume` 会永远等下去。
#[test]
fn never_acked_window_reports_stall_with_the_outstanding_bytes() {
    let w = pushed_over_high_water();
    let started = Instant::now();
    let outcome = w.wait_for_resume(TEST_STALL_TIMEOUT);

    assert_eq!(
        outcome,
        ResumeOutcome::Stalled {
            unacknowledged_bytes: 1500,
            stalled_ms: TEST_STALL_TIMEOUT.as_millis() as u64,
        },
        "一个看门狗周期内一个 ack 都没来，应该判定停摆并报出未确认字节数"
    );
    assert!(
        started.elapsed() >= TEST_STALL_TIMEOUT,
        "不该在看门狗周期没走完之前就判停摆"
    );
}

/// 负向对照：ack 一直在推进（只是还没降破低水位）时，**不能**误判成停摆。
///
/// 消费得慢跟通路断了是两件事。少了这条对照，"超时就清零"会把一次正常的大量
/// 刷屏也当成故障，直接把背压废掉。
#[test]
fn slow_but_progressing_acks_are_not_mistaken_for_a_stall() {
    let w = Arc::new(FlowWindow::new(10_000, 200));
    w.on_sent(10_000);

    // 后台每 50ms ack 一点点：始终在下降，但很久都降不破低水位。
    let acker = w.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let acker_handle = std::thread::spawn(move || {
        while !stop_flag.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(50));
            acker.on_ack(100);
        }
    });

    // 等满好几个看门狗周期：只要有进展，看门狗就该一直重新计时。
    let (handle, returned, outcome) = spawn_waiter(w.clone(), TEST_STALL_TIMEOUT);
    std::thread::sleep(TEST_STALL_TIMEOUT * 4);
    let saw_stall = matches!(
        outcome.lock().unwrap().as_ref(),
        Some(ResumeOutcome::Stalled { .. })
    );
    assert!(
        !saw_stall,
        "ack 一直在推进（未确认字节数持续下降），不该被判成停摆——\
         这会把一次正常的大量刷屏误伤成故障，直接废掉背压"
    );
    assert!(
        !returned.load(Ordering::SeqCst),
        "未确认字节数还没降破低水位，等待方不该返回"
    );

    stop.store(true, Ordering::SeqCst);
    acker_handle.join().unwrap();
    w.close();
    handle.join().unwrap();
}

/// 强制清零是 VS Code `clearUnacknowledgedChars()` 的等价物：返回被丢弃的量，
/// 并立刻唤醒等待方。
#[test]
fn clear_unacknowledged_returns_the_discarded_amount_and_forces_resume() {
    let w = pushed_over_high_water();
    let (handle, _returned, outcome) = spawn_waiter(w.clone(), NEVER_STALL);

    std::thread::sleep(Duration::from_millis(50));
    let discarded = w.clear_unacknowledged();

    handle.join().expect("等待线程 panic 了");
    assert_eq!(discarded, 1500, "应该报出被丢弃的未确认字节数");
    assert_eq!(w.outstanding(), 0, "清零之后未确认字节数必须是 0");
    assert_eq!(*outcome.lock().unwrap(), Some(ResumeOutcome::Resumed));
}
