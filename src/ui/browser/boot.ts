import { AckBatcher } from '../common/ack-batcher'
import { ProtocolClient } from '../common/protocol/client'
import {
  CoreStatsRequest, CoreStatsResponse, Hello, SessionAckRequest, SessionExitEvent,
  SessionFlowStalledEvent, SessionOpenRequest, SessionOpenResponse, SessionResizeRequest,
  SessionState, SessionStateEvent,
} from '../common/protocol/hackerterm'
import { mountTerminal } from './terminal/mount'
import { log } from './diagnostics/log'
import { installErrorHandlers } from './diagnostics/errors'
import { createIncomingDataLogger } from './diagnostics/byte-throttle'
import { createMultiSessionDiagnostics } from './diagnostics/multi-session'
import { logStartupTiming } from './diagnostics/startup-timing'

// preload 通过 contextBridge 暴露的两个入口：要控制通道、要某个会话的数据
// 通道。两者都是"渲染进程主动请求、主进程应答"的同一个模式（官方
// docs/tutorial/message-ports.md 的 request-worker-channel）。
// 这是类型声明，不是 import 'electron'——ui/browser 仍然不依赖 Electron。
declare global {
  interface Window {
    ht: {
      requestControlPort(): void
      openDataPort(sessionId: string): void
    }
  }
}

/**
 * session.open 时先占位用的终端尺寸（列/行）。真实尺寸由 mountTerminal 里的
 * FitAddon 量出来后立刻通过 onResize -> session.resize 纠正，这两个数字
 * 只影响 PTY 创建那一瞬间，不影响最终显示。
 */
const INITIAL_COLS = 80
const INITIAL_ROWS = 24

/** 诊断日志里 sessionId 只截前几位，够辨认又不至于让每行都被一串 uuid 撑长。 */
const SESSION_ID_LOG_PREFIX_LENGTH = 8

// 页面自己的兜底错误捕获要最先装：下面任何一处抛异常，都得在诊断日志里留下
// 痕迹，而不是让页面停在半截却什么都不说。
installErrorHandlers()

/**
 * 只认本页面 preload 转进来的消息。
 *
 * `window` 上的 message 事件是公共的：iframe、任何拿到本窗口引用的代码都能
 * 往这儿发，只判 `e.data.kind` 等于让谁都能伪造一条"控制端口就绪"。官方
 * docs/tutorial/message-ports.md 的示例正是用 `event.source === window` 做
 * 校验——preload 是在同一个 window 上 postMessage 的（只是在隔离世界里），
 * 所以 source 就是本 window 自己。
 */
function fromPreload(e: MessageEvent): boolean {
  return e.source === window
}

// 主进程 + core-host 的启动时间线埋点，随时可能到达（早于或晚于控制端口），
// 独立监听、不影响下面握手主流程。
window.addEventListener('message', (e) => {
  if (!fromPreload(e) || e.data?.kind !== 'startup-timing') return
  logStartupTiming(e.data.timings)
})

// 主进程 / core-host 的故障上报（见 src/main/diagnostics.ts）。三个进程的错误
// 最终都汇到渲染进程的 console，用户开 DevTools（或主进程带 --enable-logging
// 时看 stdout）就能一次看全，不必分别去翻三个进程。
window.addEventListener('message', (e) => {
  if (!fromPreload(e) || e.data?.kind !== 'diagnostic') return
  log(e.data.line)
})

window.addEventListener('message', (e) => {
  if (!fromPreload(e) || e.data?.kind !== 'port:control') return
  log('control port ready')
  const port = e.ports[0]
  const client = new ProtocolClient({ send: (b) => port.postMessage(b) })
  port.onmessage = (m) => client.handleInbound(new Uint8Array(m.data))
  port.start()

  // session.exit / session.state 是核心主动推的事件（不是请求-响应），随时可能
  // 到达，订阅要趁早——挂在 hello 握手之前，不然握手期间/之前发生的事件会被
  // 未知 topic 静默丢弃（见 ProtocolClient.handleInbound 的丢弃逻辑）。
  // session.state 是这轮新增的：读线程停止（干净 EOF 或真错误）之前完全不
  // 上报，渲染层只能看到"数据永久不再来"却不知道为什么；现在核心会把这个
  // 状态经这个事件报出来。
  client.on('session.exit', (payload) => {
    const { sessionId, exitCode } = SessionExitEvent.decode(payload)
    log(`session.exit ← ${sessionId.slice(0, SESSION_ID_LOG_PREFIX_LENGTH)}… exitCode=${exitCode}`)
  })
  client.on('session.state', (payload) => {
    const ev = SessionStateEvent.decode(payload)
    const stateName = SessionState[ev.state] ?? `unknown(${ev.state})`
    const errorSuffix = ev.error ? ` error=${ev.error.key}: ${ev.error.detail}` : ''
    log(`session.state ← ${ev.sessionId.slice(0, SESSION_ID_LOG_PREFIX_LENGTH)}… state=${stateName}${errorSuffix}`)
    // 状态一变就顺手把读线程存活数打一份：它跟"数据还会不会来"直接相关，
    // 而这正是状态变化时最想知道的那个数。
    logCoreStats(client)
  })
  // 流控停摆自愈：核心等了整整一个看门狗周期都等不到 ack，强制清零了未确认
  // 窗口才没让终端永久冻结。这不是好消息，是"我们刚刚放弃了一次背压"——
  // ack 链路上有真实故障，必须让它在日志里显眼，绝不能静默过去。
  client.on('session.flow_stalled', (payload) => {
    const ev = SessionFlowStalledEvent.decode(payload)
    const line =
      `session.flow_stalled ← ${ev.sessionId.slice(0, SESSION_ID_LOG_PREFIX_LENGTH)}… ` +
      `核心等了 ${ev.stalledMs}ms 没等到任何 ack，强制丢弃 ${ev.unacknowledgedBytes}B 未确认记账以避免永久冻结` +
      '（ack 链路有故障，不是正常现象）'
    log(line)
    console.warn(line)
  })

  const payload = Hello.encode({
    protocolMajor: 1, protocolMinor: 0, minSupportedMajor: 1,
    implVersion: 'shell-m0', capabilities: [],
  }).finish()

  client.request('hello', payload)
    .then((p) => {
      log(`core capabilities: ${Hello.decode(p).capabilities.join(', ')}`)
      return openSession(client)
    })
    .catch((err) => log(`handshake failed: ${err?.key ?? err}`))
})

