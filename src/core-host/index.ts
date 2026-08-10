import { start, startData, send, sendData } from 'ht-node'

// 顺序很重要：先注册数据回调，再注册控制回调
let controlPort: Electron.MessagePortMain | null = null
const dataPorts = new Map<string, Electron.MessagePortMain>()

startData((sessionId: string, buf: Buffer) => {
  const port = dataPorts.get(sessionId)
  // Electron 的 MessagePortMain（utility/主进程侧）不支持 transfer ArrayBuffer，
  // 只接受 MessagePortMain[] 作为 transfer 列表——见 electron#34905（传
  // ArrayBuffer 会整体丢数据）和 #46639（专门修传非法 transferable 导致的崩溃）。
  // 这条限制只存在于 MessagePortMain 这一侧；渲染进程用的标准 DOM MessagePort
  // 支持 ArrayBuffer transfer，方向相反时可以用。这里老老实实走一次
  // structured clone 的内存拷贝，量级在 10GB/s，不是瓶颈。
  port?.postMessage(new Uint8Array(buf))
})

start((buf: Buffer) => {
  controlPort?.postMessage(new Uint8Array(buf))
})

process.parentPort.on('message', (e) => {
  const [port] = e.ports
  if (e.data?.kind === 'control') {
    controlPort = port
    port.on('message', (m) => send(Buffer.from(m.data as Uint8Array)))
    port.start()
  } else if (e.data?.kind === 'data') {
    dataPorts.set(e.data.sessionId, port)
    port.on('message', (m) => sendData(e.data.sessionId, Buffer.from(m.data as ArrayBuffer)))
    port.start()
  }
})
