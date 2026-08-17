/**
 * FULL 段（渲染进程整程往返 t0 → t5）的**页面侧**埋点。
 *
 * ── 这个文件为什么要独立存在 ────────────────────────────────────────────
 *
 * 里面的函数是要被 `page.evaluate()` 丢进页面里执行的，也就是说它会被
 * `Function.prototype.toString()` 序列化后在另一个 realm 里重新求值：**不能引用
 * 任何模块作用域的东西**（import 进来的常量、闭包变量、外部辅助函数一概不行，
 * 序列化之后它们全是 ReferenceError）。所有参数只能通过 `page.evaluate` 的第二个
 * 参数传进去。独立成文件是为了让这条限制有地方写、也让它能被端到端测试复用
 * （latency-pairing.e2e.ts 用同一份实现验证配对逻辑，而不是各写一份）。
 *
 * ── 旧实现错在哪 ────────────────────────────────────────────────────────
 *
 * 旧实现是：`term.onData(() => pendingT0 = now)` + 包一层 `term.write`，写回调
 * 触发时若 `pendingT0` 非空就记一个样本。两个致命问题：
 *
 * 1. **`term.onData` 不只在按键时触发。** xterm 会自动回复终端查询——最常见的是
 *    光标位置报告（DSR/CPR，`ESC[6n` → `ESC[行;列R`），PSReadLine 每次重绘都会
 *    问一次。这些自动回复和按键走的是同一个 `onData`，于是"按键 → 回显"的配对
 *    里混进了"xterm 自动回复 → 下一块重绘数据"这种压根不是按键往返的区间，而且
 *    它天然极短。Windows CI 上 60 次按键量出 **61** 个样本，多出来的那一个就是
 *    这么来的——样本数对不上本身就是配对已经错乱的铁证，只是没人在意那个 n。
 *    这也解释了为什么 FULL 段（父集）的 p95/max 反而比 PTY 段（子集）小得多。
 *
 * 2. **一次按键的回显可能被从端分成好几块回来**（PowerShell 实测两批）。旧实现
 *    对"第 2..n 块"不记账也不计数，看不出这件事发生过。
 *
 * 现在的做法：
 * - 只接受**内容正好等于那个按键字符**的 `onData` 作为 t0，其余一律计数上报
 *   （`nonKeyOnData`），绝不参与配对；
 * - 每轮显式 `arm()` → 按键 → `waitArmed()`，一轮只收一个样本，收不到就记
 *   `unpaired` 并明确失败，不会顺延到下一轮去污染它；
 * - 所有"没配上对"的情况都有计数器，最后一并打印。宁可让数字难看，也不让异常
 *   悄悄消失。
 */

import type { Page } from 'playwright-core'

export interface LatencyProbeSample {
  /**
   * 这一轮 t0 的**绝对时刻**（渲染进程的 performance.now）。
   *
   * 留着它是为了把 core-host 那边同一次往返的分段埋点对上号：那些埋点经诊断通道
   * 转发到页面 console 时，boot.ts 会给每行加一个 `+NNNms` 前缀，而那个数正是
   * **同一个** performance.now 时钟。于是"第 i 轮的窗口 = [t0_i, t0_{i+1})"就能
   * 把内层样本准确地归到轮次上，不必假设两串样本一一对齐——真机上 xterm 的自动
   * 回复也会往数据面写字节，内层样本数天然可能比按键数多。
   */
  t0: number
  /** 这一轮的往返耗时（ms）。 */
  ms: number
}

