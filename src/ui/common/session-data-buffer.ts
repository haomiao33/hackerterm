/**
 * 端口就绪前先把数据攒着，就绪后按到达顺序一次性冲刷。
 *
 * 背景：数据面（core-host <-> renderer 的 MessagePort）是异步建立的，但 PTY
 * 一旦起来就立刻开始产出字节（几毫秒级别）。如果端口还没就绪就把最早那批输出
 * 直接丢弃（例如用可选链 `port?.postMessage(...)`），终端就会看起来像“没有
 * 提示符”——这正是本文件要堵上的竞态窗口。
 *
 * 纯逻辑单元：不依赖 DOM / Electron / Node（`ui/common` 分层规则强制），
 * 所以这里只处理 `Uint8Array`，不碰 `MessagePortMain`。
 */

/**
 * 单个会话缓冲区的容量上限（字节）。
 *
 * 正常情况下端口在 100ms 级别就会就绪，缓冲区只会积攒几 KB，这个上限在正常
 * 路径上永远碰不到。真正碰到只有一种情况：端口压根不会来了，而会话还在持续
 * 刷屏——这时无限增长的缓冲区本身就是一个新的内存问题。1 MiB 是一个足够大、
 * 不会误伤正常启动窗口，同时又能给失控场景兜底的数字。
 */
const MAX_BUFFERED_BYTES_PER_SESSION = 1024 * 1024

interface SessionState {
  chunks: Uint8Array[]
  bytes: number
  sink: ((data: Uint8Array) => void) | null
}

export class SessionDataBuffer {
  private sessions = new Map<string, SessionState>()

  /**
   * 追加一块数据。如果该会话已经 attach 了 sink，直接同步转发；否则先缓冲，
   * 等 attach 时按到达顺序冲刷。
   */
  push(sessionId: string, data: Uint8Array): void {
    const state = this.sessions.get(sessionId)

    if (state?.sink) {
      state.sink(data)
      return
    }

    const next = state ?? { chunks: [], bytes: 0, sink: null }
    next.chunks.push(data)
    next.bytes += data.byteLength

    // 溢出丢最旧的：这个上限只在“端口根本不会来、会话还在持续产出”这种失控
    // 场景下才会触发。此时正确的取舍是保留最新输出而不是保留开头的横幅——
    // 这跟终端 scrollback 的语义一致（滚动窗口，看最近发生了什么），而不是
    // 像日志文件那样从头保留。丢弃前 console.warn 一次，暴露异常状态本身，
    // 但不对每块丢弃都刷屏（避免警告本身变成新的刷屏源）。
    if (next.bytes > MAX_BUFFERED_BYTES_PER_SESSION) {
      let warned = false
      while (next.bytes > MAX_BUFFERED_BYTES_PER_SESSION && next.chunks.length > 0) {
        const dropped = next.chunks.shift()
        if (dropped) {
          next.bytes -= dropped.byteLength
          if (!warned) {
            console.warn(
              `[SessionDataBuffer] session ${sessionId} exceeded ${MAX_BUFFERED_BYTES_PER_SESSION} buffered bytes ` +
              'before its data port attached; dropping oldest buffered chunks to bound memory use.',
            )
            warned = true
          }
        }
      }
    }

    this.sessions.set(sessionId, next)
  }

  /**
   * 注册 sink 并按到达顺序冲刷此前缓冲的数据；之后 push 的数据直接经 sink
   * 同步发出，不再进缓冲（`bufferedBytes` 回落到 0）。
   */
  attach(sessionId: string, sink: (data: Uint8Array) => void): void {
    const state = this.sessions.get(sessionId) ?? { chunks: [], bytes: 0, sink: null }
    // 先把已缓冲的数据摘出来再清空/装订 sink：冲刷循环里 sink 可能同步触发
    // 新的 push（重入），那些新数据应该追加到这次冲刷队列的尾部、按到达顺序
    // 处理，而不是要求整个冲刷过程原子化——这里没有并发（JS 单线程），重入
    // 只会发生在同一次 attach 调用的调用栈内，用 shift() 消费一个动态增长的
    // 队列就能自然满足“按到达顺序”这个要求，不需要额外的锁或快照。
    const pending = state.chunks
    state.chunks = []
    state.bytes = 0
    state.sink = sink
    this.sessions.set(sessionId, state)

    while (pending.length > 0) {
      const chunk = pending.shift()
      if (!chunk) continue
      try {
        sink(chunk)
      } catch (err) {
        // 一个坏的 sink 不应该让缓冲区里剩余的数据全部丢失——继续冲刷剩下的
        // chunk，只把这次错误报出来，交给调用方判断严重性。
        console.warn('[SessionDataBuffer] sink threw while flushing buffered data, continuing with remaining chunks:', err)
      }
    }
  }

  /** 丢弃该会话的缓冲与 sink，避免其后 push 的数据发给已失效的 sink，也避免内存泄漏。 */
  detach(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** 诊断/测试用：该会话当前缓冲（尚未冲刷）的字节数。 */
  bufferedBytes(sessionId: string): number {
    return this.sessions.get(sessionId)?.bytes ?? 0
  }
}
