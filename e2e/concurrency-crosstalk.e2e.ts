/**
 * 【全流程·双向】10+ 并发会话串扰：真 Electron，一个渲染进程里同时开十几条会话，
 * **发送**和**返回**两个方向都不许串。
 *
 * ── 它和 e2e/concurrency-core.e2e.ts 是什么关系（为什么两条都要留）──────────
 * concurrency-core 走的是 `connectCore`，普通 Node 进程直连 napi。它测得很扎实，
 * 但**只覆盖到 Rust + napi 那一段**：渲染进程这一侧的数据面根本没被执行过。
 * 实测证据（本轮变异验证跑出来的）：把 src/ui/common/session-data-buffer.ts 的
 * 路由改成"广播给所有会话"，concurrency-core **全绿通过**——那一层压根没跑到。
 *
 * 于是下面这几层此前是零覆盖的，正是本文件要补上的：
 *   - 渲染进程 ←→ core-host 的**两跳数据面 MessagePort**
 *   - src/core-host/index.ts 的入向路由 + src/ui/common/session-data-buffer.ts
 *   - src/ui/common/data-batcher.ts 的合批
 *   - **出向 `sendData(sessionId, …)`**：决定"用户敲的字进哪个会话"。它退化的
 *     症状是「在 A 里打字、字出现在 B 里」，而在本文件之前，**这个方向一条断言
 *     都没有**。
 *
 * ── 判据：两个方向各一半，缺一不可 ──────────────────────────────────────
 * 每条会话有一个只属于自己的标记串。测试往会话 i 的数据端口写 `marker_i`，
 * 从端把它回显回来。于是：
 *   - **发送方向**：`marker_i` 必须出现在**会话 i 自己**的数据流里。出不来就说明
 *     它被写进了别人的 PTY（出向路由串了）。这条断言就是"没见过自己的标记就是
 *     空转"那个防空转自检——沿用 concurrency-core 的思路，而在这里它同时还是
 *     **发送方向唯一的正面证据**。
 *   - **返回方向**：`marker_i` 只能出现在会话 i 的流里，**不许**出现在任何别的
 *     会话的流里。返回路由退化成广播/串号，这条立刻红。
 * 两条合起来构成一个矩阵：期望是严格的对角线。失败时把整个矩阵打出来，一眼能
 * 分辨是哪个方向坏了——只有对角线空了是**发送**串，非对角线有东西是**返回**串
 * （出向路由串了会两条一起红，因为字节确实进了别人的 PTY 又被别人回显了）。
 *
 * ── 平台差异，以及为什么两个平台都跑 ────────────────────────────────────
 * Linux 上 Electron 里 PTY 子进程 exec 不起来（portable-pty 的
 * `close_random_fds()` 撞 Chromium 覆盖的 `close()`，见 electron-app.ts 的
 * FD_OWNERSHIP_CRASH_MARKER），回显来自**内核行规程**、没有 shell。这对串扰
 * 判据不但够用，而且**更干净**：每条会话只会回显自己被写进去的东西，一个字节的
 * 噪声都没有，"这个标记怎么会在这条流里"没有第二种解释。
 * Windows 上是真 ConPTY + PowerShell，回显来自 PSReadLine，还夹着提示符、语法
 * 高亮的转义序列、CPR/焦点上报这些**主动发出的非按键数据**。判据在那边照样成立
 * ——因为它是**子串匹配一个本次运行随机生成的标记**，PowerShell 的任何自发输出
 * 都不可能撞上；这跟 e2e/latency-pairing.e2e.ts 那种"数样本个数"的判据完全不同，
 * 后者才会被自动回复搅乱（那条测试为此把判据升级成了类级的"以 ESC 开头即上报"）。
 * 真正需要向 Windows 妥协的只有**节奏**：PowerShell 冷启动能到几十秒，所以下面
 * 所有等待都是"等判据满足"而不是"睡固定时长"，这一条也是从 latency-pairing 那次
 * Windows 红掉里学来的。
 *
 * ── 多会话是怎么驱动起来的 ──────────────────────────────────────────────
 * 产品 UI 现在只有一条会话（标签页是 V1 的事），所以测试侧通过
 * `window.__htDiagnostics.sessions` 这个**诊断专用**驱动面开会话——就像当初为了
 * 读屏幕缓冲区加 `__htDiagnostics.term` 一样。它不是产品 API，边界写在
 * src/ui/browser/diagnostics/multi-session.ts 顶部：走的是和产品完全相同的
 * ProtocolClient / openDataPort / MessagePort / AckBatcher，没人调用时什么都不做。
 * 最后一条测试还会连**主终端**（真 xterm + 真键盘）一起验，那条是纯产品路径。
 */
