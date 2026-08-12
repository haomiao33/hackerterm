/**
 * 主进程 + core-host 侧的启动时间线埋点，统一送到渲染进程的诊断日志——
 * 这样一处就能看到从进程起步到控制端口就绪的全链路，而不再是
 * "渲染进程一片空白，97 秒后突然冒出第一条日志"。这是诊断/控制信息，
 * 走的是 `webContents.send` / utility-process 内置消息通道，不是数据面
 * 的 MessagePort 直连，所以不受"数据面禁止经主进程中转"的约束。
 *
 * 时间基线：全部用 `Date.now()`（epoch 毫秒）。跨进程（main / core-host
 * utility process）唯一天然可比的时钟只有 epoch 时间——
 * `process.hrtime.bigint()` 在不同进程里各自有独立的任意零点，没法互相
 * 相减；`performance.now()` 同理，只相对各自进程/页面自己的起点。渲染
 * 进程收到这些 epoch 时间戳后，用 `performance.timeOrigin` 换算成跟页面
 * 自己 "+Xms" 日志同一条时间轴上的偏移量，见
 * src/ui/browser/diagnostics/startup-timing.ts。
 */

interface CoreHostTimingMessage {
  kind: 'timing'
  timings: Record<string, number>
}

function isCoreHostTimingMessage(message: unknown): message is CoreHostTimingMessage {
  if (typeof message !== 'object' || message === null) return false
  return (message as { kind?: unknown }).kind === 'timing'
}

export class StartupTiming {
  private readonly timings: Record<string, number> = {}
  private readonly notes: Record<string, string> = {}
  private target: Electron.WebContents | null = null

  /** 记一个时间点；渲染进程页面已经接上的话，立刻把这一条增量送过去。 */
  record(label: string, epochMs: number = Date.now()): void {
    this.timings[label] = epochMs
    this.send({ [label]: epochMs })
  }

  /**
   * 记一条**不是时间戳**的启动事实（目前只有 GPU 特性状态）。
   *
   * 复用同一条 channel、同一份诊断日志，只是值为字符串——排查启动问题时
   * "当时 GPU 是什么状态" 和 "各阶段花了多久" 必须并排看才有意义，拆成
   * 两套显示反而要用户自己在脑子里对齐。渲染侧按值的类型分流：数字换算成
   * "+Xms" 偏移，字符串原样打印。
   */
  note(label: string, text: string): void {
    this.notes[label] = text
    this.send({ [label]: text })
  }

  /**
   * 渲染进程就绪后调用一次：把这之前攒的所有时间点/事实整批送过去；之后
   * record()/note() 收到的新条目自动增量发送，不会因为先后顺序不同而漏发
   * 或重发。
   *
   * 调用时机不再是 `did-finish-load`（页面 load 事件），而是渲染进程主动
   * 来要控制端口的那一刻——真机实测 load 事件比页面脚本执行完晚了近 80 秒，
   * 挂在它上面等于让最需要看时间线的那 80 秒里日志一片空白。页面既然
   * 能发出请求，就证明它的脚本跑完了、监听器挂好了，这是比 load 更早也更
   * 准的"能收消息了"的判据。见 src/main/index.ts 的控制端口处理。
   */
  attach(target: Electron.WebContents): void {
    this.target = target
    target.send('startup-timing', { ...this.timings, ...this.notes })
  }

  private send(payload: Record<string, number | string>): void {
    if (!this.target || this.target.isDestroyed()) return
    this.target.send('startup-timing', payload)
  }

  /**
   * core-host 通过 utility process 内置的 `process.parentPort.postMessage`
   * 回报它自己那几个时间点（模块开始执行、ht-node 原生模块加载耗时）。这条
   * 通道和 control/data 两个 MessageChannelMain 端口完全独立，是
   * UtilityProcess <-> 主进程之间 Electron 内置的一对一消息通道，不会跟它们
   * 互相干扰。
   *
   * 注：ht-node 的加载耗时曾被当作"97 秒延迟头号怀疑对象"，已被实测推翻
   * （真机 11–18ms，见 docs/superpowers/verification/startup-latency-investigation.md）。
   * 埋点保留，因为它现在的作用反过来了：证明这一段不是瓶颈。
   */
  listenCoreHost(core: Electron.UtilityProcess): void {
    core.on('message', (message: unknown) => {
      if (!isCoreHostTimingMessage(message)) return
      for (const [label, epochMs] of Object.entries(message.timings)) {
        this.record(label, epochMs)
      }
    })
  }
}
