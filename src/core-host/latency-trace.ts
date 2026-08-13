/**
 * 数据面「同一次往返之内」的分段埋点。**默认完全关闭**，只有环境变量
 * `HT_LATENCY_TRACE=1` 时才启用。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 *
 * 「按键往返里我们自己的 IPC 占多少」原先是拿三段各自独立测出来的中位数相减
 * 得到的。那个做法不成立：噪声和差值同量级，同一份代码两次 CI 运行里 napi 那
 * 一项能差三倍（17.8% vs 5.9%）。相减要有意义，两段就必须在**同一次往返**里量。
 *
 * 这里量的一段是：
 *   core-host 收到渲染进程发来的按键字节  →  core-host 把回显字节 postMessage
 *   回渲染进程
 * 它严格嵌套在渲染进程量的那一整程（xterm onData → xterm write 回调）里面，
 * 而且两段都是**同一次往返内的时间差**，所以可以逐轮相减，得到"两跳
 * MessagePort + 渲染进程调度 + xterm 解析"这一项的**分布**，而不是两个中位数
 * 的差。
 *
 * 两段各自在自己的进程里读时钟，只做**差值**、不做跨进程时刻比较，所以不需要
 * 对齐 `performance.timeOrigin`——那件事在亚毫秒量级上做不准，是这个方案刻意
 * 绕开的坑。
 *
 * ── 关掉的时候是零开销，不是"开销很小" ────────────────────────────────
 *
 * 调用方（core-host/index.ts）在**装监听器的时候**就二选一：关闭时注册的是原来
 * 那个不含任何埋点的处理函数，热路径上一条多余指令都没有，更不会有字符串拼接。
 * 打开时才注册包了一层的版本。所以这个模块对生产行为的影响是：什么都没有。
 *
 * ── 上报走哪条路 ────────────────────────────────────────────────────────
 *
 * 经 `process.parentPort` → 主进程 `watchCore` → 渲染进程 console（见
 * src/main/diagnostics.ts）。这条路已经存在，不需要为测量新建任何通道；测量脚本
 * 从 Playwright 收到的页面 console 里把这些行捞出来解析。
 */

/** 环境变量开关。只在模块加载时读一次。 */
export const LATENCY_TRACE_ENABLED = process.env.HT_LATENCY_TRACE === '1'

/** 上报行的前缀，测量脚本按它过滤 console。 */
export const LATENCY_TRACE_PREFIX = 'HT_INNER_LATENCY '

export interface LatencyTraceSample {
  /** 第几轮，从 1 开始。 */
  seq: number
  /** core-host 入向 → 出向的毫秒数。 */
  ms: number
  /** 累计：没有对应入向字节的出向数据块（会话横幅、一次按键回来的第 2..n 块）。 */
  orphanOutbound: number
  /** 累计：上一轮还没等到出向就又来了入向字节（配对被打断）。 */
  overlappedInbound: number
}

/**
 * 入向/出向配对器。
 *
 * 刻意做成不读时钟的纯逻辑：时刻由调用方传进来，因为**读时钟的位置**很关键——
 * 出向那一侧要先把数据 postMessage 出去、再来上报，否则上报本身的开销会被算进
 * 渲染进程量到的那一整程里去。纯逻辑也让它可以被单元测试直接验证。
 */
export class LatencyTrace {
  private pendingInboundAt: number | null = null
  private seq = 0
  private orphanOutbound = 0
  private overlappedInbound = 0

  constructor(private readonly report: (line: string) => void) {}

  /** 渲染进程发来的字节到达 core-host。`at` 是到达时刻。 */
  inbound(at: number): void {
    if (this.pendingInboundAt !== null) this.overlappedInbound += 1
    this.pendingInboundAt = at
  }

  /** core-host 把一块出向数据交给数据端口。`at` 是交出去的时刻。 */
  outbound(at: number): void {
    if (this.pendingInboundAt === null) {
      this.orphanOutbound += 1
      return
    }
    const sample: LatencyTraceSample = {
      seq: (this.seq += 1),
      ms: at - this.pendingInboundAt,
      orphanOutbound: this.orphanOutbound,
      overlappedInbound: this.overlappedInbound,
    }
    this.pendingInboundAt = null
    this.report(LATENCY_TRACE_PREFIX + JSON.stringify(sample))
  }
}
