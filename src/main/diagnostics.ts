import { app } from 'electron'

/**
 * 主进程侧的故障捕获与上报。
 *
 * 动机：审计发现主进程此前**一个错误处理器都没有**——未捕获异常、GPU 进程
 * 崩溃、渲染进程崩溃、渲染主线程卡死、core 退出，全都既不崩也不报。本项目
 * 主导的故障类型恰恰是"静默失效"（屏幕上什么都不发生，也没有任何异常），
 * 这个缺口比任何单个 bug 都危险。
 *
 * 上报终点是渲染进程的诊断日志（现在直接写它的 console，见
 * src/ui/browser/diagnostics/log.ts）：三个进程的故障汇到同一处，排障时看一处
 * 就够。同时无条件往主进程自己的 console 打一份——渲染进程已经死了、或者还没
 * 建起来的时候，stderr 是仅存的出口。
 *
 * 时间线埋点（startup-timing.ts）走的是另一条 channel：那边是"什么时候发生
 * 了什么"的正常流水，这边是"出事了"，混在一起会让真正的故障淹没在流水里。
 */

/**
 * 渲染进程接上之前最多攒多少行。故障完全可能发生在窗口就绪之前（core 刚
 * fork 就退出是最典型的一种），那才是最需要看见的，绝不能因为"暂时没人听"
 * 就丢掉；但也不能无限攒——渲染进程反复崩溃时这个数组会一直涨。攒满丢最老
 * 的：故障现场里最新的几条信息价值最高。
 */
const MAX_PENDING_LINES = 200

export type Report = (line: string) => void

/** 把任意 throw 出来的东西压成一行可读文本；Error 优先取 stack（已含 message）。 */
function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  return String(err)
}

export class DiagnosticChannel {
  private readonly pending: string[] = []
  private target: Electron.WebContents | null = null

  /**
   * 上报一行故障信息。
   *
   * 写成箭头属性而不是方法：这个函数要被到处当回调传（watchApp/watchCore
   * 等都只收一个 Report），绑不绑 this 不该成为调用方要操心的事。
   */
  readonly report: Report = (line) => {
    console.error(`[diagnostic] ${line}`)
    if (this.target && !this.target.isDestroyed()) {
      this.target.send('diagnostic', line)
      return
    }
    if (this.pending.length >= MAX_PENDING_LINES) this.pending.shift()
    this.pending.push(line)
  }

  /** 渲染进程就绪后调用一次：把之前攒的整批冲进页面诊断日志，之后实时直送。 */
  attach(target: Electron.WebContents): void {
    this.target = target
    for (const line of this.pending) target.send('diagnostic', line)
    this.pending.length = 0
  }
}

/**
 * 主进程自己的未捕获异常 / 未处理的 Promise 拒绝。
 *
 * 装上处理器之后 Node 不再执行默认行为（打栈 + 退出），这是有意的取舍：打包
 * 后的 GUI 应用里"默认行为"等于整个进程无声消失，用户只看到窗口没了，什么
 * 证据都留不下。让它活着、把现场写进页面诊断日志，排障价值高得多。代价是进程
 * 可能带着已损坏的状态继续跑，所以这两行日志必须写得足够醒目。
 */
export function watchMainProcess(report: Report): void {
  process.on('uncaughtException', (err) => report(`main uncaughtException: ${formatError(err)}`))
  process.on('unhandledRejection', (reason) => report(`main unhandledRejection: ${formatError(reason)}`))
}

/**
 * app 级别的子进程死亡事件。
 *
 * `child-process-gone` 是 **GPU 进程崩溃的唯一信号**：GPU 进程不归
 * `render-process-gone` 管，而 Chromium 崩了会自动重启它并把渲染悄悄降级到
 * 软件光栅——界面还在，只是变慢变糊，不看日志永远发现不了。终端这种整屏
 * 重绘的场景对此尤其敏感（WebGL 渲染器一掉就是肉眼可见的卡）。
 *
 * `render-process-gone` 则意味着页面本身没了：此时 report 往那个 webContents
 * 送是送不进去的（内部会因 isDestroyed / 已崩溃而无效），但 console 那一份
 * 还在，这也正是 report 无条件写 console 的原因之一。
 */
export function watchApp(report: Report): void {
  app.on('child-process-gone', (_event, details) => {
    const name = details.name ? ` name=${details.name}` : ''
    const service = details.serviceName ? ` service=${details.serviceName}` : ''
    report(`child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}${name}${service}`)
  })
  app.on('render-process-gone', (_event, _webContents, details) => {
    report(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })
}

/**
 * 渲染进程主线程卡死 / 恢复。
 *
 * 卡死时页面完全不响应输入，但窗口还在、日志还停在最后一条——从外面看跟
 * "数据不来了"一模一样，是最容易被误判成 IPC 断链的一类故障。成对记录
 * unresponsive/responsive，事后能直接读出卡了多久。
 */
export function watchWindow(report: Report, window: Electron.BrowserWindow): void {
  window.webContents.on('unresponsive', () => report('renderer unresponsive: 渲染主线程卡住，页面暂时不响应输入'))
  window.webContents.on('responsive', () => report('renderer responsive: 渲染主线程恢复'))
}

/** core-host 经 parentPort 回报的故障消息（见 src/core-host/index.ts）。 */
interface CoreHostErrorMessage {
  kind: 'error'
  detail: string
}

function isCoreHostErrorMessage(message: unknown): message is CoreHostErrorMessage {
  if (typeof message !== 'object' || message === null) return false
  return (message as { kind?: unknown }).kind === 'error'
}

/**
 * core（utility 进程）的故障。
 *
 * - `'error'`：不在文档列出的事件表里，但 UtilityProcess 是 EventEmitter，
 *   而 EventEmitter 的规矩是没人监听 `'error'` 就直接 throw。装一个只赚不亏。
 * - `'exit'`：**必须报**。core 退出后 `utilityProcess.postMessage` 会变成
 *   静默 no-op（Electron 的 JS 包装层在 'exit' 里把内部句柄置空，postMessage
 *   用可选链调用，不抛也不返回失败），也就是说控制/数据端口从此只写不通、
 *   一点异常都不会有——不报出来就是纯哑火。
 * - `'message'` 里 kind==='error'：core-host 自己捕获到的未捕获异常，转发进
 *   同一条页面日志。
 */
export function watchCore(report: Report, core: Electron.UtilityProcess): void {
  core.on('error', (err: unknown) => report(`core error: ${formatError(err)}`))
  core.on('exit', (code) => report(`core exited: code=${code}（控制/数据端口自此静默失效）`))
  core.on('message', (message: unknown) => {
    if (!isCoreHostErrorMessage(message)) return
    report(`core-host ${message.detail}`)
  })
}