export interface LatencyProbeSnapshot {
  /** 按轮次顺序记录的往返，一轮至多一个。 */
  samples: LatencyProbeSample[]
  /** 内容不是按键字符的 `onData` 次数——xterm 自动回复（CPR/DA 等）就落在这里。 */
  nonKeyOnData: number
  /** 按键发出后在超时窗口内没等到回显的轮数。 */
  unpaired: number
  /** 不属于任何一次按键的 `term.write` 次数（会话横幅、多块回显的第 2..n 块）。 */
  writesOutsideRound: number
  /** 被接受为 t0 的按键 `onData` 次数，正常应等于轮数。 */
  keyDataEvents: number
  /**
   * 非按键 `onData` 按**上报类别**的计数，例如 `{ CPR: 3, FOCUS: 1 }`。
   *
   * 纯诊断，不参与任何配对判定。它存在的理由是上一轮的教训：Windows CI 红掉时，
   * 日志里只有三行裸字节（`1b 5b 49`），得有人肉眼把它认成"焦点上报"才能往下查。
   * 分类打在快照里，下次同类问题第一眼就能看出是哪种自动回复。
   */
  nonKeyKinds: Record<string, number>
  /** 头几条非按键 `onData` 的十六进制原文，供分类不认识时回看原始字节。 */
  nonKeySamples: string[]
  /**
   * 「一轮已经开着、且已经收到按键 t0，此时又冒出一条非按键 `onData`」的轮数。
   *
   * 这是**污染判定**：那条自动回复也会被写进 PTY 并回显回来，于是本轮的 t5 有可能
   * 落在"自动回复的回显"上而不是"按键的回显"上，量出来的就不是按键往返。正常轮次
   * 这个数应当是 0；不为 0 时样本仍然照记（不静默丢弃），但读数字的人必须知道
   * 有这么多轮是可疑的。
   */
  taintedRounds: number
}

declare global {
  interface Window {
    __htLatency?: {
      /** 开一轮：清干净上一轮的残留，准备接收下一次按键的 t0。 */
      arm(): void
      /** 等这一轮的样本落地。返回 false 表示超时没等到（已计入 unpaired）。 */
      waitArmed(): Promise<boolean>
      snapshot(): LatencyProbeSnapshot
      /**
       * 把所有计数器和样本清零，回到刚装好的状态。
       *
       * 只给「**就绪探测**」用：探测阶段要反复按键直到回显通路真的活了（见
       * latency-pairing.e2e.ts 的 `waitForEchoPath`），那些失败的轮次会把
       * `unpaired` 和 `samples` 记花。清零之后正式阶段的计数才是干净的。
       * `pnpm measure:latency`（latency.ts）**不调用它**，测量口径一个字没变。
       */
      reset(): void
    }
  }
}

/**
 * 把埋点装进页面。**测量和端到端测试都必须走这个函数**，不要直接
 * `page.evaluate(installLatencyProbe, …)`。
 *
 * 那一层 `__name` 补丁是必需的：tsx/esbuild 默认开着 `--keep-names`，会把每个
 * **具名**函数（`installLatencyProbe` 自己、还有它内部的 `finishRound`）包一层
 * `__name(fn, "名字")` 来保住 `Function.prototype.name`。而 `page.evaluate` 是把
 * 函数源码丢进页面重新求值的，页面里根本没有那个打包器辅助函数，于是埋点安装
 * 时直接 `ReferenceError: __name is not defined`——而且这个错只在 tsx 下出现，
 * vitest 转译同一份代码时不加这层包装，端到端测试全绿、`pnpm measure:latency`
 * 却跑不起来。这里用**字符串形式**的 evaluate 补一个恒等实现（字符串不经过任何
 * 打包器转换，不会重新引入同一个问题）。
 */
export async function installLatencyProbeOn(
  page: Page,
  config: { key: string, timeoutMs: number },
): Promise<void> {
  await page.evaluate('window.__name = window.__name || function (target) { return target }')
  await page.evaluate(installLatencyProbe, config)
}

/**
 * 安装页面侧埋点。**函数体不得引用任何外部标识符**（见文件头注释）。
 *
 * - t0 取 `term.onData`——和 boot.ts 里 onInput 同一个事件源。xterm 支持挂多个
 *   监听器，我们这个只读时间、不干预数据。
 * - t5 取 `term.write` 的完成回调。boot.ts 里就是 `term.write(bytes, cb)`，cb
 *   触发即"xterm 消费完成"，正是任务定义的 t5。这里在测试侧把实例上的 write
 *   包一层再转调原函数（mount.ts 返回的 handle 是在调用时才查 term.write，
 *   所以包在实例上就能拦到），既拿到了准确的 t5，又不动一行生产代码。
 *   （不用 term.onWriteParsed：实测这个公开事件在 @xterm/xterm 6 上根本不触发，
 *   写回调是可靠的那个。）
 */
