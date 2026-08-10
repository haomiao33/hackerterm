import { start, startData, send, sendData } from 'ht-node'

// 顺序很重要：先注册数据回调，再注册控制回调
let controlPort: Electron.MessagePortMain | null = null
const dataPorts = new Map<string, Electron.MessagePortMain>()

startData((sessionId: string, buf: Buffer) => {
  const port = dataPorts.get(sessionId)
  // 转成 ArrayBuffer 后 transfer，避免结构化克隆再拷一次
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // Electron 的 MessagePortMain.postMessage 类型声明把 transfer 列表标成
  // MessagePortMain[]，但底层 Chromium 端口本就支持 transfer ArrayBuffer——
  // 这是 Electron 官方类型定义的已知缺口，不是这里的逻辑错误，cast 掉即可。
  port?.postMessage(ab, [ab] as unknown as Electron.MessagePortMain[])
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
