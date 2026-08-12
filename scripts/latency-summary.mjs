/**
 * 把 Windows CI 上两次时延测量的输出，翻成 GitHub Actions 运行摘要页
 * （`$GITHUB_STEP_SUMMARY`）上的 Markdown 表格。
 *
 * ── 为什么要有这个脚本 ────────────────────────────────────────────────
 * 用户只下载打包好的 zip，本机没有 Node / Rust / pnpm，跑不了
 * `pnpm measure:latency`。所以测量必须搬到 CI，而且结果要**直接显示在
 * Actions 的运行摘要页**上——点开就能读，不用下载 artifact、不用翻几千行
 * 日志。这个脚本就是那一层翻译。
 *
 * ── 为什么是"解析日志"而不是"自己去跑测量" ───────────────────────────
 * 两条既有资产（crates/ht-core/examples/pty_latency.rs、e2e/latency.ts）本轮
 * 明令不得改动测试逻辑。让 workflow 原样跑它们、把 stdout tee 进文件，这个
 * 脚本只读文件，测量代码就一行都不用碰；顺带 CI 日志里也留着完整原始输出，
 * 摘要页上的数字随时可以回去对账。
 *
 * 用法：
 *   node scripts/latency-summary.mjs <conpty.log> <full.log> >> "$GITHUB_STEP_SUMMARY"
 *
 * 任何一份日志缺失或解析不出来，都**如实写"未测到"**并把原因写进摘要，绝不
 * 拿零、拿上一次的数、拿估算值凑一张看着完整的表——错的性能数字比没有数字
 * 更糟，会被人当成结论引用。
 */
import { readFileSync } from 'node:fs'

const [conptyLogPath, fullLogPath] = process.argv.slice(2)

/**
 * 分位数取法跟 e2e/latency.ts 里的 `stats()` 完全一致
 * （排序后取 `sorted[floor(q * n)]`，不做插值）。口径必须一样，否则本页
 * 第 1 节（我们自己算的）和第 2 节（latency.ts 算好直接抄的）两组数字没法比。
 */
function stats(samples) {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    n: sorted.length,
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  }
}

