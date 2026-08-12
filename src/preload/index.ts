import { contextBridge, ipcRenderer } from 'electron'

// 沙箱下 preload 只能做很薄的转发。端口通过 window.postMessage 交给页面。
//
// 官方示例（docs/tutorial/message-ports.md）在这里会先 `await windowLoaded`
// 再转发，理由是 `window.postMessage` **不排队**：派发那一刻页面还没挂上
// 监听器，端口就永久丢了。本项目不需要那一步，而且不该要：
//   1. 两个端口现在都是页面自己主动要来的（requestControlPort / openDataPort），
//      能发出请求就证明页面脚本早就跑完、监听器早就挂好了——这比"load 事件
//      触发过"是更强的保证，不是更弱；
//   2. `window.onload` 要等**全部子资源**（xterm.css、字体、chunk……）加载完，
//      真机实测那正是白等 79.9 秒的那个事件。为了防一个已经不存在的竞态去等
//      它，等于把这一轮刚省下来的时间原样还回去。
// 唯一由主进程主动推的是 startup-timing / diagnostic 两条诊断消息，它们不带
// 端口，且主进程只在收到控制端口请求之后才开始推（见 src/main/index.ts 里的
// timing.attach / diagnostics.attach），同样落在页面监听器已就绪之后。
ipcRenderer.on('port:control', (e) => {
  window.postMessage({ kind: 'port:control' }, '*', e.ports)
})
ipcRenderer.on('port:data', (e, payload) => {
  window.postMessage({ kind: 'port:data', sessionId: payload.sessionId }, '*', e.ports)
})
// 主进程 + core-host 的启动时间线埋点：诊断信息，走普通 IPC 转发到页面的
// 诊断日志，跟上面两条端口转发（数据面）是两回事。
ipcRenderer.on('startup-timing', (e, timings) => {
  window.postMessage({ kind: 'startup-timing', timings }, '*')
})
// 主进程 + core-host 的故障上报（未捕获异常、GPU/渲染进程崩溃、core 退出
// 等），同样只是转发到页面的诊断日志——三个进程的故障汇到同一处才看得清。
ipcRenderer.on('diagnostic', (e, line: string) => {
  window.postMessage({ kind: 'diagnostic', line }, '*')
})

contextBridge.exposeInMainWorld('ht', {
  requestControlPort: () => ipcRenderer.send('request-control-port'),
  openDataPort: (sessionId: string) => ipcRenderer.send('open-data-port', sessionId),
})