import { afterAll, expect, test } from 'vitest'
import type { ElectronApplication, Page } from 'playwright-core'
import { launchApp, MOUNT_TIMEOUT_MS, readDiagnosticLog, readScreen } from './electron-app'

/**
 * 并发会话数。产品要求写的是「10+」，取 12 是为了确确实实**超过**那条线。
 * 加上主终端那条，本文件实际同时开着 13 条。
 */
const SESSION_COUNT = 12

/**
 * 等「回显通路活了」的上限。
 *
 * 为什么给到 90 秒：Windows 上要等 ConPTY 起 conhost + PowerShell 启动 +
 * PSReadLine 加载，**12 条同时冷启动**，叠加 Defender 实时扫描，实测能到几十秒。
 * 这个数字只是**上限**，不是固定等待——判据一满足立刻往下走，Linux 上通常几百
 * 毫秒就过了。同 latency-pairing.e2e.ts / concurrency-core.e2e.ts 的取值。
 */
const ECHO_READY_TIMEOUT_MS = 90_000

/**
 * 等 12 条会话全部建立（含各自数据端口接好）的上限。
 *
 * ── 这个数字为什么这么大：一条实测出来的、此前没人知道的事 ────────────────
 * 同样是 12 条会话并发 `session.open`：
 *   - 普通 Node 进程（e2e/core-session.ts 那条路）：**总共 76ms**
 *   - 真 Electron 的 utility 进程里：**总共 99 秒**（本机实测，每条 ~8.3 秒，
 *     而且是严格串行的：第 7 条在 58.1s 返回，第 12 条在 99.0s 返回）
 * 差了三个数量级，而两边跑的是同一份 Rust 代码。差异只可能来自 Electron 环境：
 * Linux 上 PTY 子进程 fork 之后、exec 之前就被 Chromium 的 fd 归属检查打死了
 * （FD_OWNERSHIP_CRASH_MARKER）。而 Rust 标准库的 `Command::spawn` 在 Unix 上
 * 会用一根 CLOEXEC 管道**等子进程 exec 成功或报错**——子进程改成"崩溃"之后，
 * 这根管道要等它真的死透（Chromium 的崩溃处理要给一个继承了整个 utility 进程
 * 地址空间的子进程写现场）才关闭，于是 `session.open` 这个控制面请求就一直
 * 卡在那里。又因为 core-host 的控制面是**同步**处理的（napi `send()` 直接
 * 调 `handle_inbound`），12 条请求只能一条接一条地卡，时间线性叠加。
 *
 * 三点必须说清楚：
 * 1. 这是**这条测试发现的真问题**，不是测试自己的开销——产品上它对应的是
 *    "Linux 上开一个终端标签要等 8 秒，开的过程中整个核心不响应任何控制面请求"；
 * 2. 它是 **Linux 专有**的，根因是那个 fd 归属崩溃。Windows 走 ConPTY，没有
 *    fork/close-fds 这一段，所以 CI 的 smoke-windows 上这个数字应当小得多——
 *    两边都打印出来，正好互为对照；
 * 3. 所以这里给的是 5 分钟，不是"慢机器多等等"的常规余量。**如果哪天这个数字
 *    掉回百毫秒级，说明上游/我们把那个崩溃修掉了，那时应该把这里调回去**，
 *    而不是让它一直挂着一个没人再解释得清的大数字。
 */
const OPEN_DEADLINE_MS = 300_000

/** 串扰矩阵阶段等「每条会话都看见自己的标记」的上限。就绪门已经过了，不用这么久。 */
const MATRIX_DEADLINE_MS = 60_000

/** 两次取数（drain）之间的间隔。数据是攒在页面里的，取太密只是白白多几次 CDP 往返。 */
const PUMP_INTERVAL_MS = 100

/**
 * 本次运行的随机后缀，**定长 8 位**。
 *
 * 定长是有讲究的：下面 `tailKeep` 依赖"所有标记等长"这个性质来保证跨块拼接既
 * 不漏检也不重复计数（见 pump()）。`Math.random().toString(36).slice(2,10)` 偶尔
 * 会短于 8 位，所以这里逐字符生成。
 */