function readLogOrNull(path) {
  if (!path) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * 从纯 Rust example 的输出里捞样本。
 *
 * 一份日志里可能有多行 `PTY_LATENCY_JSON`——workflow 会把这个 example 连跑
 * 几遍再把样本合池。理由是 n=60 时 p95 只压着 3 个样本，在共享 CPU 的
 * runner 上噪声太大；多跑几轮把 n 抬上去，p95 才有点意义。这个 example 单轮
 * 只要两三秒，成本可以忽略。
 */
function parseConptySamples(log) {
  const samples = []
  let runs = 0
  for (const line of log.split(/\r?\n/)) {
    const marker = 'PTY_LATENCY_JSON '
    const idx = line.indexOf(marker)
    if (idx < 0) continue
    try {
      const parsed = JSON.parse(line.slice(idx + marker.length))
      if (Array.isArray(parsed.samples_ms)) {
        samples.push(...parsed.samples_ms.map(Number))
        runs += 1
      }
    } catch {
      // 单行坏了就跳过这一行，其余轮次照常合池——不因为一行脏数据丢掉整份测量。
    }
  }
  return { samples, runs }
}

/**
 * 从 `pnpm measure:latency` 的输出里捞那三行分段结果。
 *
 * latency.ts 打出来长这样（printRow）：
 *   PTY   t2→t3  PTY 自己                n= 60  min=   0.14  中位数=   0.44  p95=   0.87  max=   1.01  (ms)
 *
 * 正则刻意只依赖 ASCII 锚点（行首的 PTY/NAPI/FULL、`n=`、`min=`、`p95=`、
 * `max=`），中位数那一列用 `\S+=` 匹配——万一 Windows runner 上 CJK 输出的
 * 编码出了岔子，这条正则也照样能把数字取出来，不会因为一个中文标签把整份
 * 测量作废。
 */
const ROW_RE = /^(PTY|NAPI|FULL)\b.*?\bn=\s*(\d+)\s+min=\s*([\d.]+)\s+\S+=\s*([\d.]+)\s+p95=\s*([\d.]+)\s+max=\s*([\d.]+)/

function parseSegments(log) {
  const segments = {}
  for (const line of log.split(/\r?\n/)) {
    const m = ROW_RE.exec(line.trim())
    if (!m) continue
    segments[m[1]] = {
      n: Number(m[2]),
      min: Number(m[3]),
      median: Number(m[4]),
      p95: Number(m[5]),
      max: Number(m[6]),
    }
  }
  return segments
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—')
const pct = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—')

const out = []
const say = (line = '') => out.push(line)

say('## 键盘 → PTY → 屏幕：Windows 时延分段测量')
say()
say('这一页回答一个问题：**用户敲一个键到屏幕上出现回显的这段时间里，ConPTY 自己占多少，HackerTerm 的 IPC + 渲染占多少。**')
say()

// ── 环境局限：放在最前面，不放在脚注里 ────────────────────────────────
// 位置是刻意的。这些数字长得像"性能结论"，只要有人往下滑看到表格就会开始
// 引用，等他滑到页面底部才读到"绝对值不可外推"已经晚了。
say('> [!WARNING]')
say('> **绝对值不可外推到用户真机；比例可以。**')
say('> 这次测量跑在 GitHub Actions 的 `windows-latest` runner 上，它是一台：')
say('> - **Windows Server 数据中心版虚拟机**，不是桌面版 Windows；')
say('> - **共享 vCPU**，跟同一宿主上的其他任务抢核，调度抖动比真机大得多，p95/max 尤其容易被邻居拖高；')
say('> - **没有 GPU**（无显卡、无图形驱动），Chromium 只能走软件渲染，xterm 的 WebGL 渲染器多半起不来、退回 DOM 渲染器——而 DOM 渲染器和 WebGL 渲染器的重绘开销不是一个量级。')
say('>')
say('> 所以：**这里的毫秒数不是用户会体验到的毫秒数**。参考真机（i7-1260P）实测键盘往返是 10–41ms。')
say('> 能跨环境搬运的是**分段占比**——ConPTY 和我们自己代码的相对权重，决定了下一步该优化谁。')
say()

// ── 第 1 节：纯 Rust ConPTY ──────────────────────────────────────────
const conptyLog = readLogOrNull(conptyLogPath)
const conpty = conptyLog ? parseConptySamples(conptyLog) : { samples: [], runs: 0 }
const conptyStats = stats(conpty.samples)

say('### 1. ConPTY 自己（纯 Rust，`crates/ht-core/examples/pty_latency.rs`）')
say()
say('从 `SessionManager::write()` 调用开始，到读线程把回传字节交给 `data_out` 回调为止。覆盖：写 ConPTY 主端 → ConPTY 回显 → 读线程唤醒 → 读回。**不含** napi、不含 MessagePort、不含 xterm。')
say()
if (conptyStats) {
  say(`本节样本由 ${conpty.runs} 轮独立运行合池而成（单轮 n=60；合池是为了让 p95 不再只压着 3 个样本）。`)
  say()
  say('| 测点 | n | min | 中位数 | p95 | max |')
  say('| --- | ---: | ---: | ---: | ---: | ---: |')
  say(`| ConPTY 往返（t2→t3） | ${conptyStats.n} | ${fmt(conptyStats.min)} | **${fmt(conptyStats.median)}** | **${fmt(conptyStats.p95)}** | ${fmt(conptyStats.max)} |`)
  say()
  say('单位 ms。')
} else {
  say('> ⚠️ **未测到。** 没能从 `' + (conptyLogPath ?? '(未传日志路径)') + '` 里解析出任何 `PTY_LATENCY_JSON` 行——这一步要么没跑、要么跑挂了。请看上面 job 里对应 step 的日志。**本节没有数字，不是数字为零。**')
}
say()

// ── 第 2 节：完整链路分段 ────────────────────────────────────────────
const fullLog = readLogOrNull(fullLogPath)
const seg = fullLog ? parseSegments(fullLog) : {}
const hasAll = Boolean(seg.PTY && seg.NAPI && seg.FULL)

say('### 2. 完整链路分段（`pnpm measure:latency`）')
say()
say('三条口径完全一致的嵌套往返（都是"往 PTY 写一个可打印字符、等它被回显回来"），靠相减把中间几段挤出来。详见 `e2e/latency.ts` 顶部注释。')
say()
if (Object.keys(seg).length > 0) {
  say('| 段 | 覆盖范围 | n | min | 中位数 | p95 | max |')
  say('| --- | --- | ---: | ---: | ---: | ---: | ---: |')
  const rows = [
    ['PTY', '`PTY` t2→t3', 'ConPTY 自己'],
    ['NAPI', '`NAPI` ≈t1→t4', 'ConPTY + napi/线程安全函数 + Node 事件循环'],
    ['FULL', '`FULL` t0→t5', '整程：xterm onData → 两跳数据面 MessagePort → … → xterm 解析回显'],
  ]
  for (const [key, label, desc] of rows) {
    const s = seg[key]
    if (!s) {
      say(`| ${label} | ${desc} | — | — | — | — | — |`)
      continue
    }
    say(`| ${label} | ${desc} | ${s.n} | ${fmt(s.min)} | **${fmt(s.median)}** | **${fmt(s.p95)}** | ${fmt(s.max)} |`)
  }
  say()
  say('单位 ms。')
} else {
  say('> ⚠️ **未测到。** 没能从 `' + (fullLogPath ?? '(未传日志路径)') + '` 里解析出 `pnpm measure:latency` 的分段结果行。常见原因：Electron 在 runner 上没起来、或某一段测量超时。请看上面 job 里对应 step 的日志。**本节没有数字，不是数字为零。**')
}
say()

// ── 第 3 节：拆账 ────────────────────────────────────────────────────
say('### 3. 按中位数拆账：ConPTY 占多少，我们自己占多少')
say()
if (hasAll) {
  const p = seg.PTY.median
  const n = seg.NAPI.median
  const f = seg.FULL.median
  const napiCost = n - p
  const ourCost = f - n

  /**
   * 相减出来的段可能是负数。
   *
   * 这不是 bug，是它本来的含义：PTY 段和 NAPI 段是**两次独立测量**，各自带
   * 着 runner 的调度噪声；当中间那一层（napi + Node 事件循环）的真实开销比
   * 噪声还小时，两个中位数的差就可能翻到零以下。这时候唯一诚实的写法是承认
   * "测不出来、低于噪声底"，而不是打印一个 -0.01ms 让人以为这一层能倒赚时间，
   * 也不是钳到 0 假装刚好为零。
   */
  const cell = (v) => (v < 0 ? '低于噪声底（见下注）' : fmt(v))
  const cellPct = (v) => (v < 0 ? '—' : pct(v, f))

  say('| 组成 | 中位数 (ms) | 占整程 |')
  say('| --- | ---: | ---: |')
  say(`| ConPTY 自己 | ${fmt(p)} | **${pct(p, f)}** |`)
  say(`| napi / 线程安全函数 / Node 事件循环 | ${cell(napiCost)} | ${cellPct(napiCost)} |`)
  say(`| **我们的 Electron 链路 + xterm**（两跳 MessagePort + preload/渲染进程调度 + xterm 解析回显） | ${cell(ourCost)} | ${cellPct(ourCost)} |`)
  say(`| 整程合计 | ${fmt(f)} | 100% |`)
  say()
  if (napiCost < 0 || ourCost < 0) {
    say(`> **注**：出现负值的那一段，说明它的真实开销小于本次测量的噪声（PTY / NAPI / FULL 是三次独立测量，各自带调度抖动）。负值只能读作"这一层便宜到测不出来"，不能读作"它节省了时间"。`)
    say()
  }
  // 一句人话结论，省得读者自己拿计算器按。比值本身是可外推的那部分，值得直说。
  const ourTotal = f - p // 整程里不属于 ConPTY 的部分，这个差一定为正才有意义
  say(`**一句话**：ConPTY 占整程 ${pct(p, f)}，剩下的 ${pct(ourTotal, f)} 是 ConPTY 之外的开销（napi + 我们的 Electron 链路 + xterm）` +
    (p > 0 && ourTotal > 0 ? `——我们在 ConPTY 之上又叠了约 ${(ourTotal / p).toFixed(1)} 倍。` : '。'))
  say()
  say('优化的着力点由这个比例决定，而不是由上面那些绝对毫秒数决定。')

  // 同一个量、两次独立测量，差多少就是这台 runner 的噪声底有多高——这是判断
  // 上面那些小数位值不值得当真的直接依据，比任何一句"CI 上有噪声"的空话都实。
  if (conptyStats) {
    const gap = Math.abs(conptyStats.median - p)
    say()
    say(`> **噪声底自查**：ConPTY 往返被独立测了两次（第 1 节 ${fmt(conptyStats.median)} ms，第 2 节 ${fmt(p)} ms），同一个量差了 ${fmt(gap)} ms。比这个差值小的差异，在这台 runner 上都不该当成真实差异来解读。`)
  }
} else {
  say('> ⚠️ **拆不出来。** 拆账需要第 2 节的 PTY / NAPI / FULL 三段齐全，当前缺少其中至少一段。')
}
say()

// ── 第 4 节：这份测量的方法学边界 ────────────────────────────────────
say('### 4. 读之前要知道的几件事')
say()
say('- **t1/t2/t3/t4 四个点没有被直接测到**，是靠三条嵌套往返相减倒推的。往热路径插时间戳会改动生产代码的运行时行为，本轮不做。能给的是三段的分布，不是六个时刻的绝对值。')
say('- **回显来自 PTY 的行规程/ConPTY，不是 shell**，所以测量不掺 shell 的调度抖动，三条往返口径一致、相减才有意义。')
say('- **第 2 节每段 n=60**（`e2e/latency.ts` 的 `SAMPLES`），每段前先空跑 10 轮丢掉（JIT、xterm 首次解析等一次性开销）。n=60 时 p95 只由最靠上的 3 个样本决定，在共享 CPU 的 runner 上把它当量级看，别当精确值看。第 1 节已经用多轮合池把 n 抬高了。')
say('- **报的是中位数和 p95，没有报平均值**：这类时延分布右尾很长，平均值会被几个离群点带偏，说明不了典型体验。')

const text = out.join('\n') + '\n'
process.stdout.write(text)
