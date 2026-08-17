/**
 * 【诊断专用，不是产品 API】渲染进程侧的**多会话驱动面**。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────
 * 产品第②条要求「10+ 并发会话」，而这件事此前唯一的自动化验证是
 * e2e/concurrency-core.e2e.ts——那条测试走的是 `connectCore`，即普通 Node 进程
 * 直连 napi，**整个渲染侧数据面根本没被执行**。实测证据：把
 * src/ui/common/session-data-buffer.ts 的路由改成"广播给所有会话"，那条测试
 * 依然全绿。也就是说下面这几层当时是零覆盖的：
 *   - 渲染进程 ←→ core-host 的两跳数据面 MessagePort
 *   - src/core-host/index.ts 的入向路由 + SessionDataBuffer
 *   - src/ui/common/data-batcher.ts 的合批
 *   - **出向 `sendData(sessionId, …)`**——决定"用户敲的字进哪个会话"，
 *     它退化的症状是"在 A 里打字、字出现在 B 里"
 * 要在真 Electron 里覆盖它们，测试就得能在**同一个渲染进程里**同时开十几条
 * 会话；而产品 UI 目前只有一条会话、没有多会话界面（标签页是 V1 的事）。
 * 这个模块就是那个缺口的填充物：一个只被端到端测试调用的驱动面。
 *
 * ── 边界：它绝不能改变任何业务行为 ──────────────────────────────────────
 * 命名沿用 `__htDiagnostics`（见 terminal/mount.ts 里那段注释）：带双下划线、
 * 带 Diagnostics 字样，一眼能看出不是产品 API。约束有三条，改这个文件的人必须
 * 守住：
 *   1. **没人调用时它什么都不做**——构造函数里只建两个空 Map 和一个 window
 *      message 监听器，不开会话、不发请求、不碰主终端；
 *   2. 它开出来的会话**走的是和产品完全相同的那条路**（同一个 ProtocolClient、
 *      同一个 `openDataPort` IPC、同一条数据面 MessagePort、同一个 AckBatcher）。
 *      这是它的全部价值：换一条"测试专用捷径"就等于什么都没测；
 *   3. 生产代码不得读它。删掉这个文件，除了那条端到端测试之外不该有任何东西坏掉。
 *
 * ── 为什么不给这些会话挂 xterm ────────────────────────────────────────
 * 串扰的判据是"**字节**有没有跑到别的会话去"，而 xterm 的屏幕缓冲区会换行、
 * 会被重绘覆盖、会被 PSReadLine 的重排改写，拿它做子串匹配等于给判据引入一堆
 * 与串扰无关的失效模式。所以这里只在数据端口上挂一个记账用的 sink，屏幕那一层
 * 由 smoke / visual / flood 三条测试各自覆盖（主终端仍然是完整的产品路径，
 * 串扰测试会连它一起验）。
 */
import { AckBatcher } from '../../common/ack-batcher'
import type { ProtocolClient } from '../../common/protocol/client'
import { SessionAckRequest, SessionOpenRequest, SessionOpenResponse } from '../../common/protocol/hackerterm'

/**
 * 每条会话待取走的解码文本上限（字符）。
 *
 * 超过就丢最旧的，并把丢掉的量记进 `dropped`——**丢弃必须被记账**：测试是靠
 * 子串匹配找串扰的，静默丢数据等于给判据开一个看不见的盲区，"没发现串扰"就
 * 变得毫无意义。测试侧会断言 `dropped === 0`。
 * 正常用法下测试每 100ms 取一次、每条会话每轮只写几十字节，这个上限碰不到。
 */
const MAX_PENDING_CHARS = 1024 * 1024

export interface DiagnosticSessionSnapshot {
  /** 自上次 `drain()` 以来这条会话收到的数据（已解码成文本）。取走即清空。 */
  text: string
  /** 这条会话累计收到的字节数（不随 drain 清零）。 */
  bytes: number
  /** 因超过 MAX_PENDING_CHARS 被丢弃的字符数。非 0 即代表扫描有盲区。 */
  dropped: number
}

export interface MultiSessionDiagnostics {
  /** 开一条新会话，返回 sessionId；resolve 时它的数据端口已经接好。 */
  open(cols?: number, rows?: number): Promise<string>
  /** 把 `text` 当作用户输入写进指定会话的数据端口（等价于在那个终端里打字）。 */
  write(sessionId: string, text: string): void
  /** 取走每条会话自上次调用以来收到的数据。 */
  drain(): Record<string, DiagnosticSessionSnapshot>
  /** 本驱动面开过的所有 sessionId，按开的顺序。 */
  openedIds(): string[]
}

interface SessionRecord {
  port: MessagePort
  chunks: string[]
  pendingChars: number
  bytes: number
  dropped: number
  decoder: TextDecoder
  ack: AckBatcher
}

export interface MultiSessionDeps {
  /** 控制面客户端：开会话、发 ack 都走它，跟产品用的是同一个实例。 */
  client: ProtocolClient
  /** 向主进程要某条会话的数据端口（产品里就是 `window.ht.openDataPort`）。 */
  openDataPort(sessionId: string): void
}

