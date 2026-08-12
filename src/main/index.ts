import { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess } from 'electron'
import path from 'node:path'
import { StartupTiming } from './startup-timing'
import { DiagnosticChannel, watchApp, watchCore, watchMainProcess, watchWindow } from './diagnostics'

// 本文件（main 入口模块）开始执行的时刻：全链路时间线里最早能拿到的一个
// 点，用于配合真机排障——见 startup-timing.ts 顶部注释里的时间基线说明。
const timing = new StartupTiming()
timing.record('main:module_load')

// 故障上报要在任何业务代码之前装好：模块加载阶段本身就可能抛（比如原生依赖
// 缺失），晚一步注册就白装了。见 diagnostics.ts 顶部注释。
const diagnostics = new DiagnosticChannel()
watchMainProcess(diagnostics.report)
watchApp(diagnostics.report)

let core: Electron.UtilityProcess

/** 默认窗口宽度。暂定值，等真机验证后按实际观感调整。 */
const DEFAULT_WINDOW_WIDTH_PX = 1200
/** 默认窗口高度。暂定值，等真机验证后按实际观感调整。 */
const DEFAULT_WINDOW_HEIGHT_PX = 800

function spawnCore() {
  timing.record('main:fork_call')
  core = utilityProcess.fork(path.join(__dirname, '../core-host/index.js'))
  core.once('spawn', () => timing.record('main:core_spawn'))
  watchCore(diagnostics.report, core)
  // core-host 自己那几个时间点（模块开始执行、ht-node 原生模块加载耗时）
  // 通过 utility process 内置消息通道回报，这里接进同一份时间线。
  timing.listenCoreHost(core)
}

function createWindow() {
  timing.record('main:create_window_call')
  const win = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH_PX,
    height: DEFAULT_WINDOW_HEIGHT_PX,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true, // 全局约束：不得关闭
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  watchWindow(diagnostics.report, win)

  // 页面 load 事件本身仍然是一个有价值的数据点（真机上它跟核心就绪之间隔了
  // 79.9 秒，正是这一轮要消灭的那段空等），所以埋点留着；但**不再有任何功能
  // 挂在它上面**。
  win.webContents.on('did-finish-load', () => timing.record('main:did_finish_load'))

  win.loadFile(path.join(__dirname, '../ui/browser/index.html'))
  return win
}

/**
 * 控制通道：渲染进程主动请求，主进程只牵线。
 *
 * 为什么不再挂在 `did-finish-load` 上：真机实测核心 +81294ms 就已完全就绪，
 * 而页面 load 事件 +161224ms 才触发，控制端口白等了 79.9 秒；同一份日志里
 * 渲染进程 **+0ms** 就执行完脚本、挂好了 message 监听器——两边都准备好了，
 * 是我们没把它们接起来。官方 docs/tutorial/message-ports.md 的标准模式就是
 * 由渲染进程主动请求通道（`request-worker-channel`），本项目的数据端口
 * （`open-data-port`）一直是这么做的，唯独控制端口不是，这里补齐一致性。
 * 用户的"强制重载"实验已经反证过这个修复必然有效：重载后核心早已存在，
 * 控制端口 180ms 就接上了。
 */
