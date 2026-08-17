/**
 * 丝滑压测（产品第②条核心要求）里**流控**那一半：真 shell 全速刷屏，检验
 * 1MiB/256KiB 这对高低水位、64KiB 的 ack 批量、5s 的停摆看门狗到底管不管用。
 *
 * 为什么必须有它：limits.rs 里那几个数字全部标着"来源：暂定值"，从写下来那天
 * 起**一次都没有在真实数据量下跑过**。没跑过的背压等于没有背压——它要么根本
 * 不触发（那内存会无限涨），要么触发了就再也回不来（那终端一次刷屏之后永久
 * 冻死，且不报任何错，正是本项目最难查的那一类故障）。这两种都只有灌真数据
 * 才能分辨。
 *
 * 为什么跑在**普通 Node 进程**里（core-session.ts）而不是 Electron 里：
 * Linux 上 Electron 进程内 fork 不出 PTY 子进程（Chromium 的 fd 归属检查，见
 * electron-app.ts 的 FD_OWNERSHIP_CRASH_MARKER），根本没有 shell，也就没有
 * 任何东西能刷屏——Electron 里只能靠内核行规程回显自己写进去的字节，实测灌到
 * 约 1MiB 就被 tty 丢弃，压不出持续的洪水。普通 Node 进程里 shell 正常启动，
 * `yes` 一秒能产出几十 MiB，这才是流控真正要面对的量级。渲染层那一半
 * （xterm 解析、页面不假死）由 e2e/flood.e2e.ts 在 Electron 里覆盖，两边合起来
 * 才是完整的第②条。
 *
 * 这里的 ack 由测试自己发（`session.ack`），节奏和产品里的 `AckBatcher` 一致
 * （攒够 FLOW_ACK_BATCH_BYTES 冲一次）——理由见 core-session.ts 里 `ack()` 的
 * 注释：不发 ack 的压测量的是一条永远处于降级路径的假链路。
 */
import { afterAll, beforeAll, expect, test } from 'vitest'
import { connectCore, type CoreConnection, type CoreSession } from './core-session'
import { SessionFlowStalledEvent } from '../src/ui/common/protocol/hackerterm'
import {
  FLOW_ACK_BATCH_BYTES, FLOW_HIGH_WATER_BYTES, FLOW_PAUSE_STALL_TIMEOUT_MS,
} from './rust-limits'

