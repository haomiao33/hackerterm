/**
 * 丝滑压测（产品第②条核心要求）里**渲染层**那一半：页面在刷屏时不假死、
 * 解析器吃到二进制垃圾不崩。
 *
 * 和 e2e/flood-core.e2e.ts 的分工：
 * - flood-core 灌的是**真 shell 的输出**，检验 Rust 侧的高低水位、ack 批量、
 *   停摆看门狗，跑在普通 Node 进程里（Linux 上 Electron 里起不了 shell）。
 * - 这个文件灌的是**走完整 IPC 往返的字节**，检验的是渲染进程：主线程会不会
 *   被刷屏卡住、xterm 的解析器会不会被畸形字节搞挂。判据全在页面这一侧。
 *
 * 数据怎么来：**两个平台不一样**，这是本文件最需要解释的一点。
 *
 * ── 类 Unix：靠内核行规程的回显 ──────────────────────────────────────
 * 从渲染进程 `term.input()` 往 PTY 写字节，行规程把同样的字节原路送回来。
 * 这条回路完整经过：xterm onData → 数据面 MessagePort（渲染 → utility）→
 * core-host → napi → Rust → PTY 主端 → 行规程回显 → Rust 读线程 → napi →
 * core-host → 数据面 MessagePort（utility → 渲染）→ xterm write。压的是
 * **我们自己写的每一段**，不需要 shell 参与——这很重要，因为 Linux 上 Electron
 * 进程内根本 fork 不出 shell（见 electron-app.ts 的 FD_OWNERSHIP_CRASH_MARKER）。
 *
 * 实测出来的两条边界（决定了下面那些常量的取值，不是拍的）：
 * - 灌进去的数据**不能带换行**。带 `\r` 时行规程把整行送进 tty 的规范模式读
 *   队列，而从端没有任何进程在读，队列 4KB 就满，之后字节被直接丢掉：实测
 *   写 256KiB 只回来 1350 字节（0.5%）。不带换行时回显是 1:1 的。
 * - 单次突发也有上限：一口气灌 4MiB 只回来约 1.02MiB，正好卡在流控高水位
 *   附近——读线程按住之后 tty 那头的输出队列没人取，回显就被丢了。所以下面
 *   采用**尊重背压的灌法**：回显没追上就不发下一块，这样才能持续压进几 MiB。
 *
 * ── Windows：让真 shell 自己刷屏，**绝不能**照搬回显那一套 ─────────────
 * Windows 上 Electron 里 shell 是正常起来的，于是"往 PTY 灌几 MiB 字符"就变成
 * 了"往 PowerShell 的命令行里敲几 MiB 字符"——而 PSReadLine 是个全功能行编辑器，
 * 每来一个字符都要重排、重绘整条命令行，几 MiB 会让它卡到天荒地老，测出来的
 * "假死"是 PSReadLine 的，不是我们的。所以 Windows 上改成敲一条**短命令**，
 * 让 shell 自己把几 MiB 输出打出来——这既避开了那个陷阱，也更接近用户真实会
 * 遇到的刷屏（`cat 大文件`、`npm install` 刷日志）。
 */
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { ElectronApplication, Page } from 'playwright-core'
import { consoleLog, launchApp, MOUNT_TIMEOUT_MS, readScreen } from './electron-app'

/** 一轮压测总共要灌进去多少字节。 */
const FLOOD_BYTES = 4 * 1024 * 1024
/** 每次 `term.input()` 的块大小。 */
const FLOOD_CHUNK_BYTES = 32 * 1024
/** 未回显的在途字节数上限：超过它就等回显追上来再继续灌（见文件头的实测说明）。 */
const IN_FLIGHT_LIMIT_BYTES = 256 * 1024

/** 有没有真 shell 可用。Linux 上 Electron 里没有（见文件头），Windows 上有。 */
const HAS_REAL_SHELL = process.platform === 'win32'

/**
 * Windows 上让 shell 自己刷屏的命令：约 5 万行 × 80 字符 ≈ 4 MiB。
 * 用有限循环而不是 `while($true)`——这条测试要的是"灌完一批看页面卡没卡"，
 * 不是无限流；无限流还得再管怎么停，白白多一处不确定性。
 */
const SHELL_FLOOD_COMMAND =
  `1..50000 | %{"${'F'.repeat(79)}"}\r`

/** 判定"这一轮真的压出数据了"的下限。 */
const MIN_RECEIVED_BYTES = FLOOD_BYTES / 2

/**
 * 刷屏期间允许的单次主线程无响应时长上限（毫秒）。
 *
 * 来源：实测值 + 余量。本机无头环境下 `page.evaluate(() => 1)` 的往返在刷屏
 * 期间 p95 约 23ms、最大 25ms（不刷屏时 3ms 量级）。取 500ms 当阈值：它比实测
 * 高一个数量级，不会因为 CI 机器慢就误报；同时又远低于人对"卡住了"的感知
 * （几百毫秒起），真出现假死一定拦得住。
 */
