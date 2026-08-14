/**
 * 钉死时延测量的**配对逻辑**：只有真按键才算一次往返。
 *
 * 为什么值得单独一个端到端测试：时延数字是要拿来做投入决策的（"IPC 还值不值得
 * 优化"），一个配对错了的测量脚本给出的是**看着合理、其实是别的东西**的数字，
 * 比没有数字更糟。旧实现就是这么错的——它拿"任意一次 term.onData"当按键时刻，
 * 而 xterm 的自动回复（光标位置报告 CPR：收到 `ESC[6n` 就回一条 `ESC[行;列R`；
 * PSReadLine 每次重绘都会问）走的也是 onData。于是"自动回复 → 下一块数据"这种
 * 天然极短的区间被记成了按键往返，Windows CI 上 60 次按键量出 61 个样本，
 * 而 FULL 段（父集）的 p95 反而比 PTY 段（子集）小一个数量级。
 *
 * ── 这一轮改了什么，为什么（Windows 硬门禁红掉之后）────────────────────────
 *
 * 这条测试在 Windows CI 上红了，暴露出两个**互相独立**的问题：
 *
 * 1. **非按键 onData 不止 CPR 一种。** 实测日志里先来 `ESC[I`（焦点进入上报，
 *    DEC 私有模式 1004），再来 `ESC[1;1R`（CPR）。上一轮只想着 CPR，等于在打
 *    补丁堵已知的那一两种；下次 PSReadLine 问一次 DA2 又会重来。
 *    修法：判据改成**类级**的——xterm 所有自动回复都是 ANSI 控制序列，一律以
 *    ESC(0x1b) 开头，而按键是可打印字符。完整名单和依据见 latency-probe.ts 里
 *    `classifyNonKey` 的注释（是读 @xterm/xterm 6 源码列出来的，不是猜的）。
 *
 * 2. **「按了键就一定有回显」这个前提在 Windows 冷启动下不成立。** 日志显示
 *    +890ms 敲下 'x' 之后再没有任何数据——PowerShell + PSReadLine 那时还没起来，
 *    提示符都没打出来。原来的代码靠一个固定 500ms 静置就直接开始采样，那是在赌
 *    shell 已经就绪。
 *    修法：把"等固定时长"换成**探测性往返**——反复按键直到真的收到一次回显，
 *    确认回显通路活了才开始正式采样（`waitForEchoPath`）。这是个判据，不是延时，
 *    机器快就早点开始、机器慢就多等一会儿，两边都不用调参。
 *
 * ── 为什么这条测试要在 Linux **和** Windows 上都跑 ────────────────────────
 * 焦点上报 `ESC[I` 只有真 PowerShell 在回路里才会发（Linux 上 Electron 里的 PTY
 * 子进程根本 exec 不起来，没有 shell 去开模式 1004）。也就是说，**正是"多余地"
 * 在 Windows 上也跑了这条平台无关的测试，才暴露出配对逻辑的真实缺口。**
 * 所以它留在 Windows 门禁里。
 * 同时，下面「焦点上报」那一节用 `ESC[?1004h` + blur/focus 在**本地**把同一条
 * 路径造了出来：Windows 上才会自然发生的事，Linux 上也能确定性复现，不必等一次
 * CI 才知道有没有修好。
 */
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { ElectronApplication, Page } from 'playwright-core'
import { launchApp, MOUNT_TIMEOUT_MS, readDiagnosticLog } from './electron-app'
import { installLatencyProbeOn, type LatencyProbeSnapshot } from './latency-probe'

/** 每轮往 PTY 写的那个可打印字符。 */
const KEY = 'x'
/** 一轮往返的等待上限，跟测量脚本用同一个量级即可。 */
const ROUNDTRIP_TIMEOUT_MS = 2_000
/**
 * 自动回复阶段之后的静置时长。CPR 的回复会被真的写进 PTY，从端再把那批字节
 * 回显回来，也会触发 term.write。等它彻底走完再进入下一阶段，各阶段才不会互相
 * 污染（500ms 对一次亚毫秒往返来说是三个数量级的余量）。
 */