/** 默认终端尺寸。这些会话不上屏，尺寸只影响 PTY 创建那一瞬间。 */
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40

export function createMultiSessionDiagnostics(deps: MultiSessionDeps): MultiSessionDiagnostics {
  const sessions = new Map<string, SessionRecord>()
  const order: string[] = []
  /** 等数据端口到场的 open() 调用，按 sessionId 认领。 */
  const awaitingPort = new Map<string, (port: MessagePort) => void>()

  // 端口是主进程经 preload 用 window.postMessage 递进来的，跟 boot.ts 里
  // waitForDataPort 是同一条路。`e.source === window` 这道校验不能省，理由见
  // boot.ts 的 fromPreload：window 上的 message 事件是公共的。
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || e.data?.kind !== 'port:data') return
    const claim = awaitingPort.get(e.data.sessionId)
    // 主终端那条会话的端口也会经过这里——它由 boot.ts 认领，不在 awaitingPort
    // 里，直接放过（**绝不能**在这里 start() 或读它，那会把主终端的数据截走，
    // 变成"诊断代码改变了业务行为"）。
    if (!claim) return
    awaitingPort.delete(e.data.sessionId)
    claim(e.ports[0])
  })

  function attach(sessionId: string, port: MessagePort): void {
    const ack = new AckBatcher((bytesConsumed) => {
      const req = SessionAckRequest.encode({ sessionId, bytesConsumed }).finish()
      deps.client.request('session.ack', req).catch(() => {
        // 和 boot.ts 一样退回重试：ack 丢了那批字节在核心侧就永远算"未确认"，
        // 累到高水位读线程就停了，症状是这条会话此后再无数据——串扰测试会
        // 因此变成"谁都没收到东西"，是最难查的那种假红。
        ack.returnUnacknowledged(bytesConsumed)
      })
    })
    const rec: SessionRecord = {
      port, chunks: [], pendingChars: 0, bytes: 0, dropped: 0,
      decoder: new TextDecoder(), ack,
    }
    sessions.set(sessionId, rec)

    port.onmessage = (m) => {
      const bytes = new Uint8Array(m.data)
      rec.bytes += bytes.byteLength
      // stream: true——一块数据可能把一个多字节字符切成两半。标记串本身是纯
      // ASCII，但从端（真 shell）的输出不是，不带 stream 会在块边界插入替换
      // 字符，那是白白给判据加噪声。
      const text = rec.decoder.decode(bytes, { stream: true })
      rec.chunks.push(text)
      rec.pendingChars += text.length
      while (rec.pendingChars > MAX_PENDING_CHARS && rec.chunks.length > 1) {
        const dropped = rec.chunks.shift()!
        rec.pendingChars -= dropped.length
        rec.dropped += dropped.length
      }
      // 消费即确认：这些会话没有 xterm，"渲染层消费完了"在这里就等于"收到了"。
      rec.ack.consumed(bytes.byteLength)
    }
    // 注意顺序：先装 onmessage 再 start()。反过来会打开一个"已经开始派发、
    // 但还没有接收者"的窗口，落进去的消息直接消失（boot.ts 里那段注释讲的是
    // 同一件事）。这里其实赋值 onmessage 已经隐式 start 了，显式再调一次是
    // 幂等的，写出来是为了让顺序这件事在代码里看得见。
    port.start()
  }

  return {
    open(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
      const payload = SessionOpenRequest.encode({ shell: '', cols, rows, cwd: '' }).finish()
      return deps.client.request('session.open', payload).then((p) => {
        const { sessionId } = SessionOpenResponse.decode(p)
        const ready = new Promise<MessagePort>((resolve) => awaitingPort.set(sessionId, resolve))
        // 先挂好认领者再发请求：端口是异步递回来的，反过来就有丢端口的窗口。
        deps.openDataPort(sessionId)
        return ready.then((port) => {
          attach(sessionId, port)
          order.push(sessionId)
          return sessionId
        })
      })
    },

    write(sessionId, text) {
      const rec = sessions.get(sessionId)
      if (!rec) throw new Error(`[__htDiagnostics.sessions] 未知会话 ${sessionId}`)
      // **千万不要**改成 postMessage(bytes.buffer, [bytes.buffer])：对端是
      // utility 进程的 MessagePortMain，transfer 列表里出现 ArrayBuffer 会让
      // 整条消息被静默丢弃（electron#34905）。产品侧 boot.ts 的 onInput 踩过
      // 这个坑，这里跟它保持完全一致的写法。
      rec.port.postMessage(new TextEncoder().encode(text))
    },

    drain() {
      const out: Record<string, DiagnosticSessionSnapshot> = {}
      for (const [sessionId, rec] of sessions) {
        out[sessionId] = { text: rec.chunks.join(''), bytes: rec.bytes, dropped: rec.dropped }
        rec.chunks = []
        rec.pendingChars = 0
      }
      return out
    },

    openedIds: () => [...order],
  }
}