const RUN_TAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const RUN_TAG = Array.from(
  { length: 8 },
  () => RUN_TAG_ALPHABET[Math.floor(Math.random() * RUN_TAG_ALPHABET.length)],
).join('')

/**
 * 第 i 条会话的专属标记串。
 *
 * - 序号**补零到两位**：不补零的话 `ht-flow-1-` 是 `ht-flow-11-` 的前缀，子串匹配
 *   立刻误报。
 * - 带一段**本次运行随机**的后缀：这样"在别人的流里发现了我的标记"就只可能是
 *   路由串了，不可能是撞上了 shell 自己的输出。
 * - 主终端那条用 `mm` 占序号位，好让**所有标记等长**（见 RUN_TAG 的注释）。
 */
function markerFor(index: number): string {
  return `ht-flow-${String(index).padStart(2, '0')}-${RUN_TAG}-end`
}
const MAIN_MARKER = `ht-flow-mm-${RUN_TAG}-end`

interface Tracked {
  index: number
  sessionId: string
  marker: string
  /** 累计收到的字节数（由页面侧记账，不随取数清零）。 */
  bytes: number
  /** 页面侧缓冲区丢弃的字符数。非 0 说明扫描有盲区，必须当失败处理。 */
  dropped: number
  /** 在**本会话**流里数到的、**自己**标记的出现次数。防空转自检就靠它。 */
  ownHits: number
  /** 在**本会话**流里发现的、**属于别人**的标记：串扰的铁证。 */
  foreign: { marker: string, atByte: number }[]
  /** 跨块拼接用的尾巴，见 pump()。 */
  tail: string
}

let app: ElectronApplication
let page: Page
const tracked: Tracked[] = []
/** 所有标记（12 条会话 + 主终端）。串扰检查要拿每一条去扫每一条流。 */
const allMarkers: string[] = []
for (let i = 0; i < SESSION_COUNT; i++) allMarkers.push(markerFor(i))
allMarkers.push(MAIN_MARKER)

/**
 * 尾巴长度。所有标记等长，取「长度 − 1」同时满足两件事：
 * - 够长：任何被切成两半的标记，前半截一定落在尾巴里，不会漏检；
 * - 又不会太长：尾巴里**装不下一个完整标记**，所以拼接不会把同一次命中数两遍。
 */
const tailKeep = allMarkers[0].length - 1

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 取一次页面侧攒下的数据，逐条会话扫描。所有等待都通过它推进。 */
async function pump(): Promise<void> {
  const snapshot = await page.evaluate(() => window.__htDiagnostics!.sessions!.drain())
  for (const t of tracked) {
    const snap = snapshot[t.sessionId]
    if (!snap) continue
    t.bytes = snap.bytes
    t.dropped = snap.dropped
    if (snap.text.length === 0) continue

    const text = t.tail + snap.text
    t.ownHits += text.split(t.marker).length - 1
    for (const m of allMarkers) {
      if (m === t.marker) continue
      if (text.includes(m)) t.foreign.push({ marker: m, atByte: t.bytes })
    }
    t.tail = text.length > tailKeep ? text.slice(-tailKeep) : text
  }
}

async function pumpUntil(pred: () => boolean, what: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await pump()
    if (pred()) return true
    if (Date.now() > deadline) return false
    await sleep(PUMP_INTERVAL_MS)
  }
}

/** 往一批会话里写各自的标记。一次 page.evaluate 全发完，这样它们是真·同时。 */
async function writeMarkers(targets: Tracked[]): Promise<void> {
  const jobs = targets.map((t) => [t.sessionId, t.marker] as [string, string])
  await page.evaluate((pairs) => {
    for (const [id, text] of pairs) window.__htDiagnostics!.sessions!.write(id, text)
  }, jobs)
}

/**
 * 反复往**还没看见自己标记**的会话里写探测串，直到全部看见（或超时）。
 *
 * 为什么不发换行：类 Unix 下带 `\r` 会把整行送进 tty 的规范模式读队列，而从端
 * 没有任何进程在读，队列 4KB 就满、之后字节被直接丢掉（e2e/flood.e2e.ts 实测：
 * 写 256KiB 只回来 1350 字节）。不带换行时行规程的回显是 1:1 的。Windows 上不发
 * 换行还顺带保证了**什么都不会被执行**——标记串只是躺在 PSReadLine 的行编辑器里
 * 被回显，不会变成一条报"命令找不到"的错误。
 */
