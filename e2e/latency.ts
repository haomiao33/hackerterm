/**
 * 时延分段测量：回答「敲一个键到屏幕上出现回显，各段各占多少」。
 *
 * 跑法（Linux 无头会自动套 xvfb，见 main() 末尾的说明）：
 *   pnpm build:native && pnpm build
 *   pnpm measure:latency
 *
 * ── 这一版改了什么，为什么 ──────────────────────────────────────────────
 *
 * 上一版有两个独立的、都会产出**不可信数字**的问题，而且都不报错：
 *
 * 1. **三段口径不一致，导致父集的尾巴比子集还小。** 同一份代码两次 Windows CI：
 *
 *      PTY  中位数=0.39 p95=7.41 max=18.50
 *      NAPI 中位数=0.60 p95=0.70 max=0.83
 *      FULL 中位数=1.20 p95=3.00 max=3.10
 *
 *    三段本该嵌套包含（PTY ⊂ NAPI ⊂ FULL），子集的 p95/max 却大一个数量级——
 *    物理上不可能。查下来是两件事叠在一起：
 *
 *    a) **采样节奏各写各的**：PTY 段晾 800ms、每轮间隔 20ms，整个采样窗口
 *       （60×20ms≈1.2 秒）全部落在 PowerShell 冷启动那几秒里；NAPI/FULL 晾
 *       1000ms 再加 10 轮预热（≈2.2 秒）才开始记账，量的是热态。一个量冷的一个
 *       量热的。现在三段的节奏由 latency-protocol.ts 统一给出（Rust 侧通过环境
 *       变量接同一套值），预热样本照测、单独打印、统一丢弃。
 *
 *    b) **FULL 段的配对是错的**：旧实现拿"任意一次 term.onData"当 t0，而 xterm
 *       的自动回复（CPR/DA，PSReadLine 每次重绘都会查询光标位置）走的也是
 *       onData。于是"xterm 自动回复 → 下一块重绘数据"这种天然极短的区间被当成
 *       了按键往返。Windows CI 上 60 次按键量出 **61** 个样本，多出来那个就是
 *       证据。修法见 latency-probe.ts。
 *
 *    c) 还有一条口径问题是平台性的、修不掉、只能如实说明：**Linux 上 Electron
 *       进程里的 PTY 子进程根本 exec 不起来**（Chromium 的 fd 归属检查，见
 *       electron-app.ts），FULL 段的回显来自内核行规程；而 PTY/NAPI 两段跑在
 *       普通进程里，回显来自真 shell。这时三段不构成嵌套关系，输出里会打一条
 *       醒目的警告。
 *
 * 2. **拆账方法本身不成立。** 旧版拿三段各自独立测的中位数相减。噪声和差值同
 *    量级，同一份代码两次运行里 napi 那一项差了三倍（17.8% vs 5.9%）。**这一版
 *    不再输出任何跨段相减的拆账**，三段只并列打印分布。
 *
 *    唯一保留的减法是**同一次往返内**的：core-host 里有一个默认关闭的埋点
 *    （src/core-host/latency-trace.ts，HT_LATENCY_TRACE=1 才启用），量的是
 *    「core-host 收到按键字节 → core-host 把回显字节发回渲染进程」。它严格嵌套
 *    在 FULL 之内，且两段是同一次往返里各自进程内的时间差，逐轮相减得到的是
 *    "两跳 MessagePort + 渲染调度 + xterm 解析"的**分布**，不是两个中位数的差。
 */
import { spawn } from 'node:child_process'
import { consoleLog, launchApp, readScreen, ptyChildFailedToExec, REPO_ROOT } from './electron-app'
import { connectCore } from './core-session'
import { installLatencyProbeOn, type LatencyProbeSnapshot } from './latency-probe'
import {
  GAP_MS, KEY, ROUNDTRIP_TIMEOUT_MS, SAMPLES, SETTLE_MS, WARMUP,
  gap, measurementShell, ms, printSegment, stats, type Segment,
} from './latency-protocol'