const MAX_MAIN_THREAD_STALL_MS = 500

/** 响应性探针的采样间隔。 */
const PROBE_INTERVAL_MS = 20

let app: ElectronApplication
let page: Page

beforeAll(async () => {
  ({ app, page } = await launchApp())
  // 入向字节计数器：包在 term.write 外面，量的是**真的送到 xterm 手里**的字节，
  // 而不是我们以为发出去了多少。灌数据时的背压判断全靠它。
  await page.evaluate(() => {
    const w = window as unknown as { __rx: number }
    w.__rx = 0
    const term = window.__htDiagnostics!.term
    const original = term.write.bind(term)
    ;(term as unknown as { write: unknown }).write = (
      data: string | Uint8Array, cb?: () => void,
    ) => {
      w.__rx += typeof data === 'string' ? data.length : data.byteLength
      return original(data as Uint8Array, cb)
    }
  })
}, MOUNT_TIMEOUT_MS + 30_000)

afterAll(async () => {
  await app?.close()
})

/**
 * 在一段时间内持续量「渲染进程主线程还答不答应」。
 *
 * 判据用 `page.evaluate(() => 1)` 的往返时间：它要排进渲染进程主线程的任务
 * 队列才能返回，主线程被刷屏占满时这个往返就会拉长。这比"页面还在不在"强得多
 * ——假死的页面进程也还在，元素也都还在，只是不干活了。
 */
function startResponsivenessProbe(): { stop: () => Promise<number[]> } {
  const samples: number[] = []
  let running = true
  const loop = (async () => {
    while (running) {
      const t0 = Date.now()
      await page.evaluate(() => 1).catch(() => { /* 关闭竞态，忽略 */ })
      samples.push(Date.now() - t0)
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS))
    }
  })()
  return {
    stop: async () => { running = false; await loop; return samples },
  }
}

/** 读一次入向字节计数器。 */
async function receivedBytes(): Promise<number> {
  return page.evaluate(() => (window as unknown as { __rx: number }).__rx)
}

/**
 * 等入向字节不再增长。
 *
 * 放在 Node 侧而不是页面里，是刻意的：这段循环要是跑在页面主线程上，它自己
 * 就成了主线程的负载，"页面卡不卡"的测量会被测量动作本身污染。放在外面轮询，
 * 顺便和响应性探针共用同一条观察通道。
 */
async function settleReceived(rx0: number): Promise<number> {
  let last = -1
  let stable = 0
  // Windows 上 shell 要先起管道再产出，上限给到 60s。
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    const rx = await receivedBytes()
    // 连续 8 次（约 800ms）不涨就算收敛。
    if (rx === last) { if (++stable >= 8) break } else stable = 0
    last = rx
  }
  return last - rx0
}

/**
 * 类 Unix：分块把字节灌进 PTY，靠行规程回显压满整条链路。
 *
 * 只负责**发**，等收敛交给外面的 settleReceived。
 */
async function floodByEcho(): Promise<number> {
  return page.evaluate(async ([total, chunkBytes, inFlightLimit]) => {
    const term = window.__htDiagnostics!.term
    const w = window as unknown as { __rx: number }
    const rx0 = w.__rx
    // 刻意**不含换行**：带换行的话行规程会把数据送进从端读队列，而从端没有
    // 进程在读，4KB 之后字节被直接丢弃（见文件头）。
    const chunk = 'x'.repeat(chunkBytes)
    let sent = 0
    while (sent < total) {
      term.input(chunk, false)
      sent += chunkBytes
      // 尊重背压：在途字节太多就先等回显追上来。这既是为了不被 tty 丢数据，
      // 也更贴近真实场景——真实的刷屏源同样是被流控按着走的。
      const deadline = Date.now() + 10_000
      while (sent - (w.__rx - rx0) > inFlightLimit && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4))
      }
    }
    return sent
  }, [FLOOD_BYTES, FLOOD_CHUNK_BYTES, IN_FLIGHT_LIMIT_BYTES] as const)
}

/**
 * Windows：敲一条短命令，让真 shell 自己把几 MiB 输出打出来。
 * **不要**改成往命令行里灌几 MiB 字符，理由见文件头（PSReadLine 会被压垮，
 * 测出来的假死是它的不是我们的）。
 */
async function floodByShellOutput(): Promise<number> {
  await page.evaluate((command) => {
    window.__htDiagnostics!.term.input(command, false)
  }, SHELL_FLOOD_COMMAND)
  // 命令本身只有几十字节，"灌入量"对这条路径没有意义，返回 0 并在报告里说明。
  return 0
}