async function driveUntilAllEchoed(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  // 第一轮**发给所有会话**：并发场景要求它们同时开始，而不是排队一条条来。
  await writeMarkers(tracked)
  for (;;) {
    const pending = tracked.filter((t) => t.ownHits === 0)
    if (pending.length === 0) return true
    if (Date.now() > deadline) return false
    // 重发只针对还没活的那些。Windows 上 PSReadLine 就绪之前写进去的字节会在
    // ConPTY 缓冲里排队，就绪后才被回显，所以重发不是"必须"，但它能让**真的丢了
    // 一次写**的情况自愈，而不是把整条测试拖到超时才说"没回显"。
    await sleep(500)
    await writeMarkers(pending)
    await pumpUntil(() => tracked.every((t) => t.ownHits > 0), '', 2_000)
  }
}

/** 失败信息里的串扰矩阵：一眼看出是发送方向坏了（对角线空）还是返回方向坏了（非对角线有值）。 */
function matrixReport(): string {
  return tracked.map((t) => {
    const own = `自己的标记 ×${t.ownHits}`
    const foreign = t.foreign.length > 0
      ? `**别人的标记：${[...new Set(t.foreign.map((f) => f.marker))].join(', ')}**`
      : '别人的标记：无'
    return `  #${String(t.index).padStart(2, '0')} 收 ${t.bytes}B | ${own} | ${foreign}`
  }).join('\n')
}

afterAll(async () => {
  await app?.close()
})

test(`同一个渲染进程里同时开 ${SESSION_COUNT} 条会话，每条一个独立数据端口`, async () => {
  const launchStart = Date.now()
  ;({ app, page } = await launchApp())
  const launchedAt = Date.now()

  // 诊断驱动面是在主终端的数据端口就绪之后才挂上的（见 boot.ts），而 launchApp
  // 等的是 `__htDiagnostics.term`——两者只隔几行同步代码，但"隔得近"不等于
  // "有保证"，这里显式等一下，免得将来谁在中间插一个 await 就变成偶发失败。
  await page.waitForFunction(
    () => typeof window.__htDiagnostics?.sessions?.open === 'function',
    undefined,
    { timeout: MOUNT_TIMEOUT_MS },
  )

  // 并发开，不是逐条开：逐条开的话第 12 条是在前 11 条都稳定之后才建立的，
  // 那种时序恰恰绕开了"同时建会话"这个最容易串号的窗口。
  const openStart = Date.now()
  const ids = await page.evaluate(
    (n) => Promise.all(Array.from({ length: n }, () => window.__htDiagnostics!.sessions!.open())),
    SESSION_COUNT,
  )
  // 这两个数字每轮都打出来，因为它们已经暴露了一件本来没人知道的事，见下面
  // OPEN_DEADLINE_MS 的注释。
  console.log(`  启动到终端挂载 ${launchedAt - launchStart}ms；`
    + `并发开 ${SESSION_COUNT} 条会话 ${Date.now() - openStart}ms`)

  ids.forEach((sessionId, index) => {
    tracked.push({
      index, sessionId, marker: markerFor(index),
      bytes: 0, dropped: 0, ownHits: 0, foreign: [], tail: '',
    })
  })

  const unique = new Set(ids)
  expect(
    unique.size,
    `${SESSION_COUNT} 条会话只拿到 ${unique.size} 个不同的 sessionId——`
    + 'id 一重复，数据面就无法分流，后面的串扰检查也就没有意义了。',
  ).toBe(SESSION_COUNT)
  expect([...unique].every((id) => id.length > 0), 'sessionId 不该是空串').toBe(true)

  // 反面的正面证据：核心侧真的有这么多读线程活着。没有这一条的话，"12 条会话
  // 都没串"可能只是因为其中几条压根没起来（那种情况下它们当然不会串）。
  // 主终端那条也在里面，所以是 SESSION_COUNT + 1。
  const liveReadThreads = await page.evaluate(() => window.__htDiagnostics!.coreStats!())
  expect(
    liveReadThreads,
    `核心报有 ${liveReadThreads} 个存活读线程，期望至少 ${SESSION_COUNT + 1}`
    + `（${SESSION_COUNT} 条诊断会话 + 主终端）。少了说明有会话根本没起来或读线程已经静默死了。`,
  ).toBeGreaterThanOrEqual(SESSION_COUNT + 1)
}, MOUNT_TIMEOUT_MS + OPEN_DEADLINE_MS)