/** core-host 埋点上报行的前缀，跟 src/core-host/latency-trace.ts 里的常量一致。 */
const INNER_PREFIX = 'HT_INNER_LATENCY '

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, SETTLE_MS))

// ── PTY 段（纯 Rust）────────────────────────────────────────────────────
interface PtyJson {
  shell: string
  warmup_ms: number[]
  samples_ms: number[]
  late_chunks: number
  timeouts: number
}

async function measurePty(shell: string): Promise<Segment> {
  console.log('· PTY 段（纯 Rust）：cargo run --example pty_latency …')
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      'cargo',
      ['run', '-p', 'ht-core', '--release', '--example', 'pty_latency'],
      {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'inherit'],
        // 采样节奏由 TS 侧统一下发，Rust 侧只有默认值兜底。三段口径一致是这一轮
        // 修复的核心，不能靠"两边各自写了同一个数字"来保证。
        env: {
          ...process.env,
          HT_LATENCY_SAMPLES: String(SAMPLES),
          HT_LATENCY_WARMUP: String(WARMUP),
          HT_LATENCY_GAP_MS: String(GAP_MS),
          HT_LATENCY_SETTLE_MS: String(SETTLE_MS),
          HT_LATENCY_SHELL: shell,
        },
      },
    )
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { stdout += c })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`cargo run --example pty_latency 退出码 ${code}`))
    })
  })
  const line = out.split('\n').find((l) => l.startsWith('PTY_LATENCY_JSON '))
  if (!line) throw new Error(`没在 cargo 输出里找到 PTY_LATENCY_JSON 行：\n${out}`)
  const json = JSON.parse(line.slice('PTY_LATENCY_JSON '.length)) as PtyJson
  return {
    label: 'PTY   Rust write→读回',
    what: `SessionManager::write() → data_out 回调；从端 = ${json.shell || '(默认 shell)'}，`
      + '回显由从端程序或内核行规程给出，含它每次按键的全部工作',
    warmup: json.warmup_ms,
    measured: json.samples_ms,
    notes: [
      `一次按键回来多块数据的次数（下一轮开始前排空到的）：${json.late_chunks}`,
      `往返超时丢失：${json.timeouts}`,
    ],
  }
}

// ── NAPI 段（普通 Node 进程）────────────────────────────────────────────
async function measureNapi(shell: string): Promise<Segment> {
  console.log('· NAPI 段（Node → napi → Rust → PTY → 回来）…')
  const core = await connectCore()
  const session = await core.openSession({ shell })

  let armed = false
  let onEcho: (() => void) | null = null
  let lateChunks = 0
  session.onData(() => {
    if (!armed) { lateChunks += 1; return }
    armed = false
    onEcho?.()
  })

  // 会话刚开，shell 的横幅还在路上，先晾一会儿。
  await settle()

  const all: number[] = []
  let timeouts = 0
  const byte = new TextEncoder().encode(KEY)
  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    const started = performance.now()
    const done = new Promise<boolean>((res) => {
      armed = true
      onEcho = () => res(true)
      // 等不到就明确记成丢失，绝不让它顺延到下一轮去——那会让下一轮量出一个
      // 假的短往返（旧 FULL 段就是这么错的）。
      setTimeout(() => { if (armed) { armed = false; res(false) } }, ROUNDTRIP_TIMEOUT_MS)
    })
    session.write(byte)
    if (await done) all.push(performance.now() - started)
    else timeouts += 1
    onEcho = null
    await gap()
  }
  await session.close()

  return {
    label: 'NAPI  Node→napi→PTY→回来',
    what: `sendData() → startData() 回调；从端 = ${shell}，比 PTY 段多出 napi 进出 + Node 事件循环一跳`,
    warmup: all.slice(0, Math.min(WARMUP, all.length)),
    measured: all.slice(Math.min(WARMUP, all.length)),
    notes: [
      `一次按键回来多块数据的次数：${lateChunks}`,
      `往返超时丢失：${timeouts}`,
    ],
  }
}

// ── FULL 段（真 Electron）+ 同一次往返内的 core-host 分段 ────────────────
interface InnerLine {
  /** 这行到达渲染进程的时刻（渲染进程 performance.now，boot.ts 的 `+NNNms` 前缀）。 */
  arrivedAt: number
  ms: number
}