/** 刷屏内容的一行。两个平台共用，方便对着日志确认灌进来的确实是它。 */
const FLOOD_LINE = 'hackerterm-flood-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * 无限刷屏的命令。两个平台各自选一条**不依赖任何外部程序**的：
 * - 类 Unix：`yes` 是 coreutils，任何发行版都有。
 * - Windows：PowerShell，不用 `yes`（Windows 上没有这个命令，这正是 CI 里
 *   verify job 常年飘红的原因之一）。
 *
 * ── Windows 这条为什么从 `while($true){"…"}` 改掉（CI 实测红了）────────────
 * 原来那条在 smoke-windows 上量出来是 **0.2 MiB/s**（3 秒只灌进 0.5 MiB），
 * 而同一条测试在 Linux 上是 41 MiB/s——差 200 倍，直接把
 * "3 秒至少 8 MiB" 这条判据顶红了。
 *
 * **不能为了变绿去降 MIN_FLOOD_BYTES**：那个阈值的意义是"这一轮真的把流控压到了
 * 稳态"，压不到就该说这轮不作数（原测试正是这么写的，那个设计是对的）。要改的是
 * "怎么在 PowerShell 里真的把数据灌起来"。
 *
 * 慢在哪：`"字符串"` 是往**对象管道**里扔一个对象，PowerShell 要经过格式化子系统
 * （Out-Default → 格式化器 → 主机 WriteLine）才落到控制台，每行一次，开销全在这
 * 一路上，跟我们要压的那条数据通道毫无关系。
 * 改法是绕开管道：先在内存里拼好一大块（约 55 KiB），然后 `[Console]::Out.Write`
 * 直接写标准输出——一次调用一大块，格式化器完全不参与。`[Console]::Out` 在 .NET
 * 上默认 AutoFlush，写完立刻进 ConPTY，不会攒在缓冲区里骗过我们的计量。
 *
 * 为什么还是 `while($true)` 而不是有限循环：这条测试的第二半是"中断后 1 秒内停
 * 下来"，需要一个**真的停不下来的东西**去中断。PowerShell 引擎在循环体的每条语句
 * 之间检查停止请求，所以 Ctrl+C 照样能打断它。
 *
 * 【这条改动只能在 Windows CI 上验证】容器里没有任何 PowerShell（`pwsh` 和
 * `powershell` 都不存在），本地跑不出它的吞吐。下面失败信息里带上了命令原文，
 * 万一还是不够快，下一轮日志里能直接看到跑的是哪一条。
 *
 * ── 【记一个产品事实】Windows 上的刷屏吞吐天花板 ─────────────────────────
 * 同一套压测、同一份代码，实测：
 *     Linux（PTY + `yes`）              约 41 MiB/s
 *     Windows（ConPTY + PowerShell）    约 2.3 MiB/s
 * **差约 18 倍**，而且这 2.3 已经是把 PowerShell 那侧优化过一轮之后的数字
 * （从 0.2 MiB/s 提到 2.3 MiB/s，见上一段）。剩下的差距在 **ConPTY 本身**：
 * 它要把子进程的输出先渲染进一个屏幕缓冲区、再序列化成 VT 序列吐出来，这一段
 * 不在我们手里。我们自己那段链路是干净的——IPC 单跳实测 0.36ms（见
 * e2e/latency-*.ts），根本不是瓶颈。
 *
 * 为什么值得写在这里：用户核心要求第②条有「cat 大文件、tail 日志要丝滑」。
 * 将来在 Windows 上看到"刷屏怎么这么慢"，**先想到这个天花板**，别一头扎进
 * IPC / 流控里找问题——那边已经量过了。真要提这个数，方向是绕开 ConPTY 的
 * 渲染（例如换传输层或直接管道），不是调我们的水位。
 */
const FLOOD_COMMAND = process.platform === 'win32'
  ? `$c=(('${FLOOD_LINE}'+[char]13+[char]10)*1024);while($true){[Console]::Out.Write($c)}\r`
  : `yes ${FLOOD_LINE}\r`

/**
 * 「停下来了」的判据：连续这么久一个字节都没再来。
 *
 * 取 300ms 的理由：正常刷屏时数据是连续不断的（实测块间隔在毫秒量级），
 * 300ms 的空窗在刷屏期间不可能出现；同时它又远小于 1s 这条产品要求，
 * 留得下判定余量。
 */
const QUIET_MS = 300

/**
 * 产品要求：刷屏中断后必须在 1 秒内停止。
 * 这个数字来自产品文档第②条，不是压测调出来的经验值，所以写死在这里。
 */
const INTERRUPT_DEADLINE_MS = 1_000

/**
 * 一次压测至少要灌进来多少字节才算数。低于这个量说明 shell 压根没在刷屏。
 *
 * 8 MiB 是**有含义的数字**，不许为了让 CI 变绿去降：高水位是 1 MiB，8 MiB
 * 意味着"灌满 → 被按住 → ack 放行"这个循环被真正压满了 8 轮，流控是在稳态下
 * 被检验的，而不是刚碰到水位就收工。
 */
const MIN_FLOOD_BYTES = 8 * 1024 * 1024