test('刷屏不假死：数 MiB 走完整 IPC 往返，主线程全程还答应', async () => {
  const rx0 = await receivedBytes()
  const probe = startResponsivenessProbe()
  const sent = HAS_REAL_SHELL ? await floodByShellOutput() : await floodByEcho()
  const received = await settleReceived(rx0)

  const samples = await probe.stop()
  samples.sort((a, b) => a - b)
  const p95 = samples[Math.floor(samples.length * 0.95)]
  const max = samples[samples.length - 1]
  const detail =
    `数据源=${HAS_REAL_SHELL ? '真 shell 输出' : '行规程回显'}，` +
    `灌入 ${sent} 字节、收到 ${received} 字节；主线程响应 ${samples.length} 次采样，` +
    `p95=${p95}ms max=${max}ms`

  // 先确认这一轮真的压出了数据量——否则下面"没卡住"的结论毫无意义
  // （一个字节都没走的链路当然不卡）。
  expect(received, `${detail}——收到的数据量太小，这一轮根本没压上去`)
    .toBeGreaterThan(MIN_RECEIVED_BYTES)

  expect(max, `${detail}。刷屏期间主线程被占住超过 ${MAX_MAIN_THREAD_STALL_MS}ms，` +
    '这就是用户会直接感知到的"卡住了"').toBeLessThan(MAX_MAIN_THREAD_STALL_MS)

  // 刷屏结束后终端必须还能用：再灌一个标记，它得出现在屏幕上。
  await page.evaluate(() => {
    const term = window.__htDiagnostics!.term
    term.reset()
    term.write('HT-FLOOD-SURVIVED')
  })
  const lines = await readScreen(page)
  expect(lines.some((l) => l.includes('HT-FLOOD-SURVIVED')),
    '刷屏之后终端不再接受写入了').toBe(true)
}, 180_000)

test('二进制垃圾：随机字节 + 畸形转义序列，解析器不崩、终端仍可用', async () => {
  const pageErrorsBefore = consoleLog(page).filter((l) => l.startsWith('[pageerror]')).length

  await page.evaluate(async () => {
    const term = window.__htDiagnostics!.term

    // 1) 纯随机字节。crypto.getRandomValues 单次上限 65536 字节，所以分块填。
    const random = new Uint8Array(512 * 1024)
    for (let off = 0; off < random.length; off += 65536) {
      crypto.getRandomValues(random.subarray(off, Math.min(off + 65536, random.length)))
    }
    await new Promise<void>((res) => term.write(random, () => res()))

    // 2) 专门挑刺的畸形序列。随机字节大概率撞不上这些形状，而它们恰恰是
    //    解析器状态机最容易漏状态的地方：孤立 ESC、没有终止符的 CSI、
    //    参数超长的 CSI、没闭合的 OSC、半截 DCS、裸 C1 控制字符、
    //    非法 UTF-8 续字节。
    const malformed = [
      '\x1b',
      '\x1b[',
      '\x1b[999999999;999999999;999999999H',
      '\x1b[38;2;',
      '\x1b]0;title-without-terminator',
      '\x1bP+q',
      '\x9b\x90\x9c\x9d',
      '\xc3\x28\xa0\xa1\xe2\x28\xa1\xf0\x28\x8c\x28',
      '\x1b[?1049h\x1b[?1049l'.repeat(200),
    ].join('')
    await new Promise<void>((res) => term.write(malformed, () => res()))
  })

  // 终端还活着吗：复位之后写一个标记，它必须出现在屏幕缓冲区里。
  // 判据必须落在**屏幕上真的出现了字符**——"没抛异常"是假判据，本项目的
  // 故障没有一个是抛异常的。
  await page.evaluate(async () => {
    const term = window.__htDiagnostics!.term
    term.reset()
    await new Promise<void>((res) => term.write('HT-GARBAGE-SURVIVED', () => res()))
  })
  const lines = await readScreen(page)
  const pageErrorsAfter = consoleLog(page).filter((l) => l.startsWith('[pageerror]')).length

  expect(lines.some((l) => l.includes('HT-GARBAGE-SURVIVED')),
    `二进制垃圾之后终端写不进去了。屏幕内容：\n${lines.filter((l) => l).slice(0, 10).join('\n')}`)
    .toBe(true)

  expect(pageErrorsAfter, '渲染进程在解析二进制垃圾时抛了未捕获异常')
    .toBe(pageErrorsBefore)

  // 页面还在（没崩溃重载）：崩溃时 Playwright 会在 console 收集器里留下记录。
  expect(consoleLog(page).some((l) => l.startsWith('[crash]')),
    '渲染进程崩溃了').toBe(false)
}, 180_000)
