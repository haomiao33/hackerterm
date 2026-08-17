/**
 * 量「流控暂停期间的 CPU 开销」——**条件变量 vs 自旋轮询**的对照测量。
 *
 * ── 为什么需要这个脚本 ──────────────────────────────────────────────────
 *
 * 上一轮把读线程的流控等待从 `while !should_resume() { sleep(2ms) }` 改成了
 * `Condvar::wait_timeout`，理由写的是「10+ 并发会话时每个线程每秒醒 500 次」。
 * 那是个**推算**，不是实测：改动合入时手头根本没有 10+ 并发会话的场景，
 * 数字是纸上算出来的。
 *
 * 并发测试（concurrency-core.e2e.ts）是这个改动**唯一能拿到真实证据**的场合——
 * 只有真的把 12 条会话同时按到高水位上，那 6000 次/秒的无效唤醒才真实存在。
 * 所以这里单独做一个对照测量：同一台机器、同一个负载，只换 `wait_for_resume`
 * 一处实现，看 CPU 差多少。
 *
 * ── 怎么把读线程**按在暂停状态**上 ──────────────────────────────────────
 *
 * 读线程只有在"未确认字节数 ≥ 高水位"时才会进入 `wait_for_resume`。所以：
 *   开 N 条会话 → 全部全速刷屏 → **一条 ack 都不发** → 未确认量一路涨过高水位
 *   → 所有读线程进入暂停等待。
 *
 * 注意此时 5 秒的停摆看门狗会周期性开火（`session.flow_stalled`），强制清零窗口、
 * 读线程醒来读一批、再次撞上高水位、再暂停。也就是说测量窗口里是一串
 * 「暂停 5 秒 → 读一下 → 再暂停」的循环，**绝大部分时间都处在暂停态**。
 * 两个版本经历的是同一套循环，所以 CPU 之差可以归到暂停等待的实现上。
 * 报告里会把看门狗事件数一并打出来，好确认两次测量的循环结构确实一样——
 * 结构不一样的话，CPU 差就不能只归给唤醒方式。
 *
 * ── 跑法 ────────────────────────────────────────────────────────────────
 *   pnpm build:native && pnpm measure:flow-wakeup
 *
 * 对照组（自旋轮询）的做法：临时把 `FlowWindow::wait_for_resume` 换成轮询实现
 * （`sleep(2ms)` 一轮，三种结局和停摆判据一字不改）、`pnpm build:native` 重编、
 * 再跑一次本脚本，然后还原。**只换这一个函数**，不整体回退到改动前的提交——
 * 那样会连带把停摆看门狗一起退掉，循环结构就变了，两次测量不再可比。
 *
 * ── 实测结果（Linux 容器，12 条会话，20 秒窗口，两版各跑 3 次）─────────────
 *
 *   实现        CPU 合计（3 次）        占一个核心        窗口内搬运   看门狗周期
 *   条件变量    1998 / 895 / 1027 ms   10.0% / 4.5% / 5.1%   50.5 MiB    48 次
 *   自旋轮询    2773 / 2768 / 2423 ms  13.9% / 13.8% / 12.1%  37.9 MiB    36 次
 *
 * 结论：
 * 1. **CPU 大约降到 1/3**（取各自中位数：1027 vs 2768 ms）。而且这个比较对条件
 *    变量**不利**——它在同一个窗口里还多搬了 33% 的数据（50.5 vs 37.9 MiB），
 *    也就是说它花更少的 CPU 干了更多的活；把搬运成本折算进去，纯"空转唤醒"这
 *    一项的差还要更大。差值 ≈ 1.74 秒 CPU / 20 秒窗口，摊到
 *    12 线程 × 500 次/秒 × 20 秒 = 12 万次无效唤醒上约 **14µs/次**，system 时间
 *    占大头，与十几万次 nanosleep 系统调用的画像一致。
 * 2. **轮询还让停摆看门狗变钝**：同样 20 秒，条件变量版跑满 4 个 5 秒周期
 *    （12×4=48），轮询版只跑了 3 个（12×3=36）——因为它的"等够 5 秒"是拿 2ms
 *    一格累加出来的，每格都比 2ms 长一点，周期就被拖长了。这是个次要成本，
 *    但方向是坏的：故障发现得更慢。三次运行里这两个数字**一次不差**地稳定在
 *    48 / 36，比 CPU 数字本身还硬——它证明两次测量的循环结构确实只差唤醒方式。
 *
 * ── 关于"数字有多硬"的一句实话 ──────────────────────────────────────────
 * 条件变量那三次里第一次（1998ms）明显高于后两次（895 / 1027ms），说明这个容器
 * 上的 CPU 读数受同机负载影响不小，**倍数不要当成精确值**（同一份代码此前一版
 * 注释里写的是"降到 1/5"，本轮六次运行复现不出那个量级，已按实测改写）。
 * 能当结论用的只有方向和量级：轮询版持续更贵、且贵出来的量与"12 万次无效唤醒 ×
 * 十几微秒"对得上。要更硬的数就得上 perf / getrusage 按线程量，那超出本脚本范围。
 */
