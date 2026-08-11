import { start, startData, send, sendData } from 'ht-node'
import { SessionDataBuffer } from '../ui/common/session-data-buffer'

// 顺序很重要：先注册数据回调，再注册控制回调
let controlPort: Electron.MessagePortMain | null = null

// 数据面启动竞态：session.open 一返回，Rust 侧 PTY 立刻起、读线程立刻跑，
// 几毫秒内就有数据经 startData 回调打过来；而数据端口是渲染进程另起一个
// IPC 往返（open-data-port -> MessageChannelMain -> 这里）才建立的，端口
// 到场的时间点在 PTY 产出第一批字节之后。原先直接 `dataPorts.get(sessionId)`
// 查表、查不到就用可选链静默丢弃，导致会话最早那批输出（横幅、提示符）永久
// 消失。这里改用 SessionDataBuffer 顶住这个窗口：端口就绪前先攒着，
// `attach` 时按到达顺序一次性冲刷。
const dataBuffer = new SessionDataBuffer()

startData((sessionId: string, buf: Buffer) => {
  // Electron 的 MessagePortMain（utility/主进程侧）不支持 transfer ArrayBuffer，
  // 只接受 MessagePortMain[] 作为 transfer 列表——见 electron#34905（传
  // ArrayBuffer 会整体丢数据）和 #46639（专门修传非法 transferable 导致的崩溃）。
  // 这条限制只存在于 MessagePortMain 这一侧；渲染进程用的标准 DOM MessagePort
  // 支持 ArrayBuffer transfer，方向相反时可以用。这里老老实实走一次
  // structured clone 的内存拷贝，量级在 10GB/s，不是瓶颈。
  dataBuffer.push(sessionId, new Uint8Array(buf))
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
    const { sessionId } = e.data
    dataBuffer.attach(sessionId, (data) => port.postMessage(data))
    // 会话结束时要 detach，否则 dataBuffer 内部的 Map 会随会话数量无限增长
    // （泄漏）。MessagePortMain 在另一端（渲染进程的 dataPort）关闭或整个
    // utility 进程销毁时会触发自己的 'close' 事件——这比等一条协议层面的
    // "会话已结束" 消息更可靠：core-host 目前完全不跟踪会话生命周期
    // （没有会话状态机、也不订阅 session.close 一类的控制面事件），而端口
    // 关闭是这条数据通道本身能感知到的、不需要额外状态的信号，用它来触发
    // detach 不需要引入新的跨模块依赖。
    port.on('close', () => dataBuffer.detach(sessionId))
    port.on('message', (m) => sendData(sessionId, Buffer.from(m.data as ArrayBuffer)))
    port.start()
  }
})