/**
 * 灌数据的**上限时长**——注意它是"最多灌这么久"，不是"就灌这么久"。
 *
 * ── 为什么把时间和数据量拆开 ────────────────────────────────────────
 * 原来写的是「固定灌 3 秒，然后要求收到 ≥ 8 MiB」。那等于在要求
 * **≥ 2.8 MiB/s 的吞吐**——可 Windows 上 ConPTY 实测就在 2.3 MiB/s 上下
 * （见 FLOOD_COMMAND 上面那段），CI 机器还是跟别人共享的。于是这条判据必然
 * 随机红，而且红的时候报的是"数据量太小，shell 根本没在刷屏"——一句**与事实
 * 不符**的诊断：shell 明明在拼命刷，只是这台机器没那么快。
 * 一个会随机红的门禁比没有门禁更糟：它会训练所有人无视红灯。
 *
 * 病根是「3 秒」这个数同时扛了两件不该混在一起的事：
 *   ① 喂够量——由 MIN_FLOOD_BYTES 负责，它有物理含义（8 轮水位循环）；
 *   ② 别跑太久——这才是超时该管的事，它只需要"宽松到不误伤"。
 * 拆开之后：**灌到够为止**，够了立刻停（快的机器上反而比原来更快结束），
 * 到上限还不够才判失败——那时候"没在刷屏"才是真结论。
 *
 * 30 秒怎么来的：按 Windows 实测下限 2.3 MiB/s，灌够 8 MiB 需要约 3.5 秒；
 * 30 秒留了约 8.5 倍余量，也就是说这台机器得比已知最慢的情况**再慢 8 倍**才会
 * 误报。同时它远小于单条测试 120 秒的超时，超时了也能出我们自己的断言信息
 * （带实测吞吐），而不是被 vitest 掐掉、只留一句没有信息量的 timeout。
 */
const FLOOD_TIMEOUT_MS = 30_000

let core: CoreConnection
/** 收到的 `session.flow_stalled` 事件，全局收集（它属于哪条会话由 payload 带）。 */
const stallEvents: { sessionId: string, unacknowledgedBytes: number, stalledMs: number }[] = []

beforeAll(async () => {
  core = await connectCore()
  core.onEvent('session.flow_stalled', (payload) => {
    const ev = SessionFlowStalledEvent.decode(payload)
    stallEvents.push({
      sessionId: ev.sessionId,
      unacknowledgedBytes: Number(ev.unacknowledgedBytes),
      stalledMs: Number(ev.stalledMs),
    })
  })
}, 60_000)

const openSessions: CoreSession[] = []
afterAll(async () => {
  // 不关会话的话，测试进程退出后会留下还在 `yes` 刷屏的孤儿 shell。
  for (const s of openSessions) await s.close().catch(() => {})
})

interface Meter {
  session: CoreSession
  /** 累计收到的字节数。 */
  bytes(): number
  /** 最后一次收到数据的时刻（Date.now()）。 */
  lastAt(): number
  /** 停发 ack（用来验证高水位真的会把读线程按住）。 */
  stopAcking(): void
}

/**
 * 开一条会话并挂上「收数 + 按产品节奏发 ack」的计量器。
 */
async function openMeteredSession(): Promise<Meter> {
  const session = await core.openSession({ cols: 120, rows: 40 })
  openSessions.push(session)

  let bytes = 0
  let lastAt = 0
  let pending = 0
  let acking = true
  session.onData((b) => {
    bytes += b.byteLength
    lastAt = Date.now()
    if (!acking) return
    pending += b.byteLength
    if (pending >= FLOW_ACK_BATCH_BYTES) {
      const n = pending
      pending = 0
      // 不 await：产品里的 AckBatcher 同样是发出去就不等，ack 是反向流控信号，
      // 不在"数据到屏幕"这条链路上。
      void session.ack(n)
    }
  })

  // 等 shell 把提示符打完再灌命令，否则命令会和启动输出交错。
  await waitUntil(() => bytes > 0, 'shell 首批输出', 30_000)
  return {
    session,
    bytes: () => bytes,
    lastAt: () => lastAt,
    stopAcking: () => { acking = false },
  }
}

/** 一轮刷屏的实测结果。 */
interface FloodResult {
  /** 这一轮收到的字节数。 */
  floodBytes: number
  /** 从写下命令到停手经过的毫秒数（含 shell 回显命令、开始刷屏之前那一小段）。 */
  elapsed: number
  /** 人能看懂的一行：灌了多少、多久、多快、跑的哪条命令。断言信息和日志共用。 */
  detail: string
}

