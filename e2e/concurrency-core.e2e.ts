/**
 * 并发会话（产品第②条核心要求里的「10+ 并发会话」）。
 *
 * ── 这条测试要回答的问题，按重要性排 ────────────────────────────────────
 *
 * 1. **串扰**：会话 A 的数据会不会跑到会话 B 里去。数据面是按 sessionId 路由的
 *    （Rust 读线程 `data_out(read_id, …)` → napi `start_data` 回调带 sid →
 *    core-session.ts / core-host 按 sid 分流），这条链路上任何一环把 id 丢了、
 *    或者退化成广播，症状都是**灾难性且静默**的：用户的两个终端互相串字，
 *    密码、密钥、半条命令混着显示，而程序不会报任何错。所以这是本文件里
 *    分量最重的一条，也是变异测试专门盯的那条。
 * 2. **10+ 条会话同时刷屏都能跑完**：每条会话一个读线程、一份流控窗口，
 *    并发时它们互相之间不该有干扰（一条会话被高水位按住，不能连累别人）。
 * 3. **读线程数与会话数一致，关完归零**：`core.stats` 这个诊断接口刚加上，
 *    这里是它第一次派上真实用场。读线程静默退出是"数据怎么不来了"最可能的
 *    解释，而从外部只能看到"没数据"，看不出线程死没死。
 * 4. **内存不随会话数爆炸**：流控是**每会话一份**的，10+ 条会话同时全速刷屏时
 *    在途字节的上界应当是 会话数 × 高水位，而不是无限涨。
 *
 * ── 为什么跑在普通 Node 进程里（core-session.ts）而不是 Electron 里 ──────
 * 同 flood-core.e2e.ts：Linux 上 Electron 进程内 fork 不出 PTY 子进程
 * （Chromium 的 fd 归属检查，见 electron-app.ts 的 FD_OWNERSHIP_CRASH_MARKER），
 * 没有 shell 就没有东西刷屏，串扰也就无从谈起——每条会话都只会回显自己写进去的
 * 字节，测不出路由错没错。普通 Node 进程里 shell 正常起来，每条会话跑自己的
 * 无限循环，各自吐各自的标记串，这才是能验证路由的形态。
 *
 * ── 这条测试在 Linux 和 Windows 上都跑 ──────────────────────────────────
 * 路由逻辑本身平台无关，但**并发下的真 shell 行为**不是：Windows 上 12 条
 * PowerShell 各自带 PSReadLine，冷启动更慢、每条会话的输出块大小和节奏都和
 * bash 不一样。刷屏命令按平台各选了一条不依赖外部程序的（见 floodCommand）。
 */
import { afterAll, beforeAll, expect, test } from 'vitest'
import { connectCore, type CoreConnection, type CoreSession } from './core-session'
import { FLOW_ACK_BATCH_BYTES, FLOW_HIGH_WATER_BYTES } from './rust-limits'

/**
 * 并发会话数。产品要求写的是「10+」，取 12 是为了确确实实**超过**那条线，
 * 而不是刚好压在边界上。
 */
const SESSION_COUNT = 12

/**
 * 每条会话在刷屏期间至少要收到多少字节，低于此数说明它根本没跑起来。
 *
 * 注意判据是「等到每条都达标」而不是「刷 N 秒之后看够不够」——见 FLOOD_DEADLINE_MS。
 */
const MIN_BYTES_PER_SESSION = 256 * 1024

/**
 * 等「12 条会话**全部**达到 MIN_BYTES_PER_SESSION」的上限。
 *
 * 为什么是"等到达标"而不是"睡 4 秒再看"：固定睡眠隐含假设了**从端立刻开始刷屏**。
 * Linux 上 `yes` 确实是立刻；Windows 上是 12 个 conhost + 12 个 PowerShell 同时冷
 * 启动，命令字节先在 PTY 里排队，PSReadLine 就绪之后才真正开始跑——这一类假设
 * 正是本轮 e2e/latency-pairing.e2e.ts 在 Windows 上红掉的根源。
 * 改成"等判据满足"之后，机器快就早点往下走，机器慢就多等一会儿，两边都不用调参；
 * 真的等不到才失败，而且失败信息会打印每条会话各收了多少，一眼能看出是**一条**
 * 会话被拖死了（并发问题）还是**全部**都没起来（环境问题）。
 */