test('就绪门：每条会话的「写进去 → 回显回来」通路都必须先被证明是活的', async () => {
  // 这一步既是就绪门也是第一次串扰采样：12 条会话同时写各自的标记，返回路由
  // 要是退化成广播，此刻每条流里就会出现另外 11 个标记。
  const ok = await driveUntilAllEchoed(ECHO_READY_TIMEOUT_MS)
  expect(
    ok,
    `等了 ${ECHO_READY_TIMEOUT_MS}ms，仍有会话没把自己写进去的标记回显回来。\n`
    + `串扰矩阵：\n${matrixReport()}\n`
    + '对角线为空 = 写进去的字节没进自己的 PTY（**出向路由串了**）；\n'
    + '全部为空 = 从端根本没就绪（Windows 冷启动）或数据面整条断了。\n'
    + `诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toBe(true)
}, ECHO_READY_TIMEOUT_MS + 60_000)

test('【发送方向】写给会话 A 的字节，只能进 A 的 PTY——A 必须回显出自己的标记', async () => {
  // ── 本文件最重要的一条，也是此前**完全没有覆盖**的那个方向 ──────────────
  // 出向路由是 core-host 里 `port.on('message', (m) => sendData(sessionId, …))`
  // 那一句。它串了的症状是"在 A 里打字、字出现在 B 里"——用户会把半条命令、
  // 密码敲进另一个终端，而程序不报任何错。
  //
  // 判据必须是**正面**的（"A 看见了自己的标记"），不能只查"B 没看见 A 的标记"：
  // 出向路由要是把所有写都丢了，后者恒真、测试全绿，而终端其实完全打不了字。
  // 这就是 concurrency-core 里那条"没见过自己的标记就是空转"的自检，在发送方向
  // 上它不只是自检，它就是**主判据**。
  //
  // 就绪门阶段每条会话都已经回显过一次，所以这里**清零重来**：必须是这一轮
  // 新写进去的字节自己走通了，才算数。清零前先静置一拍并把在途的数据取空，
  // 否则上一阶段迟到的回显会被算进这一轮，那条断言就退化成"上次的成绩"。
  await sleep(500)
  await pump()
  for (const t of tracked) { t.ownHits = 0; t.foreign = []; t.tail = '' }

  // 12 条会话**同时**各写各的标记：这才是并发形态，而不是排队一条条来。
  await writeMarkers(tracked)
  const ok = await pumpUntil(
    () => tracked.every((t) => t.ownHits > 0),
    '每条会话都回显出自己的标记',
    MATRIX_DEADLINE_MS,
  )

  const silent = tracked.filter((t) => t.ownHits === 0)
  expect(
    silent.map((t) => `#${t.index}（收了 ${t.bytes}B）`),
    `这些会话写进去了自己的标记，却在自己的数据流里一次都没见到它。\n`
    + `串扰矩阵：\n${matrixReport()}\n`
    + '如果同时有别的会话在自己流里见到了它们的标记 → **出向路由把字节送进了错误的会话**；\n'
    + '如果谁都没见到 → 出向路由把字节丢了，或者返回方向整条断了。\n'
    + `诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toEqual([])
  expect(ok, '等不到全部会话回显自己的标记').toBe(true)
}, MATRIX_DEADLINE_MS + 60_000)

test('【返回方向】任何一条会话的数据流里，都不许出现别人的标记', async () => {
  // 返回方向的路由链：Rust 读线程 `data_out(read_id, …)` → napi startData(sid)
  // → core-host 的 batcherFor(sid) → SessionDataBuffer.push(sid) → 该会话的
  // MessagePort → 渲染侧消费者。这条链上任何一环把 id 丢了或退化成广播，
  // 症状都是灾难性且静默的：两个终端互相串字，不报任何错。
  //
  // 变异测试专门盯这一条（Rust 的 read_id、SessionDataBuffer 的路由），
  // 改成广播必须立刻红。
  await pump()
  const offenders = tracked.filter((t) => t.foreign.length > 0)
  expect(
    offenders.map((t) => ({
      session: `#${t.index}`,
      own: t.marker,
      foreignFound: [...new Set(t.foreign.map((f) => f.marker))],
    })),
    `在这些会话的数据流里发现了**属于别的会话**的标记串。\n`
    + `串扰矩阵：\n${matrixReport()}\n`
    + '这是灾难性故障：用户的两个终端会互相串字，且不报任何错。\n'
    + `诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toEqual([])

  // 防空转：上面那条为空，也可能只是因为每条流里压根什么都没有。
  for (const t of tracked) {
    expect(
      t.ownHits,
      `会话 #${t.index} 没见过自己的标记，对它来说上面那条串扰断言是空转的`,
    ).toBeGreaterThan(0)
    expect(t.bytes, `会话 #${t.index} 一个字节都没收到`).toBeGreaterThan(0)
  }
})