import { connectCore, type CoreSession } from './core-session'
import { SessionFlowStalledEvent } from '../src/ui/common/protocol/hackerterm'
import { FLOW_HIGH_WATER_BYTES } from './rust-limits'

/** 并发会话数。跟并发测试保持一致：产品要求是「10+」。 */
const SESSIONS = 12

/** 正式测量窗口。要盖住好几个 5 秒看门狗周期，才谈得上稳态。 */
const MEASURE_MS = 20_000

/** 等所有读线程都撞上高水位、进入暂停的上限。 */
const PAUSE_WAIT_TIMEOUT_MS = 30_000

const FLOOD = process.platform === 'win32'
  ? 'while($true){"hackerterm-wakeup-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"}\r'
  : 'yes hackerterm-wakeup-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\r'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  console.log('流控暂停期间的 CPU 开销测量（条件变量 vs 自旋轮询 对照用）')
  console.log(`平台 ${process.platform}，并发会话 ${SESSIONS} 条，测量窗口 ${MEASURE_MS}ms`)
  console.log(`高水位 ${FLOW_HIGH_WATER_BYTES} 字节；本脚本**不发任何 ack**，`
    + '目的就是让所有读线程停在暂停等待上。\n')

  const core = await connectCore()

  let stalls = 0
  core.onEvent('session.flow_stalled', (payload) => {
    SessionFlowStalledEvent.decode(payload)
    stalls += 1
  })

  const sessions: CoreSession[] = []
  const bytes: number[] = new Array<number>(SESSIONS).fill(0)
  for (let i = 0; i < SESSIONS; i++) {
    const s = await core.openSession({ cols: 120, rows: 40 })
    sessions.push(s)
    // 只记账，**不 ack**——这正是把读线程按在高水位上的手段。
    s.onData((b) => { bytes[i] += b.byteLength })
  }

  // 等每条会话的 shell 都吐出第一批输出，确认它们都活着。
  const readyDeadline = Date.now() + 30_000
  while (bytes.some((b) => b === 0) && Date.now() < readyDeadline) await sleep(50)
  if (bytes.some((b) => b === 0)) {
    throw new Error(`有会话的从端始终没有输出，各会话实收：${JSON.stringify(bytes)}`)
  }

  console.log('· 开始刷屏（不发 ack），等所有读线程撞上高水位…')
  for (const s of sessions) s.write(new TextEncoder().encode(FLOOD))

  // "都停下来了"的判据：连续一小段时间里各会话的字节数都不再增长。
  const pauseDeadline = Date.now() + PAUSE_WAIT_TIMEOUT_MS
  let previous = [...bytes]
  let quietRounds = 0
  while (Date.now() < pauseDeadline) {
    await sleep(200)
    const still = bytes.every((b, i) => b === previous[i])
    quietRounds = still ? quietRounds + 1 : 0
    previous = [...bytes]
    if (quietRounds >= 3) break // 连续 600ms 一个字节都没再来 = 都暂停了
  }
  const pausedBytes = bytes.reduce((a, b) => a + b, 0)
  const allPaused = quietRounds >= 3
  console.log(
    `· ${allPaused ? '已全部暂停' : '⚠ 等待超时，未确认全部暂停'}；`
    + `此刻各会话累计收到 ${(pausedBytes / 1024 / 1024).toFixed(1)} MiB，`
    + `每条平均 ${(pausedBytes / SESSIONS / 1024).toFixed(0)} KiB`
    + `（高水位是 ${(FLOW_HIGH_WATER_BYTES / 1024).toFixed(0)} KiB，`
    + '略高是因为读线程"读满一个缓冲区再检查水位"）',
  )

  // ── 正式测量窗口 ──────────────────────────────────────────────────────
  // process.cpuUsage() 统计的是**整个进程**的 user + system CPU 时间，
  // 包含 napi 里那些 Rust 读线程——它们跟 Node 主线程同属一个进程。
  // 这正是我们要的口径：暂停期间那些线程还在不在烧 CPU。
  console.log(`· 测量窗口开始（${MEASURE_MS}ms）…`)
  const stallsAtStart = stalls
  const bytesAtStart = bytes.reduce((a, b) => a + b, 0)
  const cpuBefore = process.cpuUsage()
  const wallBefore = Date.now()
  await sleep(MEASURE_MS)
  const cpu = process.cpuUsage(cpuBefore)
  const wallMs = Date.now() - wallBefore
  const bytesInWindow = bytes.reduce((a, b) => a + b, 0) - bytesAtStart
  const stallsInWindow = stalls - stallsAtStart

  for (const s of sessions) await s.signalInt().catch(() => {})
  for (const s of sessions) await s.close().catch(() => {})

  const userMs = cpu.user / 1000
  const systemMs = cpu.system / 1000
  const totalMs = userMs + systemMs

  console.log('\n── 结果 ─────────────────────────────────────────────────────')
  console.log(`  墙钟          ${wallMs} ms`)
  console.log(`  CPU user      ${userMs.toFixed(1)} ms`)
  console.log(`  CPU system    ${systemMs.toFixed(1)} ms`)
  console.log(`  CPU 合计      ${totalMs.toFixed(1)} ms  `
    + `= 一个核心的 ${((totalMs / wallMs) * 100).toFixed(2)}%`)
  console.log(`  窗口内新增字节 ${(bytesInWindow / 1024 / 1024).toFixed(2)} MiB`
    + '（看门狗每清零一次，读线程就会补读一批；两次对照测量的这个数应当接近）')
  console.log(`  窗口内停摆自愈事件 ${stallsInWindow} 次`
    + `（${SESSIONS} 条会话 × ${MEASURE_MS / 5000} 个 5 秒周期 ≈ `
    + `${SESSIONS * (MEASURE_MS / 5000)} 次；两次对照测量的这个数也应当接近，`
    + '差太多说明循环结构变了，CPU 差就不能只归给唤醒方式）')
  console.log('\n  【怎么读这个数】暂停期间读线程理应**零 CPU**：条件变量把它们睡死，')
  console.log('  只有 ack / close / 看门狗到期才唤醒。自旋轮询版本则是每线程每 2ms 醒')
  console.log(`  一次 = ${SESSIONS} × 500 = ${SESSIONS * 500} 次/秒的纯无效唤醒，`)
  console.log(`  ${MEASURE_MS / 1000} 秒窗口里约 ${SESSIONS * 500 * (MEASURE_MS / 1000)} 次。`)
  console.log('  两个版本的差值就是这个改动买到的东西。')
  console.log(`\nFLOW_WAKEUP_JSON ${JSON.stringify({
    sessions: SESSIONS, wallMs, userMs, systemMs, totalMs,
    cpuPercentOfOneCore: (totalMs / wallMs) * 100,
    bytesInWindow, stallsInWindow, allPaused,
  })}`)
}

main().then(
  () => {
    // 同 latency.ts：ht-node 的 Core 是 Rust 侧 OnceLock 全局，事件循环不会自然清空。
    process.exit(0)
  },
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