const FLOOD_DEADLINE_MS = 90_000

/**
 * 等**单条**会话的"回显通路活了"的上限。
 *
 * 12 条 PowerShell 一起冷启动时，最后一条就绪可能要几十秒。这个数字只是上限，
 * 一活就立刻往下走。
 */
const ECHO_READY_TIMEOUT_MS = 90_000

/**
 * 本次运行的随机后缀。
 *
 * 存在的理由：标记串必须在**同一次运行内**互不为子串，也不能和 shell 自己的
 * 输出（提示符、报错信息）撞上。加一段随机后缀之后，"在别人的流里发现了我的
 * 标记"就只可能是路由串了，不可能是巧合。
 */
const RUN_TAG = Math.random().toString(36).slice(2, 10)

/**
 * 第 i 条会话的专属标记串。
 *
 * 序号**补零到两位**：不补零的话 `ht-xtalk-1-` 会是 `ht-xtalk-11-` 的前缀，
 * 子串匹配立刻误报。补零 + 前后都有分隔符之后，任意两个标记互不为子串。
 */
function markerFor(index: number): string {
  return `ht-xtalk-${String(index).padStart(2, '0')}-${RUN_TAG}-end`
}

/**
 * 让从端无限吐自己标记串的命令。两个平台各选一条**不依赖任何外部程序**的：
 * - 类 Unix：`yes` 是 coreutils，任何发行版都有。
 * - Windows：PowerShell 的 `while($true){...}`，Windows 上没有 `yes`。
 * 与 flood-core.e2e.ts 用同一套写法，理由见那边的注释。
 */
function floodCommand(marker: string): string {
  return process.platform === 'win32'
    ? `while($true){"${marker}"}\r`
    : `yes ${marker}\r`
}

interface Tracked {
  index: number
  marker: string
  session: CoreSession
  /** 累计收到的字节数。 */
  bytes: number
  /** 在**本会话**的数据流里发现的、**属于别人**的标记：串扰的铁证。 */
  foreign: { marker: string, atByte: number }[]
  /**
   * 本会话的数据流里出现过自己标记的**数据块数**。
   *
   * 用计数而不是布尔量，是因为它要同时承担两件事：就绪阶段判"回显通路活了"
   * （从 0 变成 ≥1），刷屏阶段判"真的在吐自己的东西"（在就绪基线之上还要涨）。
   * 布尔量在就绪阶段就被置真了，到刷屏阶段那条断言就退化成恒真。
   */
  ownHits: number
}

let core: CoreConnection
const tracked: Tracked[] = []

/**
 * 所有会话的标记串。串扰检查要拿**每一条**去扫**每一条流**，所以先算好。
 */
const allMarkers: string[] = []

beforeAll(async () => {
  core = await connectCore()
  for (let i = 0; i < SESSION_COUNT; i++) allMarkers.push(markerFor(i))
}, 60_000)

afterAll(async () => {
  // 不关会话的话，测试进程退出后会留下一堆还在刷屏的孤儿 shell。
  for (const t of tracked) await t.session.close().catch(() => {})
})

/**
 * 开一条会话并挂上「收数 + 按产品节奏发 ack + 逐块扫串扰」的计量器。
 *
 * **绝不缓存收到的全部字节**：12 条会话全速刷屏几秒就是几百 MiB，把它们攒在
 * 数组里，这条测试自己就会先 OOM，而且"内存不爆炸"那条断言会变成量测试自己的
 * 内存。改成逐块扫描 + 只留一小段尾巴。
 */
