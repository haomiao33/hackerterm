import { SessionDataBuffer } from '../ui/common/session-data-buffer'

// 本文件（core-host 入口模块）开始执行的时刻：全链路时间线里 core-host
// 这一侧最早能拿到的点，用来跟下面 ht-node 原生模块的加载耗时对比。时间
// 基线是 Date.now()（epoch 毫秒）——跨进程可比的口径见
// src/main/startup-timing.ts 顶部注释。
const moduleStart = Date.now()

let controlPort: Electron.MessagePortMain | null = null

// 数据面启动竞态：session.open 一返回，Rust 侧 PTY 立刻起、读线程立刻跑，
// 几毫秒内就有数据经 startData 回调打过来；而数据端口是渲染进程另起一个
// IPC 往返（open-data-port -> MessageChannelMain -> 这里）才建立的，端口
// 到场的时间点在 PTY 产出第一批字节之后。原先直接 `dataPorts.get(sessionId)`
// 查表、查不到就用可选链静默丢弃，导致会话最早那批输出（横幅、提示符）永久
// 消失。这里改用 SessionDataBuffer 顶住这个窗口：端口就绪前先攒着，
// `attach` 时按到达顺序一次性冲刷。
const dataBuffer = new SessionDataBuffer()

/**
 * ht-node 是 napi 原生模块，真机上"控制端口 97 秒才就绪"的头号怀疑对象
 * 就是它的加载耗时——原生插件要经过动态链接/初始化，冷启动可能比纯 JS
 * 模块慢一到两个数量级。这里特意改成动态 import 而不是文件顶部的静态
 * import：静态 import 会被提升到本模块最前面执行，没法在它前后插时间戳；
 * 动态 import 是一条普通语句，能老老实实地在 await 前后各打一个点。
 */
async function bootCoreHost(): Promise<void> {
  const importStart = Date.now()
  const { start, startData, send, sendData } = await import('ht-node')
  const importEnd = Date.now()

  // 把 core-host 这几个时间点回报给主进程，main/startup-timing.ts 会接进
  // 统一时间线再转发给渲染进程日志区。走的是 utility process 内置的
  // parentPort <-> UtilityProcess 消息通道，跟下面 control/data 两个
  // MessageChannelMain 端口完全独立，不会互相干扰。
  process.parentPort.postMessage({
    kind: 'timing',
    timings: {
      'core-host:module_start': moduleStart,
      'core-host:ht_node_import_start': importStart,
      'core-host:ht_node_import_end': importEnd,
    },
  })

  // 顺序很重要：先注册数据回调，再注册控制回调
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
      port.on('message', (m) => {
        // 渲染侧发的是 Uint8Array 且不带 transfer（见 boot.ts 里那段注释），
        // 经 structured clone 到这边原样还是 Uint8Array——原来写 `as ArrayBuffer`
        // 是错的，而 Electron 把 MessageEvent.data 声明成 any，强断言根本没被
        // 类型检查过，错了也没人拦（bb36cc6 那句 `as unknown as
        // MessagePortMain[]` 是同一种坑）。这里改成显式声明而不是断言：类型写
        // 错时 tsc 会在下游用法上报出来，不再被 as 压掉。
        const bytes: Uint8Array = m.data
        sendData(sessionId, Buffer.from(bytes))
      })
      port.start()
    }
  })
}

// process.parentPort 的 'message' 监听器虽然要等 ht-node 加载完才注册，但
// Electron 文档明确保证：注册前收到的消息会排队，不会丢（"Messages
// received on this port will be queued up until a handler is registered
// for this event"），所以主进程即使抢在 ht-node 加载完之前就发来
// control/data 端口，也不会被吞掉。
bootCoreHost()
