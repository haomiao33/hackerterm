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

// ── 超时与有效性门槛 ────────────────────────────────────────────────────
//
// 【为什么这一节必须存在】Windows CI 上 `latency-windows` 这个 job 卡在 NAPI 段
// 整整 60 分钟，直到 job 级 `timeout-minutes: 60` 才被杀掉。Windows runner 是
// **双倍计费**，挂死一次就是一小时的钱，而且摘要页上什么都没有。
//
// 根因是"等回显"这件事在真 shell 冷启动下可能永远等不到，而**测量脚本里有一批
// await 根本没有上限**：`spawn(cargo …)` 只等 `close` 事件；Playwright 的
// `page.evaluate` / `keyboard.press` 默认**不带超时**（Playwright 的 30s 默认值
// 只作用于 locator 动作，不作用于 evaluate）；`app.close()` 同理。渲染进程一旦
// 卡住，这些 await 就是永久的。
//
// 规则从此是：**测量里的每一次等待都必须有上限**，超时就跳过该样本并计数；
// 拿不到足够样本就明确报"该段测量失败"，绝不打印一个基于极少样本的假数字。
//
// 【这套机制是实测过的，不是写完就算】变异验证：把下面 NAPI 段那行
// `session.write(byte)` 临时改成不写（人为制造"回显永远不来"），跑 `pnpm
// measure:latency`，实测输出：
//   · 往返超时丢失：40
//   · ⚠ 连续 40 轮没有任何回显（第 40/80 轮），判定回显通路已断，提前放弃本段
//   · ⚠ 该段测量失败——只拿到 0 个有效正式样本，低于门槛 30（应有 60）
//   ✗ …以上各段的数字**不予采信**       → 进程退出码 1
// 整段在约 85 秒内收摊，另外两段照常出数。这正是那次 60 分钟挂死应有的样子。

/**
 * 单段测量的硬上限，超过就放弃这一段（而不是拖死整个 job）。
 *
 * ── 取值是算出来的，不是拍的 ────────────────────────────────────────────
 * 一轮的自然时长 ≈ 往返（毫秒级）+ GAP_MS(120ms)，(WARMUP + SAMPLES) = 80 轮，
 * 所以**正常**一段是 10 秒上下，加 SETTLE_MS 一共十几秒。
 * **最坏**情况下每轮都撞 ROUNDTRIP_TIMEOUT_MS(2s)，但有 MAX_CONSECUTIVE_TIMEOUTS
 * 兜着，连续 40 轮没回显就收摊 ≈ 40 × 2.12s ≈ 85 秒。于是：
 * - NAPI：85s + 建链路（连核心 40s + 开会话 40s，各自单独超时）≈ 165s → 给 3 分钟。
 * - FULL：85s + Electron 冷启动（下面单独限 2 分钟）+ 关闭 ≈ 210s → 给 4 分钟。
 * - PTY：Rust 侧那个 example 自己会跑完（每轮 recv_timeout），最坏也是 ~170s；
 *   另外它可能要现编——CI 里前一步（Measure ConPTY roundtrip）已经把这个
 *   example 编过了，正常是零，4 分钟是留给"前一步失败、这里冷编"的情况。
 *
 * 三段合计 11 分钟（最坏），正常一共 1-2 分钟。这个数是 OVERALL_TIMEOUT_MS 和
 * workflow 里那一步 `timeout-minutes` 的定值依据——**四个数字必须保持
 * 段 < 总兜底 < 步骤 < job 这个大小关系**，改一个就要回来看其余三个。
 */
const PTY_SEGMENT_TIMEOUT_MS = 4 * 60_000
const NAPI_SEGMENT_TIMEOUT_MS = 3 * 60_000
const FULL_SEGMENT_TIMEOUT_MS = 4 * 60_000

/**
 * 单次 CDP 调用（`page.evaluate` / `keyboard.press`）的上限。
 *
 * 这些调用正常是毫秒级；给到 30 秒纯粹是为了容忍 Windows runner 的调度抖动。
 * 渲染进程真卡死时，它们会在这里被截断成一次"该轮丢失"，而不是永久挂起。
 */