async function openTracked(index: number): Promise<Tracked> {
  const marker = markerFor(index)
  const session = await core.openSession({ cols: 120, rows: 40 })
  const t: Tracked = { index, marker, session, bytes: 0, foreign: [], ownHits: 0 }
  tracked.push(t)

  // 跨块边界：一个标记串可能被从端切成两块回来（PTY 读缓冲区是 64 KiB，
  // 边界落在标记中间是迟早的事）。留一段长度为「最长标记 − 1」的尾巴拼到下一块
  // 前面，被切开的标记才不会漏检——漏检等于串扰检查有一个恒定的盲区。
  const tailKeep = Math.max(...allMarkers.map((m) => m.length)) - 1
  let tail = ''
  const decoder = new TextDecoder()

  let pending = 0
  session.onData((b) => {
    t.bytes += b.byteLength
    // ack 的节奏和产品里的 AckBatcher 一致（攒够 FLOW_ACK_BATCH_BYTES 冲一次）。
    // 理由见 core-session.ts 里 ack() 的注释：不发 ack 的会话在核心眼里等于
    // 一个字节都没消费，量出来的是一条永远处于降级路径的假链路。
    pending += b.byteLength
    if (pending >= FLOW_ACK_BATCH_BYTES) {
      const n = pending
      pending = 0
      void session.ack(n)
    }

    const text = tail + decoder.decode(b, { stream: true })
    if (text.includes(marker)) t.ownHits += 1
    // 串扰：本会话的流里出现了**别人**的标记。只记前几条，够定性即可——
    // 真串了的话一秒钟能记几万条，攒着只会把测试自己撑爆。
    if (t.foreign.length < 5) {
      for (let j = 0; j < allMarkers.length; j++) {
        if (j === index) continue
        if (text.includes(allMarkers[j])) {
          t.foreign.push({ marker: allMarkers[j], atByte: t.bytes })
          if (t.foreign.length >= 5) break
        }
      }
    }
    tail = text.length > tailKeep ? text.slice(-tailKeep) : text
  })

  return t
}

async function waitUntil(pred: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`等待「${what}」超时（${timeoutMs}ms）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 反复做**探测性往返**，直到这条会话真的把我们写进去的东西回显回来。
 *
 * ── 为什么必须有这一步 ──────────────────────────────────────────────────
 * "从端吐了第一批字节"（提示符/横幅）**不等于**"它已经准备好接命令了"。Windows 上
 * 12 个 PowerShell 同时冷启动，横幅早早就打出来了，PSReadLine 还要再加载好几秒；
 * 这段时间里写进去的命令只是躺在 PTY 缓冲区里。若在此时开始计时刷屏，量到的是
 * "shell 还在启动"，而不是"并发刷屏跑不跑得动"——测试会红，但红的原因跟并发
 * 一点关系都没有。同一类假设刚刚让 e2e/latency-pairing.e2e.ts 在 Windows CI 上
 * 红掉（敲了键、从端一个字节都没回）。
 *
 * ── 判据为什么是「回显」而不是「等提示符」 ──────────────────────────────
 * 等提示符要求测试知道每个 shell 的提示符长什么样（`PS C:\…>` / `$` / 用户自定义
 * 的任意形状），而"写进去的东西回来了"直接量的就是本测试真正依赖的那条通路。
 *
 * ── 为什么探测串就用会话自己的标记 ──────────────────────────────────────
 * 探测行是 `#<marker>`，`#` 在 bash 和 PowerShell 里**都是注释**，所以这一行被
 * 回显、被解析、然后什么也不执行，不会污染后面的刷屏输出。而用同一个标记的好处
 * 是：这一步本身也成了**串扰检查的一部分**——12 条会话同时探测，路由要是退化成
 * 广播，此刻每条流里就会出现另外 11 个标记，`foreign` 立刻记上。
 */
async function waitForEcho(t: Tracked): Promise<boolean> {
  const probe = new TextEncoder().encode(`#${t.marker}\r`)
  const deadline = Date.now() + ECHO_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (t.ownHits > 0) return true
    t.session.write(probe)
    // 探测之间留一拍：写进去到回显回来要走完 PTY 一个来回，催得太急只会把命令行
    // 塞满一堆重复的注释行。
    for (let i = 0; i < 25 && t.ownHits === 0; i++) await sleep(40)
  }
  return t.ownHits > 0
}

test(`同时开 ${SESSION_COUNT} 条会话：每条都有独立的 sessionId 和独立的数据端口`, async () => {
  for (let i = 0; i < SESSION_COUNT; i++) await openTracked(i)

  expect(tracked).toHaveLength(SESSION_COUNT)
  const ids = new Set(tracked.map((t) => t.session.sessionId))
  expect(
    ids.size,
    `${SESSION_COUNT} 条会话只拿到 ${ids.size} 个不同的 sessionId——`
    + 'id 重复的话数据面根本无法分流，后面的串扰检查也就没有意义了。',
  ).toBe(SESSION_COUNT)
  expect([...ids].every((id) => id.length > 0), 'sessionId 不该是空串').toBe(true)

  // 每条会话都要真的有从端在跑（shell 的横幅/提示符）。有一条起不来，
  // 后面的并发结论就只覆盖了 11 条。
  await waitUntil(() => tracked.every((t) => t.bytes > 0), '每条会话的从端首批输出', 60_000)
}, 120_000)

