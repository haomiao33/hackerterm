/**
 * 冷启动时间线报告：拉起真实构建产物，把**已有的**启动埋点收上来排成表格，
 * 直接吐 Markdown 到 stdout，供 CI 写进 `$GITHUB_STEP_SUMMARY`。
 *
 * ── 为什么这份报告值得单独存在 ──────────────────────────────────────
 * 用户真机上这段曾经是 **81 秒**（`main:fork_call → main:core_spawn`），关掉杀毒
 * 之后掉到 **504ms**——两个数字差了 160 倍，而我们当时是靠人一次次下载安装包、
 * 手动开、盯着日志看才发现的，一轮一天。这件事必须有一个**能持续观测的自动化
 * 口径**，否则下次它悄悄涨回去（换个杀毒策略、换台机器、加个安全软件）没有
 * 任何人会知道，直到用户又来说"打不开"。
 *
 * ── 不新写埋点 ────────────────────────────────────────────────────
 * 时间点全部来自现成的两处：`src/main/startup-timing.ts`（主进程 + core-host，
 * 用 epoch 毫秒跨进程对齐）和 `src/ui/browser/diagnostics/log.ts`（页面自己的
 * `+Xms` 日志）。这个文件只是**读**它们经诊断通道汇进渲染进程 console 的那些行，
 * 一行埋点代码都不加。理由很直接：真机上用户能拿到的就是这些日志，报告如果基于
 * 另一套只在测试里存在的埋点，那它测的就不是用户真正遇到的东西。
 *
 * 用法：`pnpm measure:startup`（无头 Linux 上自动套 xvfb，见 scripts/headless.mjs）
 *       环境变量 `HT_STARTUP_RUNS` 控制跑几轮，默认 3。
 */
import { consoleLog, launchApp, MOUNT_TIMEOUT_MS } from './electron-app'

/** 默认轮数。单轮的绝对值噪声很大（尤其在有实时扫描的机器上），多跑几轮看分布。 */
const DEFAULT_RUNS = 3

/**
 * 报告里要呈现的**分段**。每段 = 终点时刻 - 起点时刻，单位毫秒。
 *
 * 选这几段的理由，全部来自真机那次 160 秒排查（见
 * docs/superpowers/verification/startup-latency-investigation.md）：
 * - fork → spawn：**最有价值的一段**。utility 进程从 fork 调用到真的起来，
 *   真机上曾是 81 秒。杀毒软件对新进程/新文件的实时扫描就压在这一段里。
 * - whenReady → fork：主进程自己准备好到开始拉核心，正常应当是零点几毫秒。
 * - fork → 控制端口请求：渲染进程脚本执行完、主动来要控制端口的时刻。
 * - 控制端口请求 → did_finish_load：这一段就是当初那 79.9 秒的白等
 *   （页面 load 事件比脚本执行完晚了近 80 秒）。现在控制端口不再挂在 load
 *   上，所以这段大不大都不再影响可用性——但它仍然是"这台机器在页面加载上
 *   花了多久"的直接读数，值得继续盯。
 */
const SEGMENTS: { name: string, from: string, to: string, why: string }[] = [
  {
    name: 'app ready → fork 核心',
    from: 'main:app_whenReady', to: 'main:fork_call',
    why: '主进程自己的准备时间，正常是亚毫秒级',
  },
  {
    name: 'fork 调用 → 核心进程真的起来',
    from: 'main:fork_call', to: 'main:core_spawn',
    why: '★ 真机上曾经 81 秒（杀毒实时扫描），关掉杀毒后 504ms',
  },
  {
    name: 'core-host 加载 ht-node 原生模块',
    from: 'core-host:ht_node_import_start', to: 'core-host:ht_node_import_end',
    why: '曾被当作头号怀疑对象，实测 11–18ms，埋点留着用来证明它不是瓶颈',
  },
  {
    name: 'fork 调用 → 渲染进程来要控制端口',
    from: 'main:fork_call', to: 'main:control_port_request',
    why: '渲染进程脚本执行完的时刻（比 load 事件早得多）',
  },
  {
    name: '控制端口请求 → 页面 load 事件',
    from: 'main:control_port_request', to: 'main:did_finish_load',
    why: '当初白等的 79.9 秒就在这一段；现在没有功能挂在 load 上了',
  },
  {
    name: 'GPU 信息可用（app ready → 首次 gpu-info-update）',
    from: 'main:app_whenReady', to: 'main:gpu_status_first_update',
    why: 'GPU 进程初始化耗时',
  },
]