const QUIESCE_MS = 500

/**
 * 等回显通路活过来的总上限。
 *
 * 为什么给到 90 秒：Windows runner 上要等的是 ConPTY 起 conhost + PowerShell 启动
 * + PSReadLine 加载，冷启动叠加 Defender 实时扫描，实测能到几十秒（同一台机器上
 * `main:fork_call → main:core_spawn` 曾经量到 81 秒）。这个数字只是**上限**，
 * 不是固定等待——通路一活立刻往下走，Linux 上通常一两百毫秒就过了。
 */
const ECHO_READY_TIMEOUT_MS = 90_000

/** 两次探测之间的间隔。探测本身要等一个 ROUNDTRIP_TIMEOUT_MS，不用再急。 */
const ECHO_PROBE_GAP_MS = 250

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let app: ElectronApplication
let page: Page
let readiness: { ok: boolean, attempts: number, elapsedMs: number }
let afterQuery: LatencyProbeSnapshot
let afterFocus: LatencyProbeSnapshot
let afterKey: LatencyProbeSnapshot

/**
 * 反复做**探测性往返**，直到真的收到一次回显——「回显通路活了」的判据。
 *
 * 为什么不是"等提示符出现"：那要求测试知道每个 shell 的提示符长什么样
 * （PowerShell 是 `PS C:\...>`，bash 是 `$`，还能被用户 profile 改成任意样子），
 * 而且 Linux 上 Electron 里压根没有 shell、永远等不到提示符。"按一个键、看它回不
 * 回来"直接量的就是本测试真正依赖的那条通路，跟 shell 是谁、提示符长什么样无关。
 *
 * 探测轮次会把计数器记花（失败的轮记 unpaired），所以调用方必须在这之后 `reset()`。
 */
async function waitForEchoPath(): Promise<{ ok: boolean, attempts: number, elapsedMs: number }> {
  const started = Date.now()
  let attempts = 0
  while (Date.now() - started < ECHO_READY_TIMEOUT_MS) {
    attempts += 1
    await page.evaluate(() => { window.__htLatency!.arm() })
    await page.keyboard.press(KEY)
    if (await page.evaluate(() => window.__htLatency!.waitArmed())) {
      return { ok: true, attempts, elapsedMs: Date.now() - started }
    }
    await sleep(ECHO_PROBE_GAP_MS)
  }
  return { ok: false, attempts, elapsedMs: Date.now() - started }
}

/**
 * 一批**终端查询**，逐条写进 xterm，每条都会让 xterm 自动回复一次（走 onData）。
 *
 * 刻意不只发 CPR：本轮的教训就是"只堵已知的那一两种"。这里把 xterm 会应答的几大
 * 类都发一遍，验证的是那条**类级判据**（以 ESC 开头即上报）真的把它们全接住了，
 * 而不是某几条被单独 hardcode 了。
 *
 * 用 fromCharCode(27) 拼而不是写字面转义符：这些字符串会被序列化后丢进页面重新
 * 求值，源码里放一个裸的 ESC 字节谁也看不见，改坏了也不知道。
 */
const TERMINAL_QUERIES: { name: string, seq: string }[] = [
  { name: 'DSR 6 / CPR（光标位置，PSReadLine 每次重绘都问）', seq: '[6n' },
  { name: 'DSR 5（工作状态）', seq: '[5n' },
  { name: 'DECXCPR（带页码的光标位置）', seq: '[?6n' },
  { name: 'DA1（主设备属性）', seq: '[c' },
  { name: 'DA2（次设备属性）', seq: '[>c' },
  { name: '窗口操作 CSI 18t（问行列数）', seq: '[18t' },
]

