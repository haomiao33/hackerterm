import { DATA_BATCH_WINDOW_MS } from './limits'

/**
 * PTY 出向数据的合批器：**首块立即发，之后 `windowMs` 毫秒内到达的合并成一批**。
 *
 * ── 为什么不照抄 VS Code ────────────────────────────────────────────────
 *
 * VS Code 的 `TerminalDataBufferer`（`src/vs/platform/terminal/common/
 * terminalDataBuffering.ts`）用的是纯尾沿节流，`throttleBy = 5`：**第一块数据
 * 也要等满 5ms 才发**。对刷屏（吞吐）这是对的，但对一次孤立的按键回显，那 5ms
 * 是纯粹加上去的延迟——没有第二块数据可以跟它合并，等待换不来任何东西。真机
 * 反馈已经是"感觉有延迟"，而本地实测整程往返中位数只有 1.00ms，无条件加 5ms
 * 等于把它变成 6ms，直接把这条链路做坏 6 倍。
 *
 * 所以这里改成**首沿 + 续窗**：
 *   - 窗口关闭（空闲）时到达的块 → 立刻发出，零额外延迟，同时开一个新窗口；
 *   - 窗口开启期间到达的块 → 攒着，窗口到期时合并成一条发出；
 *   - 窗口到期时若攒到了东西 → 发出后**继续开窗**（数据还在流），而不是回到
 *     空闲态。
 *
 * 最后这条是关键，也是"首块立即发会不会退化成不批"这个疑问的答案：如果每次
 * 窗口到期都回到空闲态，持续刷屏时就会退化成"合一批、单发一条、再合一批"的
 * 交替，合批率被腰斩；续窗之后，稳态刷屏就是严格的每 `windowMs` 一条消息，
 * 跟 VS Code 的节流率完全一样。两者的差别**只**体现在"安静之后的第一块"上，
 * 而那一块正是按键回显。
 *
 * 代价要说清楚：一次按键的回显如果被 PTY 分成多块回来（PowerShell 实测就是
 * 两批），第一块零延迟，其余块最多晚 `windowMs` 毫秒。这比 VS Code 的"所有块
 * 都晚 windowMs"严格更好，但不是零代价。
 *
 * 纯逻辑单元：不依赖 DOM / Electron / Node（`ui/common` 分层规则强制），
 * 定时器只用 `setTimeout`/`clearTimeout` 这两个两侧都有的全局。
 */
export class DataBatcher {
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  /** 非 null 即代表"窗口开着"。空闲判定只看它，不看 pending 是否为空。 */
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly emit: (data: Uint8Array) => void,
    private readonly windowMs: number = DATA_BATCH_WINDOW_MS,
  ) {}

  /** 收到 PTY 的一块出向数据。 */
  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return

    if (this.timer === null) {
      // 空闲态：这一块没有任何东西可以跟它合并，等待只会白白增加延迟。
      this.emit(chunk)
      this.openWindow()
      return
    }
    this.pending.push(chunk)
    this.pendingBytes += chunk.byteLength
  }

  private openWindow(): void {
    this.timer = setTimeout(() => this.onWindowEnd(), this.windowMs)
  }

  private onWindowEnd(): void {
    if (this.pendingBytes === 0) {
      // 整个窗口里一块都没来 → 数据流真的停了，回到空闲态，好让下一块重新
      // 享受"立即发"。
      this.timer = null
      return
    }
    this.flushPending()
    // 数据还在流：直接续窗，不回空闲态。否则持续刷屏会退化成"合批一条、
    // 单发一条"的交替，白白多出一半消息（见类注释）。
    this.openWindow()
  }

  private flushPending(): void {
    const merged = concat(this.pending, this.pendingBytes)
    this.pending = []
    this.pendingBytes = 0
    this.emit(merged)
  }

  /**
   * 会话结束：停掉窗口并丢弃攒着的数据。
   *
   * 丢而不是冲刷，是因为唯一的调用点是数据端口 `close` —— 对端已经没了，
   * 这时候 emit 只会往一个已关闭的 MessagePort 上写（静默 no-op），
   * 还多留一个定时器句柄。
   */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = []
    this.pendingBytes = 0
  }

  /** 诊断/测试用：当前攒着、尚未发出的字节数。 */
  get bufferedBytes(): number {
    return this.pendingBytes
  }
}

/** 把若干块合并成一块。`totalBytes` 由调用方维护，省一次遍历求和。 */
function concat(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  // 只有一块时直接原样返回：合批的常见情形是窗口里只多来了一块，
  // 这时再拷一次纯属浪费。
  if (chunks.length === 1) return chunks[0]
  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}