/**
 * 从页面 console 里把 core-host 的埋点行捞出来。
 *
 * 行的样子：`[log] +1234ms HT_INNER_LATENCY {"seq":1,"ms":0.42,…}`。前面那个
 * `+1234ms` 是 boot.ts 的诊断日志前缀，取的是**渲染进程的 performance.now**——
 * 跟 FULL 段样本同一个时钟，正是靠它把内层样本归到轮次上。
 */
function parseInnerLines(lines: string[]): InnerLine[] {
  const pattern = new RegExp(`\\+(\\d+)ms .*?${INNER_PREFIX.trim()} (\\{.*\\})\\s*$`)
  const out: InnerLine[] = []
  for (const line of lines) {
    const m = pattern.exec(line)
    if (!m) continue
    const payload = JSON.parse(m[2]) as { ms: number }
    out.push({ arrivedAt: Number(m[1]), ms: payload.ms })
  }
  return out
}

interface FullResult {
  full: Segment
  /** 同一次往返内 core-host 那一段（含预热轮，按轮次对齐后再切）。 */
  inner: Segment | null
  /** 逐轮相减：整程 − core-host 段 = 两跳 MessagePort + 渲染调度 + xterm。 */
  outside: Segment | null
  /** 归不到轮次上的内层样本数（既是诊断，也是"能不能相减"的判据）。 */
  innerUnmatched: number
}

async function measureFull(): Promise<FullResult> {
  console.log('· FULL 段（真 Electron，渲染进程整程往返 t0 → t5）…')
  // HT_LATENCY_TRACE=1 只对这次测量启动的这个 Electron 生效；生产默认关闭，
  // 关闭时 core-host 数据面注册的是不含埋点的原版处理函数（零开销）。
  const { app, page } = await launchApp({ env: { HT_LATENCY_TRACE: '1' } })
  try {
    await installLatencyProbeOn(page, { key: KEY, timeoutMs: ROUNDTRIP_TIMEOUT_MS })
    await settle()

    let unpairedRounds = 0
    for (let i = 0; i < WARMUP + SAMPLES; i++) {
      // arm 必须在按键之前单独走一次：这样"按键的 onData"不可能早于"这一轮开始"
      // 到达，配对没有竞态窗口。
      await page.evaluate(() => { window.__htLatency!.arm() })
      await page.keyboard.press(KEY)
      if (!await page.evaluate(() => window.__htLatency!.waitArmed())) unpairedRounds += 1
      await gap()
    }

    const snap: LatencyProbeSnapshot = await page.evaluate(() => window.__htLatency!.snapshot())
    const screen = await readScreen(page)
    const noShell = ptyChildFailedToExec(screen)

    const rounds = snap.samples
    const full: Segment = {
      label: 'FULL  xterm 整程 t0→t5',
      what: 'xterm onData（按键）→ xterm write 回调（解析完成）；'
        + (noShell
          ? '⚠ 本机 PTY 子进程没能 exec，回显来自内核行规程，**没有 shell**'
          : '回显来自 shell'),
      warmup: rounds.slice(0, Math.min(WARMUP, rounds.length)).map((r) => r.ms),
      measured: rounds.slice(Math.min(WARMUP, rounds.length)).map((r) => r.ms),
      notes: [
        `xterm 自动回复（CPR/DA 等，不是按键）触发的 onData：${snap.nonKeyOnData} 次——`
        + '旧实现把这些也当 t0，凭空多出样本',
        `按键 onData：${snap.keyDataEvents} 次；没等到回显的轮次：${snap.unpaired} 次`,
        `不属于任何一次按键的 term.write：${snap.writesOutsideRound} 次（横幅 + 多块回显的第 2..n 块）`,
      ],
    }
    if (unpairedRounds !== snap.unpaired) {
      full.notes.push(`⚠ 轮次统计对不上：脚本侧 ${unpairedRounds}，页面侧 ${snap.unpaired}`)
    }

    // 按轮次窗口 [t0_i, t0_{i+1}) 把内层样本归位。不假设一一对齐：xterm 的自动
    // 回复也会往数据面写字节，内层样本天然可能比按键多。
    const innerLines = parseInnerLines(consoleLog(page))
    const innerPerRound: (number | null)[] = []
    let matched = 0
    for (let i = 0; i < rounds.length; i++) {
      const from = rounds[i].t0
      const to = i + 1 < rounds.length ? rounds[i + 1].t0 : Number.POSITIVE_INFINITY
      // 上界放宽一点点：内层样本是经 parentPort → 主进程 → 渲染进程转发过来的，
      // 到达时刻必然晚于回显本身，但一定落在本轮结束（下一轮 t0）之前——两轮之间
      // 隔着 GAP_MS。
      const hits = innerLines.filter((l) => l.arrivedAt >= Math.floor(from) && l.arrivedAt < to)
      innerPerRound.push(hits.length === 1 ? hits[0].ms : null)
      if (hits.length === 1) matched += 1
    }
    const innerUnmatched = innerLines.length - matched

    let inner: Segment | null = null
    let outside: Segment | null = null
    if (matched > 0) {
      const cut = Math.min(WARMUP, rounds.length)
      const pick = (from: number, to: number): number[] =>
        innerPerRound.slice(from, to).filter((v): v is number => v !== null)
      inner = {
        label: '  ├ core-host 入→出',
        what: 'core-host 收到按键字节 → core-host 把回显字节发回渲染进程'
          + '（= napi 进出 + Rust + PTY + 从端程序），与上面 FULL 段是**同一次往返**',
        warmup: pick(0, cut),
        measured: pick(cut, rounds.length),
        notes: [`归不到轮次上的内层样本：${innerUnmatched} 个`],
      }
      const diff = (from: number, to: number): number[] => {
        const out: number[] = []
        for (let i = from; i < to; i++) {
          const v = innerPerRound[i]
          if (v !== null) out.push(rounds[i].ms - v)
        }
        return out
      }
      outside = {
        label: '  └ 其余（我们的链路）',
        what: '整程 − core-host 段，**逐轮相减**：两跳数据面 MessagePort + 渲染进程调度 + xterm 解析',
        warmup: diff(0, cut),
        measured: diff(cut, rounds.length),
        notes: ['两段来自同一次往返，各自在自己进程内取时间差，不涉及跨进程时钟对齐'],
      }
    }

    return { full, inner, outside, innerUnmatched }
  } finally {
    await app.close()
  }
}

