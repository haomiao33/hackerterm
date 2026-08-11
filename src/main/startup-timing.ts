/**
 * 主进程 + core-host 侧的启动时间线埋点，统一送到渲染进程日志区展示——
 * 这样用户截一张图就能看到从进程起步到控制端口就绪的全链路，而不再是
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
  private window: Electron.BrowserWindow | null = null

  /** 记一个时间点；渲染进程页面已经就绪的话，立刻把这一条增量送过去。 */
  record(label: string, epochMs: number = Date.now()): void {
    this.timings[label] = epochMs
    if (this.window) {
      this.window.webContents.send('startup-timing', { [label]: epochMs })
    }
  }

  /**
   * `did-finish-load` 后调用一次：把这之前攒的所有时间点整批送过去；
   * 之后 record() 收到的新时间点（比如晚到的 core-host 汇报）自动增量
   * 发送，不会因为先后顺序不同而漏发或重发。
   */
  attach(window: Electron.BrowserWindow): void {
    this.window = window
    window.webContents.send('startup-timing', { ...this.timings })
  }

  /**
   * core-host 通过 utility process 内置的 `process.parentPort.postMessage`
   * 回报它自己那几个时间点（模块开始执行、ht-node 原生模块加载耗时——
   * 这是 97 秒延迟的头号怀疑对象）。这条通道和 control/data 两个
   * MessageChannelMain 端口完全独立，是 UtilityProcess <-> 主进程之间
   * Electron 内置的一对一消息通道，不会跟它们互相干扰。
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
