/**
 * 三段时延测量共用的**采样口径**：晾多久、丢几个预热样本、两轮之间隔多久、
 * 从端跑哪个程序。
 *
 * 单独抽成一个模块，是因为口径不一致会直接产出**物理上不可能的数字**，而且看不
 * 出来。真实案例（Windows CI 上连着两次运行）：
 *
 *   PTY  中位数=0.39 p95=7.41 max=18.50
 *   NAPI 中位数=0.60 p95=0.70 max=0.83
 *   FULL 中位数=1.20 p95=3.00 max=3.10
 *
 * 三段本该是嵌套包含关系（PTY ⊂ NAPI ⊂ FULL），可子集的 p95/max 却比父集大一个
 * 数量级。根因之一就是各段的节奏各写各的：PTY 段晾 800ms、每轮间隔 20ms，整个
 * 采样窗口（60 轮 ≈ 1.2 秒）全部落在 PowerShell 还在冷启动的那几秒里；NAPI/FULL
 * 两段晾 1000ms 又加 10 轮预热（≈2.2 秒）才开始记账，量到的是热态。同一台机器、
 * 同一条 PTY，一个量冷的一个量热的，放在一起比较毫无意义。
 *
 * 所以这些常量是**唯一真相**，三段（含 Rust 侧的 examples/pty_latency.rs，通过
 * 环境变量接收）都从这里取。
 */

/** 每段正式采样次数。几十次才谈得上中位数/p95。 */
export const SAMPLES = 60

/**
 * 正式采样前先测、然后**丢掉**的样本数。
 *
 * 为什么是"测了再丢"而不是"空跑"：丢掉的那些样本本身是重要证据。实测 PTY 段头
 * 几轮是 926ms / 346ms / 93ms / 19ms 这种量级——那是 PTY 子进程冷启动、首次页
 * 错误、V8/JIT、xterm 首次解析路径这些一次性开销。混进正式样本会把 p95 从 7.44
 * 抬到 11.80；而完全不打印又会让"这台机器冷启动到底有多慢"这条信息消失。所以
 * 三段一律：照测、单独打印一行、不计入正式统计，并在输出里写明丢了几个。
 *
 * 20 个 × 120ms ≈ 2.4 秒，加上 SETTLE_MS 一共约 4 秒的预热窗口。
 */
export const WARMUP = 20

/** 两次采样之间的间隔：留足时间让上一轮完全走完，避免相邻两轮互相污染。 */
export const GAP_MS = 120

/** 会话建立后先晾多久，等 shell 把横幅/提示符吐完再开始量。 */
export const SETTLE_MS = 1500

/** 单次往返的等待上限。正常是毫秒级，超过说明这一轮丢了，记为丢失不计入样本。 */
export const ROUNDTRIP_TIMEOUT_MS = 2000

/** 每轮往 PTY 写的那个可打印字符。三段必须一致。 */
export const KEY = 'x'

/**
 * 三段统一使用的 shell（PTY 从端跑的程序）。
 *
 * 显式钉死而不是各段各自走默认值：`session.rs::default_shell()` 在类 Unix 下读
 * `$SHELL`、缺省回退 `/bin/zsh`（很多容器里没装），Windows 下固定 powershell.exe。
 * 各段进程的环境变量未必一样，钉死之后"三段跑的是同一个 shell"才是有保证的，
 * 而不是碰巧的。
 */
export function measurementShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL ?? '/bin/bash'
}

export interface Stats {
  n: number
  min: number
  median: number
  p95: number
  max: number
}

/** 一段测量的完整产出：正式样本 + 被丢弃的预热样本 + 口径说明 + 诊断计数。 */
export interface Segment {
  /** 表格里的行首标签。 */
  label: string
  /** 这一段到底量的是什么（起点 → 终点），一句话写清楚，打印在结果下方。 */
  what: string
  /** 被丢弃的预热样本（照样打印）。 */
  warmup: number[]
  /** 正式样本。 */
  measured: number[]
  /** 诊断计数，逐条打印。配对异常、丢包、多块回传都要出现在这里。 */
  notes: string[]
}

export function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b)
  if (sorted.length === 0) return { n: 0, min: NaN, median: NaN, p95: NaN, max: NaN }
  // 最近秩法（nearest-rank）：p 分位取第 ceil(p·n) 小的那个值，不做插值。
  // 样本只有几十个，插值出来的小数点位数是假精度。
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
  return {
    n: sorted.length,
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  }
}

export const ms = (v: number): string => (Number.isNaN(v) ? '     --' : v.toFixed(2).padStart(7))

export function printRow(label: string, s: Stats): void {
  console.log(
    `${label.padEnd(30)} n=${String(s.n).padStart(3)}  ` +
    `min=${ms(s.min)}  中位数=${ms(s.median)}  p95=${ms(s.p95)}  max=${ms(s.max)}  (ms)`,
  )
}

/** 打印一段：正式样本一行、被丢弃的预热样本一行、口径与诊断计数各一行。 */
export function printSegment(seg: Segment): void {
  printRow(seg.label, stats(seg.measured))
  const w = stats(seg.warmup)
  console.log(
    `${''.padEnd(30)} 已丢弃预热样本 ${String(w.n).padStart(3)} 个` +
    (w.n > 0 ? `（中位数=${ms(w.median).trim()} max=${ms(w.max).trim()} ms）` : ''),
  )
  console.log(`${''.padEnd(30)} 口径：${seg.what}`)
  for (const note of seg.notes) console.log(`${''.padEnd(30)} · ${note}`)
}

/** 相邻两轮之间的固定间隔。 */
export function gap(): Promise<void> {
  return new Promise((r) => setTimeout(r, GAP_MS))
}