interface RunResult {
  /** 埋点标签 → 相对页面 timeOrigin 的偏移毫秒（可能为负，见 startup-timing.ts）。 */
  timings: Record<string, number>
  /** 非时间戳的启动事实，目前只有 GPU 特性状态。 */
  notes: Record<string, string>
  /** 页面自己那几条关键日志的 `+Xms` 时刻。 */
  pageMarks: Record<string, number>
  /** 从调 launchApp 到终端挂载完成的墙上时间。 */
  wallClockMs: number
}

/**
 * 页面日志里要单独抓出来的几行。它们不是 startup-timing 的埋点，而是 boot.ts
 * 用 `log()` 打的普通行，但恰恰是"链路接通了没有"最直接的证据。
 */
const PAGE_MARKS: Record<string, string> = {
  'control port ready': '控制端口就绪（渲染进程收到端口）',
  'data port ready': '数据端口就绪',
  'requesting control port': '渲染进程开始要控制端口',
}

/**
 * `+123ms main:fork_call: +456ms (epoch 换算…)` / `+123ms main:gpu_feature_status: webgl=enabled …`
 *
 * 标签部分必须允许大写字母：`main:app_whenReady` 就带一个大写 R。第一版正则写成
 * `[a-z_]+` 漏掉了它，表现是两个分段恒为 "—"——这类"少一个字符、表格里就静静地
 * 空一格"正是本项目最典型的静默失效，所以这里把标签的字符集写全。
 */
const TIMING_LINE = /^\[log\] \+\d+ms ([a-zA-Z-]+:[a-zA-Z_]+): ([+-]?\d+)ms /
const NOTE_LINE = /^\[log\] \+\d+ms ([a-zA-Z-]+:[a-zA-Z_]+): (.+)$/
const PAGE_MARK_LINE = /^\[log\] \+(\d+)ms (.+)$/

async function runOnce(): Promise<RunResult> {
  const t0 = Date.now()
  const { app, page } = await launchApp()
  const wallClockMs = Date.now() - t0

  // GPU 状态要等 gpu-info-update 静默收敛才落笔（见 main/index.ts 的
  // GPU_STATUS_SETTLE_MS）。挂载完成时它多半还没出来，这里多等一会儿——
  // 报告缺了 GPU 那一行，就退回到当初"对 GPU 状态两眼一抹黑"的处境了。
  await new Promise((r) => setTimeout(r, 3_000))

  const lines = consoleLog(page)
  const timings: Record<string, number> = {}
  const notes: Record<string, string> = {}
  const pageMarks: Record<string, number> = {}

  for (const line of lines) {
    const t = TIMING_LINE.exec(line)
    if (t) { timings[t[1]] = Number(t[2]); continue }
    const n = NOTE_LINE.exec(line)
    if (n) { notes[n[1]] = n[2]; continue }
    const p = PAGE_MARK_LINE.exec(line)
    if (p && PAGE_MARKS[p[2]] !== undefined && pageMarks[p[2]] === undefined) {
      pageMarks[p[2]] = Number(p[1])
    }
  }

  await app.close()
  return { timings, notes, pageMarks, wallClockMs }
}

/** 中位数。轮数很少（默认 3），中位数比平均值抗单次抖动。 */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}