beforeAll(async () => {
  ({ app, page } = await launchApp())
  await installLatencyProbeOn(page, { key: KEY, timeoutMs: ROUNDTRIP_TIMEOUT_MS })

  // ── 就绪门 ────────────────────────────────────────────────────────────
  // 先确认"按键 → 回显"这条通路真的活了，再开始任何采样。Windows 冷启动下
  // PowerShell 可能要几十秒才就绪，此前的固定 500ms 静置在那种机器上必然踩空。
  readiness = await waitForEchoPath()

  // 探测阶段往 shell 的命令行上敲了若干个 'x'。发一次 Ctrl+C 把这行取消掉，
  // 让后面几个阶段面对的是一个干净的提示符（PSReadLine 行内容越长，重绘时
  // 发的查询越多，噪声越大）。
  // **必须在 reset() 之前做**：Ctrl+C 送出的 0x03 自己也是一条非按键 onData，
  // 而且它不以 ESC 开头，会把下面那条"所有非按键 onData 都是终端上报"的断言
  // 弄成假红——那条断言的前提是这一阶段我们只发查询、不按别的键。
  await page.keyboard.press('Control+C')
  await sleep(QUIESCE_MS)
  await page.evaluate(() => { window.__htLatency!.reset() })

  // ── 阶段一：终端查询的自动回复 ────────────────────────────────────────
  // 开一轮，然后**不按键**，只往终端里塞一批查询——正是 PSReadLine 每次重绘会
  // 做的事。xterm 会自动回复，回复走 onData。
  await page.evaluate(() => { window.__htLatency!.arm() })
  for (const q of TERMINAL_QUERIES) {
    await page.evaluate(
      (seq) => { window.__htDiagnostics!.term.write(String.fromCharCode(27) + seq) },
      q.seq,
    )
  }
  await sleep(QUIESCE_MS)
  afterQuery = await page.evaluate(() => window.__htLatency!.snapshot())
  await page.evaluate(() => { window.__htLatency!.reset() })

  // ── 阶段二：焦点上报（Windows CI 上真实红掉的那一条）──────────────────
  // `ESC[?1004h` 打开 DEC 私有模式 1004（焦点上报）。之后 xterm 的 textarea 每次
  // 失焦/获焦都会自动发 `ESC[O` / `ESC[I`——真 PowerShell 会自己开这个模式，
  // 所以 Windows 上它自然发生；这里手动开一次，把同一条路径在 Linux 上也造出来。
  await page.evaluate(() => { window.__htDiagnostics!.term.write(String.fromCharCode(27) + '[?1004h') })
  await sleep(QUIESCE_MS)
  await page.evaluate(() => { window.__htLatency!.arm() })
  await page.evaluate(() => {
    const term = window.__htDiagnostics!.term
    term.blur()
    term.focus()
  })
  await sleep(QUIESCE_MS)
  afterFocus = await page.evaluate(() => window.__htLatency!.snapshot())
  // 关掉焦点上报，免得它继续污染下面的按键阶段。
  await page.evaluate(() => { window.__htDiagnostics!.term.write(String.fromCharCode(27) + '[?1004l') })
  await sleep(QUIESCE_MS)
  await page.evaluate(() => { window.__htLatency!.reset() })

  // ── 阶段三：真按一个键，这一次必须记到样本 ────────────────────────────
  await page.evaluate(() => { window.__htLatency!.arm() })
  await page.keyboard.press(KEY)
  await page.evaluate(() => window.__htLatency!.waitArmed())
  afterKey = await page.evaluate(() => window.__htLatency!.snapshot())
}, MOUNT_TIMEOUT_MS + ECHO_READY_TIMEOUT_MS + 60_000)

afterAll(async () => {
  await app?.close()
})