const CDP_CALL_TIMEOUT_MS = 30_000

/**
 * 一段测量至少要有这么高比例的正式样本才算数。
 *
 * 低于门槛时输出的分布是**基于极少数样本的假精度**——n=3 的 p95 就是最大值本身，
 * 拿它做"IPC 还值不值得优化"的决策比没有数字更糟。所以宁可整段判失败。
 */
const MIN_VALID_SAMPLE_RATIO = 0.5

/**
 * 连续这么多轮一个回显都没等到，就判定这一段的回显通路是死的，立刻放弃整段。
 *
 * 阈值取 40（总轮数的一半）而不是更小：Windows 冷启动时 PowerShell + PSReadLine
 * 可能要几十秒才就绪，**头 20 个预热轮全部超时是正常的**（预热样本本来就是拿来
 * 丢的），阈值太小会把正常的冷启动误判成故障。40 轮 ≈ 80 秒一个字节都没回来，
 * 那才是真的断了。这一条纯粹是省钱：不加它也不会挂死（每轮各自有超时），
 * 但能把一段注定失败的测量从 170 秒截到 85 秒。
 */
const MAX_CONSECUTIVE_TIMEOUTS = 40

/**
 * 整个测量脚本的总上限。任何一段的兜底都失效时，由它保证进程一定会退出。
 * 必须大于三段之和（4 + 3 + 4 = 11 分钟），否则正常运行也会被它误杀。
 */
const OVERALL_TIMEOUT_MS = 12 * 60_000

/** 各段自报的失败原因。非空即表示这一段的数字不可用。 */
const segmentFailures: string[] = []

/**
 * 给一个 promise 套上超时。超时不取消底层操作（CDP 调用没法真正取消），
 * 但会让调用方立刻往下走，不再被永久挂住。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`「${what}」超过 ${ms}ms 没有返回——已按超时处理`)),
      ms,
    )
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e as Error) },
    )
  })
}

/**
 * 判定一段是否拿到了足够的有效样本，不够就登记成"该段测量失败"。
 *
 * 登记而不是抛异常：一段失败不该让另外两段的数字也拿不到——那些数字仍然是有用的，
 * 只要**明确标注**哪一段没测到。最后由 main() 统一以非零退出码收尾。
 */
function requireEnoughSamples(seg: Segment): void {
  const need = Math.ceil(SAMPLES * MIN_VALID_SAMPLE_RATIO)
  if (seg.measured.length >= need) return
  const reason =
    `${seg.label.trim()}：只拿到 ${seg.measured.length} 个有效正式样本，` +
    `低于门槛 ${need}（应有 ${SAMPLES}）。这一段的分布不可用，不予采信。`
  segmentFailures.push(reason)
  seg.notes.push(`⚠ 该段测量失败——${reason}`)
}

/** 把一段测量整个判失败（连样本都没跑出来时用）。 */
function failSegment(label: string, what: string, reason: string): Segment {
  segmentFailures.push(`${label.trim()}：${reason}`)
  return {
    label, what, warmup: [], measured: [],
    notes: [`⚠ 该段测量失败——${reason}`],
  }
}

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
    // 硬上限：`cargo run` 这一步以前**完全没有超时**——它既要编译又要跑一整段
    // 测量，任何一头卡住（编译等锁、example 等一个永远不来的回显）都会把整个
    // 脚本永久挂在这里。kill 之后 'close' 事件照常触发，走下面的非零退出分支。
    const killer = setTimeout(() => {
      child.kill('SIGKILL')
    }, PTY_SEGMENT_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(killer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`cargo run --example pty_latency 退出码 ${code}`))
    })
  })
  const line = out.split('\n').find((l) => l.startsWith('PTY_LATENCY_JSON '))
  if (!line) throw new Error(`没在 cargo 输出里找到 PTY_LATENCY_JSON 行：\n${out}`)
  const json = JSON.parse(line.slice('PTY_LATENCY_JSON '.length)) as PtyJson
  const seg: Segment = {
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
  // Rust 侧那个 example 每轮自带 recv_timeout，所以它不会挂死；但**超时的轮次
  // 没有样本**，从端一直不回显时它会安静地返回一个几乎空的样本集。样本门槛在这里
  // 兜住：宁可整段判失败，也不打印一个 n=3 的 p95。
  requireEnoughSamples(seg)
  return seg
}

