import { ProtocolClient } from '../common/protocol/client'
import { Hello, SessionAckRequest, SessionOpenRequest, SessionOpenResponse, SessionResizeRequest } from '../common/protocol/hackerterm'
import { mountTerminal } from './terminal/mount'

// preload 通过 contextBridge 暴露的唯一入口：请求给某个会话开一条数据通道。
// 这是类型声明，不是 import 'electron'——ui/browser 仍然不依赖 Electron。
declare global {
  interface Window {
    ht: {
      openDataPort(sessionId: string): void
    }
  }
}

const log = (s: string) => { document.getElementById('log')!.textContent += `\n${s}` }

/**
 * session.open 时先占位用的终端尺寸（列/行）。真实尺寸由 mountTerminal 里的
 * FitAddon 量出来后立刻通过 onResize -> session.resize 纠正，这两个数字
 * 只影响 PTY 创建那一瞬间，不影响最终显示。
 */
const INITIAL_COLS = 80
const INITIAL_ROWS = 24

window.addEventListener('message', (e) => {
  if (e.data?.kind !== 'port:control') return
  const port = e.ports[0]
  const client = new ProtocolClient({ send: (b) => port.postMessage(b) })
  port.onmessage = (m) => client.handleInbound(new Uint8Array(m.data))
  port.start()

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
  return client.request('session.open', payload).then((p) => {
    const { sessionId } = SessionOpenResponse.decode(p)
    waitForDataPort(sessionId, client)
    window.ht.openDataPort(sessionId)
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
    window.removeEventListener('message', onPort)

    const dataPort = e.ports[0]
    dataPort.start()

    const el = document.getElementById('terminal')!
    const term = mountTerminal(el, {
      onInput(bytes) {
        // 直接 transfer 底层 ArrayBuffer：数据面不许转字符串、不许 JSON 序列化。
        dataPort.postMessage(bytes.buffer, [bytes.buffer])
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

    dataPort.onmessage = (m) => term.write(new Uint8Array(m.data))
  }
  window.addEventListener('message', onPort)
}
