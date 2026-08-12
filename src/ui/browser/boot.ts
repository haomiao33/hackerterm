import { ProtocolClient } from '../common/protocol/client'
import {
  Hello, SessionAckRequest, SessionExitEvent, SessionOpenRequest, SessionOpenResponse,
  SessionResizeRequest, SessionState, SessionStateEvent,
} from '../common/protocol/hackerterm'
import { mountTerminal } from './terminal/mount'
import { log } from './diagnostics/log'
import { createIncomingDataLogger } from './diagnostics/byte-throttle'
import { logStartupTiming } from './diagnostics/startup-timing'

// preload 通过 contextBridge 暴露的唯一入口：请求给某个会话开一条数据通道。
// 这是类型声明，不是 import 'electron'——ui/browser 仍然不依赖 Electron。
declare global {
  interface Window {
    ht: {
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

/** 诊断日志里 sessionId 只截前几位，够辨认又不占屏幕（日志区高度有限）。 */
const SESSION_ID_LOG_PREFIX_LENGTH = 8

// 主进程 + core-host 的启动时间线埋点，随时可能到达（早于或晚于控制端口），
// 独立监听、不影响下面握手主流程。
window.addEventListener('message', (e) => {
  if (e.data?.kind !== 'startup-timing') return
  logStartupTiming(e.data.timings)
})

window.addEventListener('message', (e) => {
  if (e.data?.kind !== 'port:control') return
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

/** 握手成功后开一个会话，拿到 sessionId 就去要数据端口。 */
function openSession(client: ProtocolClient): Promise<void> {
  const payload = SessionOpenRequest.encode({
    shell: '', cols: INITIAL_COLS, rows: INITIAL_ROWS, cwd: '',
  }).finish()
  return client.request('session.open', payload)
    .then((p) => {
      const { sessionId } = SessionOpenResponse.decode(p)
      log(`session.open → ${sessionId.slice(0, SESSION_ID_LOG_PREFIX_LENGTH)}…`)
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
    if (e.data?.kind !== 'port:data' || e.data.sessionId !== sessionId) return
    // 这条时间戳和上面 session.open 返回的时间戳的差值，直接暴露数据面
    // 启动的竞态窗口——两者本应背靠背，间隔越大越可疑。
    log('data port ready')
    window.removeEventListener('message', onPort)

    const dataPort = e.ports[0]
    dataPort.start()

    const el = document.getElementById('terminal')!
    const logIncoming = createIncomingDataLogger()
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
        const req = SessionAckRequest.encode({ sessionId, bytesConsumed: bytes }).finish()
        client.request('session.ack', req).catch((err) => log(`ack failed: ${err?.key ?? err}`))
      },
    })

    dataPort.onmessage = (m) => {
      const bytes = new Uint8Array(m.data)
      logIncoming(bytes.byteLength)
      term.write(bytes)
    }
  }
  window.addEventListener('message', onPort)
}