// ── NAPI 段（普通 Node 进程）────────────────────────────────────────────
async function measureNapi(shell: string): Promise<Segment> {
  console.log('· NAPI 段（Node → napi → Rust → PTY → 回来）…')
  // 建链路这两步各自套超时：`connectCore()` 里的 hello、`openSession()` 里的
  // session.open 虽然各有 10s 的请求上限，但 napi 原生模块加载、Rust 侧起 PTY
  // 这些环节不在那个上限之内。上一轮 60 分钟挂死时，日志最后一行正是这一句
  // "· NAPI 段…"——挂在哪一步当时完全看不出来，现在超时信息会指名道姓。
  // 40 秒而不是 60：两步各 60 秒正好等于本段 3 分钟上限的三分之二，真卡住时会
  // 变成"段超时"这种笼统信息；给 40 秒则**内层先开火**，失败信息能指名道姓说清是
  // 连核心还是开会话卡住了。（40 秒本身也远超正常值——这两步正常都是百毫秒级。）
  const core = await withTimeout(connectCore(), 40_000, 'NAPI 段连接核心（connectCore）')
  const session = await withTimeout(
    core.openSession({ shell }), 40_000, 'NAPI 段打开会话（session.open）',
  )

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
  let consecutiveTimeouts = 0
  let aborted: string | null = null
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
    if (await done) {
      all.push(performance.now() - started)
      consecutiveTimeouts = 0
    } else {
      timeouts += 1
      consecutiveTimeouts += 1
      // 连续这么多轮一个字节都没回来：从端根本没在回显，剩下的轮次只会重复
      // 同一件事，白烧 runner 的钱。立刻收摊，由下面的样本门槛判这段失败。
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
        aborted = `连续 ${consecutiveTimeouts} 轮没有任何回显（第 ${i + 1}/${WARMUP + SAMPLES} 轮），`
          + '判定回显通路已断，提前放弃本段'
        break
      }
    }
    onEcho = null
    await gap()
  }
  // 关会话本身也可能挂住（核心不回应 session.close）。core-session.ts 的 request()
  // 自带 10s 上限，这里再兜一层，并且失败不影响已经拿到的样本。
  await withTimeout(session.close(), 30_000, 'NAPI 段关闭会话').catch((e: Error) => {
    console.log(`  ⚠ NAPI 段关闭会话失败：${e.message}`)
  })

  const seg: Segment = {
    label: 'NAPI  Node→napi→PTY→回来',
    what: `sendData() → startData() 回调；从端 = ${shell}，比 PTY 段多出 napi 进出 + Node 事件循环一跳`,
    warmup: all.slice(0, Math.min(WARMUP, all.length)),
    measured: all.slice(Math.min(WARMUP, all.length)),
    notes: [
      `一次按键回来多块数据的次数：${lateChunks}`,
      `往返超时丢失：${timeouts}`,
    ],
  }
  if (aborted) seg.notes.push(`⚠ ${aborted}`)
  requireEnoughSamples(seg)
  return seg
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
  const { app, page } = await withTimeout(
    launchApp({ env: { HT_LATENCY_TRACE: '1' } }),
    // launchApp 内部已有 MOUNT_TIMEOUT_MS（60s）等挂载完成，但 `electron.launch()`
    // 本身在 runner 上偶发卡住时不受那个上限管。外面再兜一层。
    // 2 分钟 = 内层 60s 的两倍，仍然远小于本段 4 分钟的上限，所以它会先开火。
    2 * 60_000, 'FULL 段启动 Electron',
  )
  try {
    await installLatencyProbeOn(page, { key: KEY, timeoutMs: ROUNDTRIP_TIMEOUT_MS })
    await settle()

    let unpairedRounds = 0
    let consecutiveTimeouts = 0
    let aborted: string | null = null
    for (let i = 0; i < WARMUP + SAMPLES; i++) {
      // arm 必须在按键之前单独走一次：这样"按键的 onData"不可能早于"这一轮开始"
      // 到达，配对没有竞态窗口。
      //
      // 三个 CDP 调用全部套超时：Playwright 的 `page.evaluate` / `keyboard.press`
      // **默认没有超时**（30s 那个默认值只作用于 locator 动作），渲染进程一旦卡住
      // 就是永久挂起——这正是把 job 拖到 60 分钟的那类等待。超时按"本轮丢失"处理。
      let ok: boolean
      try {
        await withTimeout(
          page.evaluate(() => { window.__htLatency!.arm() }),
          CDP_CALL_TIMEOUT_MS, `FULL 段第 ${i + 1} 轮 arm()`,
        )
        await withTimeout(
          page.keyboard.press(KEY),
          CDP_CALL_TIMEOUT_MS, `FULL 段第 ${i + 1} 轮按键`,
        )
        ok = await withTimeout(
          page.evaluate(() => window.__htLatency!.waitArmed()),
          // waitArmed 自己最多等 ROUNDTRIP_TIMEOUT_MS，外层只需再留一次 CDP 往返的余量。
          ROUNDTRIP_TIMEOUT_MS + CDP_CALL_TIMEOUT_MS, `FULL 段第 ${i + 1} 轮等待回显`,
        )
      } catch (e) {
        // CDP 层面就没回来：这一轮既没有样本也拿不到页面侧的计数，算作丢失。
        console.log(`  ⚠ ${(e as Error).message}`)
        ok = false
      }
      if (ok) {
        consecutiveTimeouts = 0
      } else {
        unpairedRounds += 1
        consecutiveTimeouts += 1
        if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          aborted = `连续 ${consecutiveTimeouts} 轮没有任何回显（第 ${i + 1}/${WARMUP + SAMPLES} 轮），`
            + '判定回显通路已断，提前放弃本段'
          break
        }
      }
      await gap()
    }

    const snap: LatencyProbeSnapshot = await withTimeout(
      page.evaluate(() => window.__htLatency!.snapshot()),
      CDP_CALL_TIMEOUT_MS, 'FULL 段读取埋点快照',
    )
    const screen = await withTimeout(readScreen(page), CDP_CALL_TIMEOUT_MS, 'FULL 段读取屏幕缓冲区')
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
        // 分类明细：Windows 上"自动回复"具体是哪几种（CPR？焦点上报？DA？）直接
        // 决定下次配对出问题时从哪儿查起。上一轮就是因为只有裸字节、没有分类，
        // 才得靠人肉把 `1b 5b 49` 认成焦点上报。
        `自动回复分类：${JSON.stringify(snap.nonKeyKinds)}`
        + (snap.taintedRounds > 0
          ? `；⚠ 其中 ${snap.taintedRounds} 轮在拿到按键 t0 之后又收到自动回复，`
            + '这些轮的 t5 有可能落在自动回复的回显上，属可疑样本'
          : ''),
      ],
    }
    if (unpairedRounds !== snap.unpaired) {
      full.notes.push(`⚠ 轮次统计对不上：脚本侧 ${unpairedRounds}，页面侧 ${snap.unpaired}`)
    }
    if (aborted) full.notes.push(`⚠ ${aborted}`)
    requireEnoughSamples(full)

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
    // 关 Electron 也可能挂住（渲染进程没响应时 `app.close()` 会一直等）。
    // 关不掉不该拖死整个脚本——main() 末尾本来就 `process.exit(0)`，
    // 残留进程会随之收走。
    await withTimeout(app.close(), 30_000, 'FULL 段关闭 Electron').catch((e: Error) => {
      console.log(`  ⚠ ${e.message}`)
    })
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
  //
  // 每段都套一个硬上限、并且**各自捕获异常**：一段挂了不该让另外两段的数字也
  // 拿不到——那些数字仍然有用，只要如实标注哪一段没测到。上一轮 60 分钟挂死时
  // 三段一个数字都没留下，正是因为没有这层隔离。
  const pty = await withTimeout(measurePty(shell), PTY_SEGMENT_TIMEOUT_MS, 'PTY 段')
    .catch((e: Error) => failSegment(
      'PTY   Rust write→读回', '（本段未测到）', `整段失败：${e.message}`,
    ))
  const napi = await withTimeout(measureNapi(shell), NAPI_SEGMENT_TIMEOUT_MS, 'NAPI 段')
    .catch((e: Error) => failSegment(
      'NAPI  Node→napi→PTY→回来', '（本段未测到）', `整段失败：${e.message}`,
    ))
  const { full, inner, outside, innerUnmatched } =
    await withTimeout(measureFull(), FULL_SEGMENT_TIMEOUT_MS, 'FULL 段')
      .catch((e: Error) => ({
        full: failSegment('FULL  xterm 整程 t0→t5', '（本段未测到）', `整段失败：${e.message}`),
        inner: null, outside: null, innerUnmatched: 0,
      }))

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

  // ── 有效性结论 ────────────────────────────────────────────────────────
  // 放在最后、且决定退出码：把"这份测量到底能不能用"说成一句人话，而不是让读的人
  // 自己去数每段的 n。上一轮的教训是反过来的——job 挂死一小时，摘要页一片空白，
  // 谁也不知道是没测到还是测量本身坏了。
  console.log('\n── 本次测量的有效性 ─────────────────────────────────────────')
  if (segmentFailures.length === 0) {
    console.log(`  ✓ 三段都拿到了足够的有效样本（门槛：正式样本 ≥ `
      + `${Math.ceil(SAMPLES * MIN_VALID_SAMPLE_RATIO)}/${SAMPLES}）。`)
  } else {
    for (const f of segmentFailures) console.log(`  ✗ ${f}`)
    console.log('\n  以上各段的数字**不予采信**，不要写进报告、不要拿来做决策。')
    console.log('  最常见的原因是从端 shell 在采样窗口内始终没有就绪（Windows 冷启动 +')
    console.log('  Defender 实时扫描时尤其容易发生），此时脚本以非零退出码收尾。')
  }
}