test('扫描没有盲区：没有任何一条会话的数据被页面侧缓冲上限丢掉', async () => {
  // 串扰是靠子串匹配找的，静默丢数据等于给判据开一个看不见的窟窿——
  // "没发现串扰"会因此变成一句没有分量的话。所以丢弃必须被记账并断言为 0。
  const lossy = tracked.filter((t) => t.dropped > 0)
  expect(
    lossy.map((t) => `#${t.index} 丢了 ${t.dropped} 字符`),
    '页面侧缓冲区丢过数据，串扰扫描存在盲区，本轮结论不作数。',
  ).toEqual([])
})

test('主终端（真 xterm + 真键盘）也在同一张矩阵里：它的字不进别人，别人的字不上它的屏', async () => {
  // 前面几条走的是诊断驱动面开的会话（数据面完全是产品那条，但没有 xterm）。
  // 这一条补上**纯产品路径**：真键盘 → xterm.onData → 数据面 MessagePort →
  // core-host → sendData → PTY → 回显 → xterm.write → 屏幕缓冲区。
  // 它和上面 12 条会话是**同时**存在的，所以主终端本身就是这张串扰矩阵的第 13 行。

  // 先回车把当前行清干净，再打标记：这样标记从第 0 列开始，不会被换行切断，
  // 屏幕上的子串匹配才可靠。不在标记后面回车——不回车就什么都不会被执行，
  // Windows 上也就不会多出一条"命令找不到"的报错。
  await page.keyboard.press('Enter')
  await page.keyboard.type(MAIN_MARKER, { delay: 10 })

  const deadline = Date.now() + MATRIX_DEADLINE_MS
  let onScreen = false
  for (;;) {
    const lines = await readScreen(page)
    onScreen = lines.some((l) => l.includes(MAIN_MARKER))
    // 主终端在等回显的同时，另外 12 条流也在继续收数据，一起扫。
    await pump()
    if (onScreen || Date.now() > deadline) break
    await sleep(PUMP_INTERVAL_MS)
  }

  // 正面：主终端敲进去的字回到了**自己**的屏幕上。（防空转：没有这一条的话，
  // 下面"别人流里没有主终端的标记"可能只是因为主终端压根没发出去。）
  expect(
    onScreen,
    `主终端敲进去的标记没有回到自己的屏幕上。屏幕内容：\n`
    + (await readScreen(page)).filter((l) => l.length > 0).map((l) => `  | ${l}`).join('\n')
    + `\n诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toBe(true)

  // 反面之一：主终端敲的字不许出现在别的会话流里（发送方向）。
  const leaked = tracked.filter((t) => t.foreign.some((f) => f.marker === MAIN_MARKER))
  expect(
    leaked.map((t) => `#${t.index}`),
    `主终端敲进去的标记出现在了这些会话的数据流里——**用户敲的字进了别的会话**。\n`
    + `串扰矩阵：\n${matrixReport()}`,
  ).toEqual([])

  // 反面之二：别的会话的数据不许出现在主终端的屏幕上（返回方向）。
  const screen = (await readScreen(page)).join('\n')
  const intruders = tracked.filter((t) => screen.includes(t.marker)).map((t) => `#${t.index}`)
  expect(
    intruders,
    `主终端的屏幕上出现了这些会话的标记——**别的会话的输出串到用户屏幕上了**。\n`
    + `串扰矩阵：\n${matrixReport()}`,
  ).toEqual([])
}, MATRIX_DEADLINE_MS + 60_000)