// 监听器全挂好之后再去要控制端口——请求-应答模式下端口只可能在这一行之后
// 到达，所以"端口来了却没人接"这个窗口从根上不存在（也正因如此，preload 那
// 边不需要官方示例里的 `await windowLoaded`，理由见 src/preload/index.ts）。
log('requesting control port')
window.ht.requestControlPort()

/**
 * 查一次核心的存活读线程数并写进日志。
 *
 * 为什么值得单独有这么一条：读线程一死，这个会话往后就再也不会有数据回来，
 * 而症状只有"屏幕不动了"。正常停止路径已经会经 `session.state` 报出来，
 * 但**读线程 panic 会直接跳过那条上报**——事件能证明发生过什么，证明不了
 * 此刻还剩几个线程活着。所以这里用请求-应答主动查，而不是等事件。
 *
 * 调用时机刻意选得很稀（会话建立时、状态变化时，外加 DevTools 里手动查），
 * 不做周期轮询：那等于把这一轮刚从控制面省下来的往返又加回去。
 */
function logCoreStats(client: ProtocolClient): Promise<number> {
  return client.request('core.stats', CoreStatsRequest.encode({}).finish())
    .then((p) => {
      const { liveReadThreads } = CoreStatsResponse.decode(p)
      log(`core.stats → live read threads = ${liveReadThreads}`)
      return liveReadThreads
    })
    .catch((err) => {
      log(`core.stats failed: ${err?.key ?? err}`)
      return -1
    })
}

/** 握手成功后开一个会话，拿到 sessionId 就去要数据端口。 */
function openSession(client: ProtocolClient): Promise<void> {
  const payload = SessionOpenRequest.encode({
    shell: '', cols: INITIAL_COLS, rows: INITIAL_ROWS, cwd: '',
  }).finish()
  return client.request('session.open', payload)
    .then((p) => {
      const { sessionId } = SessionOpenResponse.decode(p)
      log(`session.open → ${sessionId.slice(0, SESSION_ID_LOG_PREFIX_LENGTH)}…`)
      // 会话刚建立时的基线读数：后面任何一次复查都要跟它比才有意义。
      logCoreStats(client)
      waitForDataPort(sessionId, client)
      window.ht.openDataPort(sessionId)
    })
    .catch((err) => {
      // 单独 catch 而不是让错误冒泡到外层 hello 链上的 catch——否则 session.open
      // 失败会被日志误标成 "handshake failed"，误导下一轮排障。
      log(`session.open failed: ${err?.key ?? err}`)
    })
}

/**
 * 数据端口是主进程异步递过来的（见 preload 的 `port:data` 转发），这里先挂好
 * 监听器等它出现，用 sessionId 认领属于自己的那一个。拿到端口后才挂载终端——
 * 数据面全程走这条 MessagePort 直连，不经过 protobuf、不经过主进程中转。
 */
