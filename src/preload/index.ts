import { contextBridge, ipcRenderer } from 'electron'

// 沙箱下 preload 只能做很薄的转发。端口通过 window.postMessage 交给页面。
ipcRenderer.on('port:control', (e) => {
  window.postMessage({ kind: 'port:control' }, '*', e.ports)
})
ipcRenderer.on('port:data', (e, payload) => {
  window.postMessage({ kind: 'port:data', sessionId: payload.sessionId }, '*', e.ports)
})
// 主进程 + core-host 的启动时间线埋点：诊断信息，走普通 IPC 转发到页面的
// 日志区，跟上面两条端口转发（数据面）是两回事。
ipcRenderer.on('startup-timing', (e, timings) => {
  window.postMessage({ kind: 'startup-timing', timings }, '*')
})

contextBridge.exposeInMainWorld('ht', {
  openDataPort: (sessionId: string) => ipcRenderer.send('open-data-port', sessionId),
})