test('就绪门：开始采样之前，「按键 → 回显」这条通路必须先被证明是活的', async () => {
  // 这条断言本身就是上一轮 Windows 故障的正面表达：那次 'x' 敲下去之后再没有任何
  // 数据回来，而测试却已经在采样了。现在采样之前必须先过这一关，过不去就明确说
  // "回显通路没活过来"，而不是含糊地报"样本数不对"。
  expect(
    readiness.ok,
    `等了 ${readiness.elapsedMs}ms、探测了 ${readiness.attempts} 轮，`
    + `始终没有一次按键回显回来——从端（shell / 行规程）没有就绪。`
    + `诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toBe(true)
})

test('xterm 的自动回复确实会触发 onData——旧配对逻辑多出样本的机制是真实存在的', async () => {
  expect(
    afterQuery.nonKeyOnData,
    `写了 ${TERMINAL_QUERIES.length} 条终端查询之后没有观察到任何非按键 onData。`
    + `诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toBeGreaterThan(0)
})

test('自动回复不产生样本：一轮开着但没按键时，收到数据也不许记账', async () => {
  expect(
    afterQuery.samples,
    `不该有样本，实际拿到 ${JSON.stringify(afterQuery.samples)}。`
    + `观察到的自动回复：${JSON.stringify(afterQuery.nonKeyKinds)}。`
    + `诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toHaveLength(0)
  // 那些数据块确实到了，只是被归到"不属于任何按键"里——证明上面不是因为
  // 压根没数据才没样本。
  expect(afterQuery.writesOutsideRound).toBeGreaterThan(0)
})

test('非按键 onData 的判据是类级的：所有自动回复都被认成终端上报，不是逐条 hardcode', async () => {
  // 这条是本轮的核心回归。上一轮"只认 CPR"的写法在这里会立刻露馅：`plain` 这个
  // 类别专门收"不以 ESC 开头"的东西，一条终端上报都不该落进去。
  //
  // 反过来说，只要判据仍然是"内容不等于按键字符即非按键"（它是"以 ESC 开头"
  // 这条类级判据的超集），将来 xterm 新增任何一种自动回复都会自动被接住，
  // 不需要有人回来补名单。
  const kinds = afterQuery.nonKeyKinds
  expect(
    kinds.plain ?? 0,
    `有 ${kinds.plain ?? 0} 条非按键 onData 不以 ESC 开头，说明它根本不是终端上报，`
    + `这一阶段不该出现这种东西。原始字节：${JSON.stringify(afterQuery.nonKeySamples)}`,
  ).toBe(0)

  // 至少要认出 CPR 和 DA 这两类——这是"分类确实在工作"的正面证据，
  // 否则全归进 CSI-other 也能让上面那条断言绿。
  expect(
    Object.keys(kinds),
    `实际观察到的自动回复类别：${JSON.stringify(kinds)}，`
    + `原始字节：${JSON.stringify(afterQuery.nonKeySamples)}`,
  ).toEqual(expect.arrayContaining(['CPR', 'DA']))
})

test('焦点上报 ESC[I / ESC[O 同样不产生样本——Windows CI 上红掉的正是这一条', async () => {
  // 这一节在 Linux 上靠手动打开模式 1004 复现，在 Windows 上是 PowerShell 自己开的。
  // 两边跑的是同一段代码路径。
  expect(
    afterFocus.nonKeyKinds.FOCUS ?? 0,
    `打开模式 1004 并 blur/focus 之后没有观察到焦点上报。`
    + `实际观察到：${JSON.stringify(afterFocus.nonKeyKinds)}，`
    + `原始字节：${JSON.stringify(afterFocus.nonKeySamples)}。`
    + `诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toBeGreaterThan(0)

  expect(
    afterFocus.samples,
    `焦点上报不该产生任何样本，实际拿到 ${JSON.stringify(afterFocus.samples)}`,
  ).toHaveLength(0)
  expect(afterFocus.keyDataEvents, '焦点上报不是按键，不该被计成按键 onData').toBe(0)
})

test('真按键产生且只产生一个样本', async () => {
  expect(
    afterKey.samples,
    `一次按键应当恰好一个样本。`
    + `本轮观察到的自动回复：${JSON.stringify(afterKey.nonKeyKinds)}。`
    + `诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toHaveLength(1)
  expect(afterKey.keyDataEvents).toBe(1)
  expect(afterKey.unpaired).toBe(0)
  expect(afterKey.samples[0].ms).toBeGreaterThan(0)
})
