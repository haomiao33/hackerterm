import { FLOW_ACK_BATCH_BYTES, FLOW_ACK_IDLE_FLUSH_MS } from './limits'

/**
 * `session.ack` 的批量发送器。
 *
 * 为什么需要它：`session.ack` 走的是**控制面**，而 `ProtocolClient.request` 是
 * 请求-应答——每发一次就要编一次 protobuf 信封、建一个 pending promise、等核心
 * 回一条空 `Empty` 响应。原先 xterm 每完成一次 `write` 回调就发一次，于是一个
 * 按键的回显（PowerShell 实测会分两批数据回来）就要付两趟完整往返，而它确认的
 * 字节数往往只有个位数。这是纯开销：流控真正关心的只是"未确认字节数有没有逼近
 * 高水位"，那是 KB 量级的判断，根本不需要按字节实时同步。
 *
 * 攒批之后，这个开销从"每次 write 一趟往返"降到"每 `FLOW_ACK_BATCH_BYTES`
 * 字节一趟往返"。**这一项没有延迟代价**：ack 是反向的流控信号，晚发一点只影响
 * 核心对未确认字节数的估计精度，完全不在"按键 → 屏幕"这条链路上。
 *
 * 空闲兜底（`FLOW_ACK_IDLE_FLUSH_MS`）是必要的，理由不是正确性而是**下一次洪水
 * 的起跑线**：没有它，一段安静期结束时最多会有 `FLOW_ACK_BATCH_BYTES - 1` 字节
 * 已经被 xterm 消费掉、却仍被核心记在未确认窗口里；真正的刷屏一开始，这笔虚账
 * 就让高水位提前撞上、读线程提前暂停。顺带的好处是 `FlowWindow::outstanding()`
 * 作为诊断量在稳态下是准的，而不是长期偏高一个不确定的量。代价只有一个空闲定时器。
 *
 * 纯逻辑单元：不依赖 DOM / Electron / Node（`ui/common` 分层规则强制），
 * 定时器只用 `setTimeout`/`clearTimeout` 这两个两侧都有的全局。
 */
export class AckBatcher {
  private pending = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  /**
   * @param send 真正把一次合并后的 ack 发出去（调用方负责编 protobuf 并走控制面）。
   */
  constructor(
    private readonly send: (bytesConsumed: number) => void,
    private readonly thresholdBytes: number = FLOW_ACK_BATCH_BYTES,
    private readonly idleFlushMs: number = FLOW_ACK_IDLE_FLUSH_MS,
  ) {}

  /** 渲染层又消费了 `bytes` 字节。达到阈值立即冲刷，否则攒着并挂上空闲兜底。 */
  consumed(bytes: number): void {
    // 非正数直接忽略：让 pending 只在"真的消费了字节"时才动，避免一次 0 字节的
    // write 回调白白启动一个空闲定时器（那会导致一条 bytesConsumed=0 的空 ack）。
    if (bytes <= 0) return
    this.pending += bytes

    if (this.pending >= this.thresholdBytes) {
      this.flush()
      return
    }

    // 定时器只在**第一笔**未冲刷字节上挂一次，后续到达不重置它。语义因此是
    // "任何被消费的字节最多滞留 idleFlushMs 毫秒"，而不是"安静 idleFlushMs
    // 毫秒之后才发"——后者在持续刷屏时永远不会触发，等于没有兜底。
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.idleFlushMs)
    }
  }

  /**
   * 一次 ack **发送失败**了，把那批字节退回来等下次一起发。
   *
   * 为什么必须有这条路：`session.ack` 走请求-应答的控制面，请求失败时那批字节
   * 就永远得不到确认了。核心侧的未确认字节数只增不减，累积过高水位之后读线程
   * 永久暂停，终端彻底冻住——不抛异常、不报错，只表现为"数据不来了"。批处理
   * 还会放大它：以前一次丢几个字节，现在一次丢一整批。
   *
   * 跟 `consumed` 的关键区别是**不看阈值**：退回来的量往往本身就已经 >= 阈值
   * （它就是因为达到阈值才被发出去的），走 `consumed` 会立刻触发重发，而失败
   * 通常是持续性的（控制面断了），于是变成一个把 CPU 打满的重试死循环。
   * 这里只挂空闲定时器，把重试节奏压到每 `idleFlushMs` 最多一次。
   *
   * 这条只兜得住"请求明确失败"的情况。响应彻底丢失（promise 永远不落地）
   * 兜不住——那种情况由核心侧的停摆看门狗强制清零来收底，见
   * `crates/ht-core/src/flow.rs` 的 `clear_unacknowledged`。
   */
  returnUnacknowledged(bytes: number): void {
    if (bytes <= 0) return
    this.pending += bytes
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.idleFlushMs)
    }
  }

  /** 把攒着的字节数合成一次 ack 发出去。没有攒着的字节则什么都不做。 */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending === 0) return
    const bytes = this.pending
    // 先清零再发：send 可能同步抛（控制面编码失败），那也不该让同一批字节
    // 在下一次 flush 时被重复确认——重复 ack 会让核心的未确认窗口偏低，
    // 高水位形同虚设。
    this.pending = 0
    this.send(bytes)
  }

  /** 会话结束：丢掉定时器，不再冲刷（对端已经没人处理这条 ack 了）。 */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = 0
  }

  /** 诊断/测试用：当前攒着、尚未发出的字节数。 */
  get pendingBytes(): number {
    return this.pending
  }
}