test('就绪门：每条会话的「写进去 → 回显回来」通路都必须先被证明是活的', async () => {
  // 并行探测，不是逐条——逐条的话第 12 条要等前 11 条各自的往返，而且那也不是
  // 并发场景该有的形态。
  const results = await Promise.all(tracked.map(async (t) => ({ t, ok: await waitForEcho(t) })))
  const dead = results.filter((r) => !r.ok)
  expect(
    dead.map((r) => `#${r.t.index}(收了 ${r.t.bytes} 字节)`),
    `这些会话在 ${ECHO_READY_TIMEOUT_MS}ms 内始终没有把探测行回显回来——`
    + '从端没有就绪。此时开始刷屏，量到的是 shell 冷启动，不是并发能力。',
  ).toEqual([])
}, 180_000)

test(`${SESSION_COUNT} 条会话同时刷屏：各自都跑得完、都不丢数据`, async () => {
  // 就绪阶段每条会话都已经回显过自己的标记，所以这里要记一条基线：刷屏之后
  // 那个计数必须**继续涨**，才能说明它真的在吐自己的东西，而不是拿就绪阶段
  // 那一次回显来凑数。
  const ownHitsBefore = tracked.map((t) => t.ownHits)
  const bytesBefore = tracked.map((t) => t.bytes)

  // 同时发命令，不是依次——依次发的话前面的会话早就进入稳态了，压根不构成并发。
  const startedAt = Date.now()
  for (const t of tracked) {
    t.session.write(new TextEncoder().encode(floodCommand(t.marker)))
  }

  const report = (): string => tracked
    .map((t, i) => `#${t.index} ${((t.bytes - bytesBefore[i]) / 1024 / 1024).toFixed(1)}MiB`)
    .join(' ')

  // 等**每一条**都达标，而不是睡固定时长再看。达标即走：Linux 上通常一两秒，
  // Windows 上慢一点也不用改参数。等不到才失败，失败信息里带每条会话各收了多少。
  try {
    await waitUntil(
      () => tracked.every((t, i) => t.bytes - bytesBefore[i] > MIN_BYTES_PER_SESSION),
      `${SESSION_COUNT} 条会话各自收满 ${MIN_BYTES_PER_SESSION} 字节`,
      FLOOD_DEADLINE_MS,
    )
  } catch (e) {
    throw new Error(
      `${(e as Error).message}\n各会话本轮实收：${report()}\n`
      + '只有个别会话落后 = 它被并发拖死了（这正是本条测试要抓的）；'
      + '全部落后 = 从端根本没开始刷屏，去看上一条就绪门。',
    )
  }
  const elapsed = Date.now() - startedAt
  console.log(`  ${SESSION_COUNT} 条会话各自刷满 `
    + `${(MIN_BYTES_PER_SESSION / 1024).toFixed(0)}KiB 用时 ${elapsed}ms：${report()}`)

  for (const [i, t] of tracked.entries()) {
    expect(
      t.ownHits,
      `会话 #${t.index} 在刷屏期间收了 ${t.bytes - bytesBefore[i]} 字节，`
      + `含自己标记的数据块却一块都没增加（就绪阶段 ${ownHitsBefore[i]} 块）`
      + `——它收到的到底是谁的数据？`,
    ).toBeGreaterThan(ownHitsBefore[i])
  }
}, FLOOD_DEADLINE_MS + 30_000)