/**
 * 灌到**累计够 MIN_FLOOD_BYTES 为止**，或到 FLOOD_TIMEOUT_MS 上限为止。
 *
 * 够了就立刻返回——不多灌一个字节，也不按秒表空等。为什么这么设计见
 * FLOOD_TIMEOUT_MS 上面那段：喂够量和别跑太久是两件事，不该由同一个数字扛。
 *
 * 无论成没成都**打印实测吞吐**：这条链路在 Linux 和 Windows 上差着一个数量级
 * （41 vs 2.3 MiB/s），把每次的实测值留在 CI 日志里，下次谁怀疑"是不是变慢了"
 * 有历史可比，不必再临时加日志重跑一遍。
 *
 * 【读这个数的时候注意】elapsed 从"写下命令"起算，含 shell 回显命令、把
 * `while` 循环转起来那一小段固定开销。Linux 上灌够 8 MiB 只要 300ms 左右，
 * 那点固定开销占比不小，于是打出来是 21~27 MiB/s，比稳态的 41 MiB/s 低——
 * **这是量法造成的，不是性能退化**。要横向比，比同一平台的历史值。
 */
async function floodUntilEnough(m: Meter): Promise<FloodResult> {
  const before = m.bytes()
  const t0 = Date.now()
  m.session.write(new TextEncoder().encode(FLOOD_COMMAND))

  let floodBytes = 0
  let elapsed = 0
  for (;;) {
    floodBytes = m.bytes() - before
    elapsed = Date.now() - t0
    if (floodBytes >= MIN_FLOOD_BYTES || elapsed >= FLOOD_TIMEOUT_MS) break
    await new Promise((r) => setTimeout(r, 20))
  }

  const mibPerSec = floodBytes / 1024 / 1024 / (elapsed / 1000)
  const detail =
    `实测灌入 ${(floodBytes / 1024 / 1024).toFixed(1)} MiB / ${elapsed}ms ` +
    `= ${mibPerSec.toFixed(1)} MiB/s` +
    // 把刷屏命令原文一并带上：这条判据红过一次，而当时唯一缺的信息就是
    // "从端到底在跑什么"。有了它，"是命令太慢"还是"是我们这条链路太慢"
    // 下一轮不用再猜（Windows 上这两者的量级差了两个数量级）。
    `；刷屏命令：${JSON.stringify(FLOOD_COMMAND)}`
  console.log(`  刷屏吞吐（${process.platform}）：${detail}`)

  return { floodBytes, elapsed, detail }
}

test('刷屏不假死：真 shell 全速灌数据，背压全程没有降级', async () => {
  const m = await openMeteredSession()
  const stallsBefore = stallEvents.length

  const { floodBytes, elapsed, detail } = await floodUntilEnough(m)

  await m.session.signalInt()
  await new Promise((r) => setTimeout(r, 500))

  // 只有"到了上限还没灌够"才判不作数——而不是"3 秒内没灌够"。慢机器只是慢，
  // 不等于 shell 没在刷屏；把这两者混为一谈正是这条判据以前随机红的原因。
  expect(
    floodBytes,
    `${detail}——灌到 ${elapsed}ms 上限（${FLOOD_TIMEOUT_MS}ms）仍不够 ` +
    `${MIN_FLOOD_BYTES / 1024 / 1024} MiB，shell 根本没在刷屏，这一轮压测不作数`,
  ).toBeGreaterThanOrEqual(MIN_FLOOD_BYTES)

  // 核心判据：全程一次 flow_stalled 都不该有。
  // 这个事件的含义是"核心等了整整一个看门狗周期都没等到 ack，只好放弃背压"——
  // 它一旦出现，说明这条链路是靠**降级**扛住刷屏的，那 1MiB/256KiB 这对水位
  // 就没有被验证，反而是被绕过去了。吞吐再漂亮也不能给它背书。
  const newStalls = stallEvents.slice(stallsBefore)
  expect(newStalls, `${detail}，但期间报了 ${newStalls.length} 次流控停摆自愈：` +
    `${JSON.stringify(newStalls)}。这说明背压是被看门狗强行清零撑过去的，不是水位起了作用`)
    .toHaveLength(0)
}, 120_000)

