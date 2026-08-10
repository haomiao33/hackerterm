import { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess } from 'electron'
import path from 'node:path'

let core: Electron.UtilityProcess

/** 默认窗口宽度。暂定值，等真机验证后按实际观感调整。 */
const DEFAULT_WINDOW_WIDTH_PX = 1200
/** 默认窗口高度。暂定值，等真机验证后按实际观感调整。 */
const DEFAULT_WINDOW_HEIGHT_PX = 800

function spawnCore() {
  core = utilityProcess.fork(path.join(__dirname, '../core-host/index.js'))
}

function createWindow() {
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
  spawnCore()
  createWindow()
})
