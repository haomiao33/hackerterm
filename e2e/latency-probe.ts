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
}

declare global {
  interface Window {
    __htLatency?: {
      /** 开一轮：清干净上一轮的残留，准备接收下一次按键的 t0。 */
      arm(): void
      /** 等这一轮的样本落地。返回 false 表示超时没等到（已计入 unpaired）。 */
      waitArmed(): Promise<boolean>
      snapshot(): LatencyProbeSnapshot
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
      return { samples, nonKeyOnData, unpaired, writesOutsideRound, keyDataEvents }
    },
  }

  term.onData((data: string) => {
    // 关键的一行：xterm 的自动回复（CPR/DA…）也从这里出去，内容不等于按键字符。
    // 拿它当 t0 就会凭空多出样本，见文件头注释。
    if (data !== config.key) { nonKeyOnData += 1; return }
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