function fmt(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return '—'
  if (ms >= 10_000) return `**${(ms / 1000).toFixed(1)} s**` // 秒级 = 有问题，加粗
  if (ms >= 1_000) return `${(ms / 1000).toFixed(2)} s`
  return `${ms} ms`
}

async function main(): Promise<void> {
  const runs = Number(process.env.HT_STARTUP_RUNS ?? DEFAULT_RUNS)
  const results: RunResult[] = []
  const failures: string[] = []

  for (let i = 0; i < runs; i++) {
    try {
      results.push(await runOnce())
    } catch (err) {
      // 一轮挂了不代表整份报告没价值——把失败写进报告，其余轮次照常统计。
      // 这本身也是结论：这台机器上 Electron 有时候起不来。
      failures.push(`第 ${i + 1} 轮：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const out: string[] = []
  out.push('### 冷启动时间线（真实构建产物，复用现有埋点）')
  out.push('')
  out.push(`- 轮数：${runs}（成功 ${results.length}，失败 ${failures.length}）`)
  out.push(`- 平台：\`${process.platform}\` / \`${process.arch}\``)
  out.push('')

  if (failures.length > 0) {
    out.push('#### 启动失败的轮次')
    out.push('')
    for (const f of failures) out.push(`- ${f}`)
    out.push('')
  }

  if (results.length === 0) {
    out.push('> **Electron 在这台机器上一次都没能启动到终端挂载完成。**')
    out.push('> 这就是本次报告最重要的结论——不是测量失败，是应用起不来。')
    console.log(out.join('\n'))
    // 一轮都没成功时以非零退出：让调用方能自己决定要不要当故障处理。
    process.exitCode = 1
    return
  }

  out.push('#### 分段耗时（多轮取中位数）')
  out.push('')
  out.push('| 分段 | 中位数 | 各轮 | 为什么盯它 |')
  out.push('| --- | ---: | --- | --- |')
  for (const seg of SEGMENTS) {
    const perRun = results.map((r) => {
      const a = r.timings[seg.from]
      const b = r.timings[seg.to]
      return a === undefined || b === undefined ? NaN : b - a
    })
    const valid = perRun.filter((v) => !Number.isNaN(v))
    out.push(
      `| ${seg.name} | ${valid.length ? fmt(median(valid)) : '—'} | ` +
      `${perRun.map((v) => (Number.isNaN(v) ? '—' : `${v}ms`)).join(', ')} | ${seg.why} |`,
    )
  }
  out.push('')
  out.push(
    `**墙上时间**（launch → 终端挂载完成）中位数：${fmt(median(results.map((r) => r.wallClockMs)))}` +
    `，各轮 ${results.map((r) => `${r.wallClockMs}ms`).join(', ')}`,
  )
  out.push('')

  out.push('#### 关键节点是否到达')
  out.push('')
  out.push('| 节点 | 到达轮次 | 页面时刻（首轮） |')
  out.push('| --- | ---: | ---: |')
  for (const [mark, label] of Object.entries(PAGE_MARKS)) {
    const hit = results.filter((r) => r.pageMarks[mark] !== undefined).length
    const first = results[0]?.pageMarks[mark]
    out.push(`| ${label} \`${mark}\` | ${hit}/${results.length} | ${fmt(first)} |`)
  }
  out.push('')

  out.push('#### GPU 特性状态（`app.getGPUFeatureStatus()` 的真实结果）')
  out.push('')
  const gpu = results.map((r) => r.notes['main:gpu_feature_status']).filter(Boolean)
  if (gpu.length === 0) {
    out.push('> 未取到。主进程在 `gpu-info-update` 事件里读这个值（Electron 文档明确要求）；')
    out.push('> 一条都没有说明该事件在观测窗口内一次都没触发，GPU 状态未知——')
    out.push('> **注意这不等于"全部禁用"**。')
  } else {
    for (const [i, g] of gpu.entries()) out.push(`${i + 1}. \`${g}\``)
  }
  out.push('')

  console.log(out.join('\n'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
