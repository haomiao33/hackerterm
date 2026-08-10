import { contextBridge, ipcRenderer } from 'electron'

// 沙箱下 preload 只能做很薄的转发。端口通过 window.postMessage 交给页面。
ipcRenderer.on('port:control', (e) => {
  window.postMessage({ kind: 'port:control' }, '*', e.ports)
})
ipcRenderer.on('port:data', (e, payload) => {
  window.postMessage({ kind: 'port:data', sessionId: payload.sessionId }, '*', e.ports)
})

contextBridge.exposeInMainWorld('ht', {
  openDataPort: (sessionId: string) => ipcRenderer.send('open-data-port', sessionId),
})