/**
 * 总兜底：任何一层超时都失效时，由它保证进程一定会退出。
 *
 * `unref()` 之后这个定时器不会阻止进程自然结束，只在真的挂到这个点时才开火。
 */
const overallWatchdog = setTimeout(() => {
  console.error(`\n✗ 整个测量超过 ${OVERALL_TIMEOUT_MS / 60_000} 分钟仍未结束，强制退出。`)
  console.error('  这说明有一处等待没有被上面任何一层超时接住，属于脚本的缺陷，请修。')
  process.exit(1)
}, OVERALL_TIMEOUT_MS)
overallWatchdog.unref()

main().then(
  () => {
    // 显式退出：ht-node 里的 Core 是 Rust 侧的 OnceLock 全局，配套的读线程/线程
    // 安全函数没有拆卸接口，进程的事件循环不会自然清空。测量脚本已经把该打印的
    // 都打印完了，直接退出即可，不需要为此给生产代码加一个只有测量用得到的
    // "关掉核心" API。
    //
    // 退出码带上有效性结论：有任何一段没测到就非零退出。CI 里这一步挂着
    // continue-on-error（见 .github/workflows/build.yml 的 latency-windows），
    // 所以非零不会拦住任何人，但**步骤会显示成红色**，摘要页也会写明哪段没测到——
    // 而不是绿油油地贴一张基于三个样本的表。
    process.exit(segmentFailures.length > 0 ? 1 : 0)
  },
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