test(`刷屏中断：发出中断后 ${INTERRUPT_DEADLINE_MS}ms 内必须停下来`, async () => {
  const m = await openMeteredSession()

  // 前置条件跟上一条测试一样：先真的把刷屏压到稳态，再谈"中断得快不快"。
  // 上一轮 CI 里这条测试红，红的也是这个前置条件（固定 3 秒喂不够 8 MiB），
  // 跟中断本身无关——所以这里一并改成"灌够为止"。
  // 【注意 1000ms 这条线一个毫秒都没放宽】它来自产品第②条，不是调出来的，
  // Linux 上实测 2ms 就停了，余量大得很，没有任何放宽的理由。
  const { floodBytes, elapsed, detail } = await floodUntilEnough(m)

  const bytesAtInterrupt = m.bytes()
  expect(
    floodBytes,
    `中断之前没能把刷屏压起来（${detail}，灌了 ${elapsed}ms 到上限 ` +
    `${FLOOD_TIMEOUT_MS}ms），这条测试没有意义`,
  ).toBeGreaterThanOrEqual(MIN_FLOOD_BYTES)

  const t0 = Date.now()
  await m.session.signalInt()

  // 等到「连续 QUIET_MS 没有新数据」，把最后一次收到数据的时刻当作停下来的时刻。
  await waitUntil(
    () => Date.now() - m.lastAt() > QUIET_MS,
    '刷屏停止',
    INTERRUPT_DEADLINE_MS + QUIET_MS + 5_000,
  )
  const stoppedAfterMs = m.lastAt() - t0

  expect(
    stoppedAfterMs,
    `中断发出后又过了 ${stoppedAfterMs}ms 才收到最后一个字节` +
    `（中断后又收了 ${m.bytes() - bytesAtInterrupt} 字节）。` +
    '产品第②条要求刷屏中断 1 秒内停止。',
  ).toBeLessThan(INTERRUPT_DEADLINE_MS)
}, 120_000)

test('高水位真的会把读线程按住，看门狗按期兜底——不是一段死代码', async () => {
  // 这条是前两条的**反证**：上面两条都绿，可能是因为 ack 一直跟得上、水位从来
  // 没被碰到过——那样"水位管用"这个结论依然没有证据。这里刻意把 ack 掐掉，
  // 让未确认字节数一路涨过高水位，看核心是不是真的按设计停下来了。
  const m = await openMeteredSession()
  m.stopAcking()

  const before = m.bytes()
  const stallsBefore = stallEvents.length
  m.session.write(new TextEncoder().encode(FLOOD_COMMAND))

  // 等读线程停住：不发 ack 的话，收到的字节数会卡在高水位附近不动。
  await waitUntil(() => Date.now() - m.lastAt() > QUIET_MS && m.bytes() > before,
    '读线程因高水位停下来', 30_000)
  const pausedAt = m.bytes() - before

  // 判据用区间而不是等值：读线程是"读满一个缓冲区再检查水位"，所以实际停住的
  // 位置必然略高于高水位一点（多出的量以 READ_BUFFER_BYTES 为界），卡死一个
  // 精确值只会让这条测试变成脆皮。
  expect(
    pausedAt,
    `不发 ack 时读线程停在 ${pausedAt} 字节，高水位是 ${FLOW_HIGH_WATER_BYTES} 字节。` +
    '差得太远说明高水位根本没生效——那 shell 全速刷屏时内存会一路涨上去。',
  ).toBeGreaterThanOrEqual(FLOW_HIGH_WATER_BYTES)
  expect(pausedAt).toBeLessThan(FLOW_HIGH_WATER_BYTES * 2)

  // 再等看门狗：ack 一直不来，核心应当在一个 FLOW_PAUSE_STALL_TIMEOUT_MS 周期后
  // 强制清零未确认窗口并把这件事**报出来**（绝不允许静默自愈）。
  await waitUntil(() => stallEvents.length > stallsBefore, '流控停摆自愈事件',
    FLOW_PAUSE_STALL_TIMEOUT_MS * 3)
  const ev = stallEvents[stallsBefore]
  expect(ev.stalledMs, '上报的停摆时长应当就是配置的看门狗周期')
    .toBe(FLOW_PAUSE_STALL_TIMEOUT_MS)
  expect(ev.unacknowledgedBytes, '被强制丢弃的未确认字节数应当在高水位量级')
    .toBeGreaterThanOrEqual(FLOW_HIGH_WATER_BYTES)

  await m.session.signalInt()
}, 120_000)

async function waitUntil(pred: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`等待「${what}」超时（${timeoutMs}ms）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
