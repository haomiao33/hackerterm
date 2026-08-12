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
  // 攒着的启动时间线和故障日志都在这里冲进页面的诊断日志。
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
 * 把 GPU 各特性的启用/禁用状态打进同一条启动时间线。
 *
 * 排查冷启动慢的时候我们对 GPU 状态两眼一抹黑，只能靠反复加 `--disable-gpu`
 * 重启做对照实验；这一条直接把"硬件加速到底开没开、哪几项被禁"写进诊断日志。终端是整屏重绘的场景，WebGL 有没有真的生效对观感的
 * 影响是数量级的。
 *
 * 放在 createWindow() 之后调用：这个 API 读的是 Chromium 已有的
 * GpuFeatureInfo，正常是纯读取，但万一它要等 GPU 进程先就绪，也绝不能挡在
 * 建窗口前面（那等于把本轮省下来的时间又赔回去）。前后各记一个时间点，真被
 * 它卡住的话时间线上一眼就能看出来。
 */
function recordGpuFeatureStatus(): void {
  timing.record('main:gpu_status_start')
  const status = app.getGPUFeatureStatus()
  timing.record('main:gpu_status_end')
  timing.note(
    'main:gpu_feature_status',
    Object.entries(status).map(([feature, state]) => `${feature}=${state}`).join(' '),
  )
}

app.whenReady().then(() => {
  timing.record('main:app_whenReady')
  spawnCore()
  createWindow()
  recordGpuFeatureStatus()
})