/**
 * 嵌套自洽性自检：把"这份数字自己有没有自相矛盾"直接打在输出里，不留给读的人
 * 自己去比。
 *
 * 上一版正是栽在没有这一步：PTY 的 p95 是 7.41ms 而它的父集 FULL 只有 3.00ms，
 * 白纸黑字摆在同一屏上两次 CI 都没人发现。凡是能机器判的矛盾，就不该靠人眼。
 */
function printNestingSelfCheck(
  pty: Segment, napi: Segment, full: Segment, outside: Segment | null,
): void {
  console.log('\n── 嵌套自洽性自检 ───────────────────────────────────────────')

  if (outside) {
    const worst = stats(outside.measured).min
    console.log(
      worst > 0
        ? `  ✓ 同一次往返内：整程 − core-host 段，逐轮最小值 +${ms(worst).trim()}ms > 0，`
          + `${outside.measured.length}/${outside.measured.length} 轮全部满足包含关系`
        : `  ⚠ 同一次往返内出现了 ${ms(worst).trim()}ms 的负差值——子集比父集还大，`
          + '说明配对或取时刻的位置有问题，这份数字不能用',
    )
  }

  // 独立测量的三段：能不能排出先后，取决于差值有没有大过噪声。差不出来就明说
  // 差不出来，而不是硬按理论顺序解读。
  const s = [stats(pty.measured), stats(napi.measured), stats(full.measured)]
  const names = ['PTY', 'NAPI', 'FULL']
  console.log(`  独立测量三段：中位数 ${s.map((x) => ms(x.median).trim()).join(' / ')}`
    + `，p95 ${s.map((x) => ms(x.p95).trim()).join(' / ')}（${names.join(' / ')}）`)
  for (let i = 0; i + 1 < s.length; i++) {
    for (const [what, a, b] of [
      ['中位数', s[i].median, s[i + 1].median],
      ['p95', s[i].p95, s[i + 1].p95],
    ] as const) {
      if (b >= a) continue
      console.log(
        `  ⚠ ${names[i + 1]} 的${what}（${ms(b).trim()}ms）比子集 ${names[i]}（${ms(a).trim()}ms）还小 `
        + `${ms(a - b).trim()}ms。三段跑在三个进程、三个时刻，差值小于本机测量噪声时就是排不出`
        + '先后——这不是 bug，是分辨率不够，别硬按理论顺序解读。能相减的只有上面同一次往返那条。',
      )
    }
  }
}