export function installLatencyProbe(config: { key: string, timeoutMs: number }): void {
  const term = window.__htDiagnostics!.term
  const samples: { t0: number, ms: number }[] = []
  let nonKeyOnData = 0
  let unpaired = 0
  let writesOutsideRound = 0
  let keyDataEvents = 0
  let nonKeyKinds: Record<string, number> = {}
  let nonKeySamples: string[] = []
  let taintedRounds = 0

  /**
   * 把一条非按键的 `onData` 归到某个**终端上报类别**。
   *
   * ── 判据为什么是「以 ESC(0x1b) 开头」而不是逐条枚举 ────────────────────
   * 上一轮只堵了 CPR，Windows 上立刻又冒出焦点上报 `ESC[I`；再堵一条，下次换
   * PSReadLine 问一次 DA2 又会重来。所以判据必须是**类级**的。
   *
   * 把 @xterm/xterm 6 里所有会主动往 `onData` 写东西的地方列全（源码实测，不是
   * 猜的）：
   *   - `common/InputHandler.ts:1672/1674`  DA1  `CSI c`   → `ESC[?1;2c` / `ESC[?6c`
   *   - `common/InputHandler.ts:1711-1719`  DA2  `CSI > c` → `ESC[>0;276;0c` 等
   *   - `common/InputHandler.ts:2264`       DECRPM（答 DECRQM）→ `ESC[?m;v$y`
   *   - `common/InputHandler.ts:2657`       DSR 5（工作状态）→ `ESC[0n`
   *   - `common/InputHandler.ts:2663`       DSR 6 / CPR（光标位置）→ `ESC[y;xR`
   *   - `common/InputHandler.ts:2678`       DECXCPR `CSI ?6n` → `ESC[?y;xR`
   *   - `common/InputHandler.ts:2856`       窗口操作 `CSI 18t` → `ESC[8;rows;colst`
   *   - `common/InputHandler.ts:3418`       DCS 应答（DECRQSS/XTGETTCAP）→ `ESC P … ESC \`
   *   - `common/services/CoreMouseService.ts:331`  鼠标上报 → `ESC[<…M/m`
   *   - `browser/CoreBrowserTerminal.ts:270/294/1295/1297`  焦点上报（模式 1004）
   *     → `ESC[I` / `ESC[O`   ← **这就是本轮 Windows CI 红掉的那一条**
   *   - `browser/Clipboard.ts:23`           括号粘贴（模式 2004）→ `ESC[200~…ESC[201~`
   *
   * 这一整张表**无一例外**都以 ESC 开头——它们全都是 ANSI 控制序列（CSI `ESC[`
   * 或 DCS `ESC P`）。而我们量的按键是一个**可打印字符**。于是判据就一条：
   * **以 ESC 开头的一律是终端上报，永远不可能是我们要量的那次按键。**
   * 将来 xterm 加了什么新的上报（XTVERSION、颜色查询 OSC 应答……）也照样落网，
   * 不需要有人回来补名单——这正是"别只打补丁堵已知的两种"的意思。
   *
   * 下面细分的类别名**纯粹是给人看的诊断标签**，认不出来就归 `CSI-other` /
   * `ESC-other`，不影响任何判定：判定只用上面那一条。
   */
  function classifyNonKey(data: string): string {
    if (data.charCodeAt(0) !== 0x1b) return 'plain' // 不以 ESC 开头：不是终端上报
    if (data.length < 2) return 'ESC-bare'
    if (data[1] === 'P') return 'DCS'
    if (data[1] !== '[') return 'ESC-other'
    const body = data.slice(2)
    if (/^[IO]$/.test(body)) return 'FOCUS' // ESC[I 进入 / ESC[O 离开
    if (/^20[01]~$/.test(body)) return 'PASTE'
    if (/^\?[\d;]*R$/.test(body)) return 'DECXCPR'
    if (/^[\d;]*R$/.test(body)) return 'CPR'
    if (/^\??[\d;]*c$/.test(body)) return 'DA'
    if (/^[\d;]*n$/.test(body)) return 'DSR'
    if (/^\??[\d;]*\$y$/.test(body)) return 'DECRPM'
    if (/^[\d;]*t$/.test(body)) return 'WINOPS'
    if (/^</.test(body)) return 'MOUSE'
    return 'CSI-other'
  }

  /** 记一条非按键 `onData`：计数 + 分类 + 留前几条原始字节。 */
  function noteNonKey(data: string): void {
    nonKeyOnData += 1
    const kind = classifyNonKey(data)
    nonKeyKinds[kind] = (nonKeyKinds[kind] ?? 0) + 1
    if (nonKeySamples.length < 12) {
      let hex = ''
      for (let i = 0; i < data.length; i++) {
        hex += (i > 0 ? ' ' : '') + data.charCodeAt(i).toString(16).padStart(2, '0')
      }
      nonKeySamples.push(`${kind}: ${hex}`)
    }
  }

  // 一轮的状态机：idle →（arm）armed →（按键 onData）计时中 →（write 回调）已出结果。
  //
  // `result` 这个字段是必需的，不能只用 `armed` 判断：`waitArmed()` 是脚本从
  // 进程外经 CDP 调进来的，一次往返本身就要一毫秒上下，而按键回显也是这个量级——
  // **回显完全可能在 waitArmed 到达页面之前就落地了**。少了"本轮已出结果"这个
  // 状态，那种情况会被当成"没 arm"而返回 false，于是每一轮都被记成失败，可样本
  // 又明明记满了（实测：80 轮全部报失败，同时 80 个样本一个不少）。
  let armed = false
  let result: boolean | null = null
  let t0: number | null = null
  let settle: ((ok: boolean) => void) | null = null

  function finishRound(ok: boolean): void {
    armed = false
    result = ok
    t0 = null
    const resolve = settle
    settle = null
    resolve?.(ok)
  }

  window.__htLatency = {
    arm(): void {
      armed = true
      result = null
      t0 = null
    },
    waitArmed(): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        if (result !== null) { resolve(result); return } // 已经出结果了（常态）
        if (!armed) { resolve(false); return } // 压根没 arm，调用方用错了
        settle = resolve
        setTimeout(() => {
          if (settle === resolve) {
            unpaired += 1
            finishRound(false)
          }
        }, config.timeoutMs)
      })
    },
    snapshot(): LatencyProbeSnapshot {
      return {
        samples, nonKeyOnData, unpaired, writesOutsideRound, keyDataEvents,
        nonKeyKinds, nonKeySamples, taintedRounds,
      }
    },
    reset(): void {
      samples.length = 0
      nonKeyOnData = 0
      unpaired = 0
      writesOutsideRound = 0
      keyDataEvents = 0
      nonKeyKinds = {}
      nonKeySamples = []
      taintedRounds = 0
      armed = false
      result = null
      t0 = null
      settle = null
    },
  }

  term.onData((data: string) => {
    // 关键的一行：xterm 的自动回复（CPR/DA/焦点上报/DCS…）也从这里出去，内容不等于
    // 按键字符。拿它当 t0 就会凭空多出样本，见文件头注释与 classifyNonKey 的说明。
    //
    // 判定本身仍然是最严的那一条——**内容必须正好等于那个按键字符**，这是
    // classifyNonKey 那条"以 ESC 开头即上报"判据的超集：任何自动回复、任何将来新增
    // 的上报、任何多字节序列都进不来。分类只用来产出可读的诊断。
    if (data !== config.key) {
      noteNonKey(data)
      // 本轮已经拿到按键 t0 了，却又冒出一条自动回复：那条回复也会被写进 PTY 再
      // 回显回来，本轮的 t5 有可能落在它的回显上而不是按键的回显上。样本照记
      // （不静默丢弃），但把这一轮标成可疑。
      if (armed && t0 !== null) taintedRounds += 1
      return
    }
    keyDataEvents += 1
    if (!armed) return
    t0 = performance.now()
  })

  const originalWrite = term.write.bind(term)
  term.write = (data: string | Uint8Array, callback?: () => void): void => {
    originalWrite(data, () => {
      if (armed && t0 !== null) {
        samples.push({ t0, ms: performance.now() - t0 })
        finishRound(true)
      } else {
        // 不属于任何一次按键：会话横幅、多块回显的第 2..n 块、shell 的异步输出。
        writesOutsideRound += 1
      }
      callback?.()
    })
  }
}
