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

/**
 * 无限刷屏的命令。两个平台各自选一条**不依赖任何外部程序**的：
 * - 类 Unix：`yes` 是 coreutils，任何发行版都有。
 * - Windows：PowerShell 的 `while($true){...}`，不用 `yes`（Windows 上没有这个
 *   命令，这正是 CI 里 verify job 常年飘红的原因之一）。
 */
const FLOOD_COMMAND = process.platform === 'win32'
  ? 'while($true){"hackerterm-flood-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"}\r'
  : 'yes hackerterm-flood-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\r'

/** 刷屏持续时长。够长到稳态、又不至于让 CI 白等。 */
const FLOOD_MS = 3_000

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

/** 一次压测至少要灌进来多少字节才算数。低于这个量说明 shell 压根没在刷屏。 */
const MIN_FLOOD_BYTES = 8 * 1024 * 1024

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

test('刷屏不假死：真 shell 全速灌数据，背压全程没有降级', async () => {
  const m = await openMeteredSession()
  const before = m.bytes()
  const stallsBefore = stallEvents.length

  const t0 = Date.now()
  m.session.write(new TextEncoder().encode(FLOOD_COMMAND))
  await new Promise((r) => setTimeout(r, FLOOD_MS))
  const floodBytes = m.bytes() - before
  const elapsed = Date.now() - t0

  await m.session.signalInt()
  await new Promise((r) => setTimeout(r, 500))

  const mibPerSec = floodBytes / 1024 / 1024 / (elapsed / 1000)
  const detail =
    `实测灌入 ${(floodBytes / 1024 / 1024).toFixed(1)} MiB / ${elapsed}ms ` +
    `= ${mibPerSec.toFixed(1)} MiB/s`

  expect(floodBytes, `${detail}——数据量太小，shell 根本没在刷屏，这一轮压测不作数`)
    .toBeGreaterThan(MIN_FLOOD_BYTES)

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
  m.session.write(new TextEncoder().encode(FLOOD_COMMAND))
  await new Promise((r) => setTimeout(r, FLOOD_MS))

  const bytesAtInterrupt = m.bytes()
  expect(bytesAtInterrupt, '中断之前根本没在刷屏，这条测试没有意义')
    .toBeGreaterThan(MIN_FLOOD_BYTES)

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