async function main(): Promise<void> {
  const shell = measurementShell()
  console.log('HackerTerm 键盘 → PTY → 屏幕 时延分段测量')
  console.log(`平台 ${process.platform}，从端程序 ${shell}`)
  console.log(`每段：晾 ${SETTLE_MS}ms → 丢弃 ${WARMUP} 个预热样本 → 正式 ${SAMPLES} 次，轮间隔 ${GAP_MS}ms\n`)

  // 依次跑，不并行：三段互相抢 CPU 会把测量本身搅浑。
  const pty = await measurePty(shell)
  const napi = await measureNapi(shell)
  const { full, inner, outside, innerUnmatched } = await measureFull()

  console.log('\n── 三段并列（互不相减，理由见下）─────────────────────────────')
  for (const seg of [pty, napi, full]) printSegment(seg)

  console.log('\n── 同一次往返之内的分段（只有这里的减法是成立的）─────────────')
  if (inner && outside) {
    printSegment(inner)
    printSegment(outside)
    const f = stats(full.measured).median, i = stats(inner.measured).median
    console.log(
      `\n  整程中位数 ${ms(f).trim()}ms 里，core-host 入→出 ${ms(i).trim()}ms，`
      + `其余（我们的 IPC + xterm）逐轮差值中位数 ${ms(stats(outside.measured).median).trim()}ms。`,
    )
  } else {
    console.log(`  没拿到 core-host 的埋点样本（归不到轮次的 ${innerUnmatched} 个）。`)
    console.log('  检查：core-host 是否带着 HT_LATENCY_TRACE=1 启动、诊断通道是否通到页面 console。')
  }

  printNestingSelfCheck(pty, napi, full, outside)

  console.log('\n── 为什么不给「PTY / napi / 我们的链路」那种百分比拆账 ────────')
  console.log('  那种拆账是拿三段**各自独立测量**的中位数相减。三段跑在三个进程、三个时刻，')
  console.log('  噪声与差值同量级：同一份代码两次 CI 运行里 napi 那一项能差三倍（17.8% vs 5.9%），')
  console.log('  而两次的真实代码完全一样。宁可少给一个数，也不给一个会误导决策的数。')
  console.log('  要拆账就看上面「同一次往返之内」那两行——那两段量的是同一次按键。')

  if (full.what.includes('没有 shell')) {
    console.log('\n⚠ 本机三段口径不一致，不构成嵌套关系，横向比较无效：')
    console.log('  FULL 段跑在 Electron 里，PTY 子进程被 Chromium 的 fd 归属检查打死（见 electron-app.ts），')
    console.log('  回显来自内核行规程；PTY/NAPI 两段跑在普通进程里，回显来自真 shell，含 shell 每次按键的全部工作。')
    console.log('  想在本机看 shell 到底占多少，跑 `pnpm measure:shell-cost`。')
  }
}

main().then(
  () => {
    // 显式退出：ht-node 里的 Core 是 Rust 侧的 OnceLock 全局，配套的读线程/线程
    // 安全函数没有拆卸接口，进程的事件循环不会自然清空。测量脚本已经把该打印的
    // 都打印完了，直接退出即可，不需要为此给生产代码加一个只有测量用得到的
    // "关掉核心" API。
    process.exit(0)
  },
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