ipcMain.on('request-control-port', (event) => {
  timing.record('main:control_port_request')
  // 页面既然能发出这个请求，就说明它的脚本已经执行完、诊断监听器已经挂好。
  // 这是"渲染进程能收消息了"最早也最准的判据，比 load 事件早近 80 秒，所以
  // 攒着的启动时间线和故障日志都在这里冲进页面日志区。
  timing.attach(event.sender)
  diagnostics.attach(event.sender)

  const ctrl = new MessageChannelMain()
  // 竞态：core 很可能还没 spawn 完就收到这条消息（真机上 fork→spawn 花了
  // 81 秒，而页面 +0ms 就来要端口了——这是常态不是意外）。查过 Electron 43
  // 的实现，结论是**排队，不丢**：UtilityProcessWrapper 在构造函数里就建好了
  // mojo Connector（host_port_ 那条管道），PostMessage 只判
  // `node_service_remote_.is_connected()`，而 mojo::Remote 一旦绑定即为
  // connected（只有对端断开才变 false），所以消息连同 transfer 的
  // MessagePortMain 一起写进管道排着，子进程绑上自己那端后按序收到。
  // 本地用 electron 43.3.0 实跑复现过这个时序（fork 后立刻 postMessage，
  // 此时 core.pid 仍是 undefined、'spawn' 尚未触发）：子进程照样收到消息和
  // 端口，端口上先发的数据也一条不少。因此不需要为这个竞态额外加一个等
  // 'spawn' 的状态机。
  //
  // 唯一真正会丢的情况是 core 已经退出——那时 postMessage 是静默 no-op，
  // 靠 watchCore 的 'exit' 上报兜底（见 diagnostics.ts）。
  core.postMessage({ kind: 'control' }, [ctrl.port1])
  event.sender.postMessage('port:control', null, [ctrl.port2])
})

// 渲染进程请求为某个会话建数据通道
ipcMain.on('open-data-port', (event, sessionId: string) => {
  const ch = new MessageChannelMain()
  core.postMessage({ kind: 'data', sessionId }, [ch.port1])
  event.sender.postMessage('port:data', { sessionId }, [ch.port2])
})

/**
 * 取值稳定判据：距离上一次 `gpu-info-update` 超过这么久没有新事件，就认为
 * GPU 信息收敛了，取当前值。
 *
 * 为什么要靠"静默一段时间"而不是等某个"最终"事件：Electron 没有这样的事件。
 * 官方文档对 `gpu-info-update` 的全部说明只有一句"Emitted whenever there is a
 * GPU info update"，electron#30827 也确认了它在一次启动里会触发多次、且没有
 * 任何办法知道哪一次是最后一次。所以只能取"不再变了"作为收敛判据。
 */
const GPU_STATUS_SETTLE_MS = 1000
/**
 * 兜底上限：从开始监听算起这么久之后无条件收口。
 *
 * 存在的意义是保证日志区**一定**会出现一条 GPU 结论——要么是真值，要么是
 * 白纸黑字的"未获取到"。悬而不决比错值好，但"什么都不写"比两者都糟：下一轮
 * 排查的人会以为这条埋点没生效。
 */
const GPU_STATUS_DEADLINE_MS = 15_000

function formatGpuFeatureStatus(status: Electron.GPUFeatureStatus): string {
  return Object.entries(status).map(([feature, state]) => `${feature}=${state}`).join(' ')
}