function waitForDataPort(sessionId: string, client: ProtocolClient): void {
  const onPort = (e: MessageEvent): void => {
    if (!fromPreload(e) || e.data?.kind !== 'port:data' || e.data.sessionId !== sessionId) return
    // 这条时间戳和上面 session.open 返回的时间戳的差值，直接暴露数据面
    // 启动的竞态窗口——两者本应背靠背，间隔越大越可疑。
    log('data port ready')
    window.removeEventListener('message', onPort)

    // 这里**不能**调 dataPort.start()：下面赋值 onmessage 本身就会隐式 start，
    // 提前 start 只会打开一个"已经开始派发、但还没有 onmessage"的窗口，落进
    // 这个窗口的消息会被直接丢掉。现在 start 与 onmessage 之间是同步代码，
    // 看起来没事；可只要将来谁在中间插一个 await（比如异步初始化终端），会话
    // 最早那批输出就会静默消失——正是本项目反复踩的那类哑火。
    const dataPort = e.ports[0]

    const el = document.getElementById('terminal')!
    const logIncoming = createIncomingDataLogger()

    // ack 批处理。原先每次 xterm write 回调都发一次 `session.ack`，走控制面、
    // 编 protobuf、建 pending promise、等应答；一个按键的回显（PowerShell 实测
    // 分两批数据回来）就要付两趟完整往返，而它确认的字节数往往只有个位数。
    // 攒够 FLOW_ACK_BATCH_BYTES 再发一次，这是纯赚——ack 是反向的流控信号，
    // 晚发一点只影响核心对未确认字节数的估计精度，完全不在"按键 → 屏幕"这条
    // 链路上。阈值必须 <= 低水位，理由见 ack-batcher.ts / limits.rs。
    const ackBatcher = new AckBatcher((bytesConsumed) => {
      const req = SessionAckRequest.encode({ sessionId, bytesConsumed }).finish()
      client.request('session.ack', req).catch((err) => {
        // 关键：不能只打一行日志就算完。ack 一丢，那批字节在核心侧就永远
        // 是"未确认"，累积过高水位后读线程永久暂停、终端彻底冻住——这正是
        // 本项目最典型的静默失效，而批处理会把单次损失从几字节放大成一整批。
        // 退回给批处理器，下一次冲刷时连本次一起重发。
        log(`ack failed（${bytesConsumed}B 退回重试）: ${err?.key ?? err}`)
        ackBatcher.returnUnacknowledged(bytesConsumed)
      })
    })

    const term = mountTerminal(el, {
      onInput(bytes) {
        // 千万别为了"零拷贝"改成 postMessage(bytes.buffer, [bytes.buffer])：
        // 对端是 utility 进程的 MessagePortMain，而 Electron 在这个方向上只把
        // MessagePortMain 当合法 transferable——transfer 列表里一旦出现
        // ArrayBuffer，整条消息（连同数据本身）会被整体丢弃，不报错也不抛异常
        // （electron#34905，至今 open，Electron 43 仍复现）。真机症状就是出向
        // onData 日志 200+ 条条条都在、PTY 一个字节都收不到，纯哑火最难查。
        // 反方向（core-host → 渲染）已经踩过同一个坑，见 commit bb36cc6，这次
        // 是它的镜像；控制面 port.postMessage(b) 和数据面入向也都是这么发的。
        // 老老实实走一次 structured clone 拷贝，量级 10GB/s，键盘输入这点量
        // 根本不是瓶颈。数据面依旧只传字节，不转字符串、不做 JSON 序列化。
        dataPort.postMessage(bytes)
      },
      onResize(cols, rows) {
        const req = SessionResizeRequest.encode({ sessionId, cols, rows }).finish()
        client.request('session.resize', req).catch((err) => log(`resize failed: ${err?.key ?? err}`))
      },
      onConsumed(bytes) {
        ackBatcher.consumed(bytes)
      },
    })

    // 诊断入口（不是产品 API，见 mount.ts 里 __htDiagnostics 的注释）：
    // 用户能开 DevTools，"此刻还剩几个读线程活着"是排查"数据怎么不来了"时
    // 最想随时问一遍的那个数，做成可手动调用的比只在几个时机打日志有用得多。
    //
    // `sessions` 是**多会话驱动面**，同样只为诊断/测试存在（见
    // diagnostics/multi-session.ts 顶部那段边界说明）：产品 UI 现在只有一条
    // 会话，而"10+ 并发会话互不串扰"这件事必须在真渲染进程里验，否则整个渲染
    // 侧数据面（两跳 MessagePort + SessionDataBuffer + 合批 + 出向路由）就是
    // 零覆盖。**没人调用它时它什么都不做**，不改变本文件上面任何一行的行为。
    //
    // 为什么挂在这里而不是拿到控制端口时就挂：`mountTerminal` 里那句
    // `window.__htDiagnostics = { term }` 是整体赋值，早挂会被它覆盖掉。挂在
    // 它后面（本行所在位置）是当前唯一不需要改动 mount.ts 的正确时机。
    window.__htDiagnostics = {
      ...window.__htDiagnostics!,
      coreStats: () => logCoreStats(client),
      sessions: createMultiSessionDiagnostics({
        client,
        openDataPort: (id) => window.ht.openDataPort(id),
      }),
    }

    dataPort.onmessage = (m) => {
      const bytes = new Uint8Array(m.data)
      logIncoming(bytes.byteLength)
      term.write(bytes)
    }
  }
  window.addEventListener('message', onPort)
}