test('串扰检查：任何一条会话的数据流里都不许出现别人的标记', async () => {
  // 【本文件最重要的一条】数据面按 sessionId 路由，串了就是灾难性 bug：
  // 用户的两个终端互相串字，而且不报任何错。
  //
  // 变异测试就盯这一条——把路由改成广播（无论在 Rust 的 data_out、napi 的
  // start_data，还是 core-session.ts 的分流表里改），这条断言必须立刻变红。
  const offenders = tracked.filter((t) => t.foreign.length > 0)
  expect(
    offenders.map((t) => ({
      session: `#${t.index}`,
      own: t.marker,
      foreignFound: t.foreign,
    })),
    '在某些会话的数据流里发现了属于别的会话的标记串——数据面路由串了。'
    + '这是灾难性故障：用户的两个终端会互相串字，且不报任何错。',
  ).toEqual([])

  // 反证：上面那条为空，可能只是因为压根没数据。这里确认每条流都确实收到了
  // 大量数据、且都认出了自己的标记——「没串」这个结论才有分量。
  for (const t of tracked) {
    expect(t.ownHits, `会话 #${t.index} 没见过自己的标记，串扰检查对它是空转的`).toBeGreaterThan(0)
    expect(t.bytes).toBeGreaterThan(MIN_BYTES_PER_SESSION)
  }
})

test('内存不随会话数爆炸：在途字节的上界是 会话数 × 高水位', async () => {
  // 判据依据：流控是**每会话一份**的（session.rs 里每条会话各建一个 FlowWindow），
  // 所以 12 条会话全速刷屏时，核心侧在途未确认字节的上界就是
  // 12 × 1 MiB = 12 MiB，加上 Node 侧的解码/回调开销。
  //
  // 门槛取 384 MiB，是理论上界的 30 倍——**它不是用来卡精度的，是用来抓"根本
  // 没有上界"这件事**：流控要是按会话数失效了，12 条 `yes` 一秒能产出几百 MiB，
  // 几秒钟就冲过任何合理阈值。留这么大的余量是为了不被 V8 堆的惰性 GC 误伤
  // （RSS 不等于活跃对象），代价是抓不到"稍微多用了点内存"——那种事本来也不
  // 该由这条测试来管。
  const rssMiB = process.memoryUsage().rss / 1024 / 1024
  const inFlightBoundMiB = (SESSION_COUNT * FLOW_HIGH_WATER_BYTES) / 1024 / 1024
  const totalBytes = tracked.reduce((s, t) => s + t.bytes, 0)

  expect(
    rssMiB,
    `${SESSION_COUNT} 条会话累计灌了 ${(totalBytes / 1024 / 1024).toFixed(0)} MiB 之后，`
    + `测试进程 RSS = ${rssMiB.toFixed(0)} MiB。核心侧在途字节的理论上界只有 `
    + `${inFlightBoundMiB} MiB（会话数 × 高水位）。涨成这样说明背压没有按会话生效，`
    + '数据在某处无限攒积。',
  ).toBeLessThan(384)
})

test('读线程数与会话数一致，会话关闭后归零', async () => {
  // core.stats 这个诊断接口刚加上，这里是它第一次派上真实用场。
  // 先停掉刷屏，免得关会话时还在全速灌数据（关闭路径本身不该依赖"当前没数据"，
  // 但让失败信息干净一点总是好的）。
  for (const t of tracked) await t.session.signalInt().catch(() => {})
  await sleep(500)

  const before = await core.stats()
  expect(
    before.liveReadThreads,
    `开着 ${SESSION_COUNT} 条会话，核心却报有 ${before.liveReadThreads} 个存活读线程。`
    + '每条会话恰好一个读线程：多了说明有会话关掉之后线程没退出（泄漏），'
    + '少了说明有读线程已经静默死掉了（那条会话此后永远不会再有数据）。',
  ).toBe(SESSION_COUNT)

  for (const t of tracked) await t.session.close()

  // 读线程退出是异步的：close() 只是 kill 子进程 + 标记 flow 关闭，读线程要等
  // 当前这次 reader.read() 返回（EOF 或错误）才走到计数器自减。轮询等它归零。
  // 这里用显式循环而不是上面的 waitUntil：谓词要发一次控制面请求，是异步的。
  let last = before.liveReadThreads
  const deadline = Date.now() + 30_000
  for (;;) {
    last = (await core.stats()).liveReadThreads
    if (last === 0 || Date.now() > deadline) break
    await sleep(100)
  }

  expect(
    last,
    `${SESSION_COUNT} 条会话全部 close() 之后，核心仍报有 ${last} 个存活读线程。`
    + '读线程没退出 = 线程泄漏 + PTY 句柄泄漏，开关会话多了之后会拖垮整个进程。',
  ).toBe(0)
}, 60_000)