/**
 * 把 GPU 各特性的启用/禁用状态打进同一条启动时间线——**等它真的可用之后再读**。
 *
 * 排查冷启动慢的时候我们对 GPU 状态两眼一抹黑，只能靠反复加 `--disable-gpu`
 * 重启做对照实验；这一条直接把"硬件加速到底开没开、哪几项被禁"写进用户能
 * 截图带回来的日志区。终端是整屏重绘的场景，WebGL 有没有真的生效对观感的
 * 影响是数量级的。
 *
 * ── 为什么改掉原来那种 "whenReady 之后立刻读一次" 的写法 ──────────────
 * 原写法在 `app.whenReady()` 后 13ms 就调 `app.getGPUFeatureStatus()`，那时
 * GPU 进程还没初始化完，读到的是 Chromium 的初始占位值。真机日志实证：它报
 * `webgl=disabled_off`，可同一份日志里 +914ms 就打出了 `WebGL renderer
 * attached`——WebGL 明明是好的。**错的诊断信息比没有诊断信息更糟**，它会把
 * 下一轮排查直接带沟里。
 *
 * Electron 文档在 `app.getGPUFeatureStatus()` 条目下写得很明确：
 * "This information is only usable after the `gpu-info-update` event is
 * emitted."（https://www.electronjs.org/docs/latest/api/app）所以正确时机就是
 * 这个事件，而不是 app ready。
 *
 * ── 为什么不是"第一次 gpu-info-update 就取值" ────────────────────────
 * 这个事件一次启动会触发多次（electron#30827），第一次触发时信息往往还只填了
 * 一部分。这里改成：每次事件都重读一遍，直到连续 GPU_STATUS_SETTLE_MS 没有
 * 新事件才落笔；同时把"一共更新了几次、其中取值真的变过几次"一并记进日志——
 * 这两个数字正是判断"是不是又读早了"的直接证据，下一轮不用再猜。
 *
 * ── 不阻塞启动 ──────────────────────────────────────────────────────
 * 全程只有事件回调和定时器，没有任何同步等待，主进程该干什么干什么。原实现
 * 那对 `gpu_status_start/end` 埋点（实测 2ms）改成 `gpu_status_wait_start`
 * → `main:gpu_status_first_update` → `main:gpu_status_end`，时间线上能直接看出
 * "GPU 信息是启动后多久才可用的"，这本身就是排查冷启动要的信息。
 *
 * 定时器不 unref：Electron 主进程的存活由 app.quit / window-all-closed 决定，
 * 不由 libuv 事件循环空不空决定，挂着一个定时器既不会拖住退出，也不会因为
 * 循环空了就不触发。
 */
function watchGpuFeatureStatus(): void {
  timing.record('main:gpu_status_wait_start')

  let updates = 0
  let valueChanges = 0
  let latest: string | null = null
  let settleTimer: NodeJS.Timeout | null = null
  let deadlineTimer: NodeJS.Timeout | null = null
  let finished = false

  function finish(text: string): void {
    if (finished) return
    finished = true
    if (settleTimer) clearTimeout(settleTimer)
    if (deadlineTimer) clearTimeout(deadlineTimer)
    app.off('gpu-info-update', onGpuInfoUpdate)
    timing.record('main:gpu_status_end')
    timing.note('main:gpu_feature_status', text)
  }

  function onGpuInfoUpdate(): void {
    updates += 1
    const text = formatGpuFeatureStatus(app.getGPUFeatureStatus())
    if (latest !== null && text !== latest) valueChanges += 1
    latest = text
    if (updates === 1) timing.record('main:gpu_status_first_update')

    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      finish(`${latest} (gpu-info-update ×${updates}, 取值变化 ${valueChanges} 次, 静默 ${GPU_STATUS_SETTLE_MS}ms 后收敛)`)
    }, GPU_STATUS_SETTLE_MS)
  }

  deadlineTimer = setTimeout(() => {
    // 拿不到就明说拿不到。绝不能退回去读一次 getGPUFeatureStatus() 充数——
    // 那读回来的正是本次修复要消灭的那个假状态。
    finish(latest === null
      ? `未获取到：${GPU_STATUS_DEADLINE_MS}ms 内 gpu-info-update 一次都没触发，GPU 状态未知（注意：这不等于"全部禁用"）`
      : `${latest} (gpu-info-update ×${updates}, 取值变化 ${valueChanges} 次, ${GPU_STATUS_DEADLINE_MS}ms 上限到达时仍在更新, 取当时值)`)
  }, GPU_STATUS_DEADLINE_MS)

  app.on('gpu-info-update', onGpuInfoUpdate)
}

// 在 app ready **之前**就把监听挂上：`gpu-info-update` 由 GPU 进程初始化推动，
// 它和 ready 谁先谁后没有任何保证，等进了 whenReady 回调再挂就可能漏掉第一次
// 触发（而漏掉第一次会让"更新了几次"这个诊断数字也跟着失真）。app 对象在模块
// 加载阶段就能挂监听，没有理由再等。
watchGpuFeatureStatus()

app.whenReady().then(() => {
  timing.record('main:app_whenReady')
  spawnCore()
  createWindow()
})
