import { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess } from 'electron'
import path from 'node:path'
import { StartupTiming } from './startup-timing'

// 本文件（main 入口模块）开始执行的时刻：全链路时间线里最早能拿到的一个
// 点，用于配合真机排障——见 startup-timing.ts 顶部注释里的时间基线说明。
const timing = new StartupTiming()
timing.record('main:module_load')

let core: Electron.UtilityProcess

/** 默认窗口宽度。暂定值，等真机验证后按实际观感调整。 */
const DEFAULT_WINDOW_WIDTH_PX = 1200
/** 默认窗口高度。暂定值，等真机验证后按实际观感调整。 */
const DEFAULT_WINDOW_HEIGHT_PX = 800

function spawnCore() {
  timing.record('main:fork_call')
  core = utilityProcess.fork(path.join(__dirname, '../core-host/index.js'))
  core.once('spawn', () => timing.record('main:core_spawn'))
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

  win.webContents.on('did-finish-load', () => {
    timing.record('main:did_finish_load')
    // 把此前攒的全部时间点整批送给渲染进程日志区，供真机排障时截图查看。
    timing.attach(win)

    // 控制通道：渲染进程 ↔ core，主进程只牵线
    const ctrl = new MessageChannelMain()
    core.postMessage({ kind: 'control' }, [ctrl.port1])
    win.webContents.postMessage('port:control', null, [ctrl.port2])
  })

  win.loadFile(path.join(__dirname, '../ui/browser/index.html'))
  return win
}

// 渲染进程请求为某个会话建数据通道
ipcMain.on('open-data-port', (event, sessionId: string) => {
  const ch = new MessageChannelMain()
  core.postMessage({ kind: 'data', sessionId }, [ch.port1])
  event.sender.postMessage('port:data', { sessionId }, [ch.port2])
})

app.whenReady().then(() => {
  timing.record('main:app_whenReady')
  spawnCore()
  createWindow()
})
