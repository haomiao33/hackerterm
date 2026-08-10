use ht_core::flow::FlowWindow;

#[test]
fn pauses_above_high_water_and_resumes_below_low_water() {
    let w = FlowWindow::new(1000, 200);

    w.on_sent(500);
    assert!(!w.should_pause(), "500 未过高水位，不该暂停");

    w.on_sent(600); // 累计 1100
    assert!(w.should_pause(), "1100 超过高水位 1000，必须暂停");

    w.on_ack(800); // 未确认降到 300
    assert!(!w.should_resume(), "300 仍高于低水位 200，还不能恢复");

    w.on_ack(150); // 未确认降到 150
    assert!(w.should_resume(), "150 低于低水位 200，应当恢复");
}

#[test]
fn ack_larger_than_outstanding_does_not_underflow() {
    let w = FlowWindow::new(1000, 200);
    w.on_sent(100);
    w.on_ack(999_999); // 渲染层报了个离谱的数
    assert!(w.should_resume());
}
