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
 * 这条测试在 Linux 上就能跑：CPR 是 xterm 自己的行为，跟从端跑不跑得起 shell
 * 无关。
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
 * 自动回复阶段之后的静置时长。CPR 的回复会被真的写进 PTY，内核再把它回显回来，
 * 那批字节也会触发 term.write。等它彻底走完再进入按键阶段，两个阶段才不会互相
 * 污染（500ms 对一次亚毫秒往返来说是三个数量级的余量）。
 */
const QUIESCE_MS = 500

let app: ElectronApplication
let page: Page
let afterQuery: LatencyProbeSnapshot
let afterKey: LatencyProbeSnapshot

beforeAll(async () => {
  ({ app, page } = await launchApp())
  await installLatencyProbeOn(page, { key: KEY, timeoutMs: ROUNDTRIP_TIMEOUT_MS })

  // 第一阶段：开一轮，然后**不按键**，只往终端里塞一条光标位置查询——正是
  // PSReadLine 每次重绘会做的事。xterm 会自动回复，回复走 onData。
  await page.evaluate(() => { window.__htLatency!.arm() })
  // ESC[6n = DSR 6（Device Status Report，请求光标位置）。用 fromCharCode(27) 拼而不是
  // 写字面转义符：这段函数体会被序列化后丢进页面重新求值，源码里放一个裸的 ESC 字节
  // 谁也看不见，改坏了也不知道。
  await page.evaluate(() => { window.__htDiagnostics!.term.write(String.fromCharCode(27) + '[6n') })
  await new Promise((r) => setTimeout(r, QUIESCE_MS))
  afterQuery = await page.evaluate(() => window.__htLatency!.snapshot())

  // 第二阶段：真按一个键，这一次必须记到样本。
  await page.evaluate(() => { window.__htLatency!.arm() })
  await page.keyboard.press(KEY)
  await page.evaluate(() => window.__htLatency!.waitArmed())
  afterKey = await page.evaluate(() => window.__htLatency!.snapshot())
}, MOUNT_TIMEOUT_MS + 30_000)

afterAll(async () => {
  await app?.close()
})

test('xterm 的自动回复确实会触发 onData——旧配对逻辑多出样本的机制是真实存在的', async () => {
  expect(
    afterQuery.nonKeyOnData,
    `写了 ESC[6n 之后没有观察到任何非按键 onData。诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toBeGreaterThan(0)
})

test('自动回复不产生样本：一轮开着但没按键时，收到数据也不许记账', async () => {
  expect(
    afterQuery.samples,
    `不该有样本，实际拿到 ${JSON.stringify(afterQuery.samples)}。诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toHaveLength(0)
  // 那些数据块确实到了，只是被归到"不属于任何按键"里——证明上面不是因为
  // 压根没数据才没样本。
  expect(afterQuery.writesOutsideRound).toBeGreaterThan(0)
})

test('真按键产生且只产生一个样本', async () => {
  expect(
    afterKey.samples,
    `一次按键应当恰好一个样本。诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toHaveLength(1)
  expect(afterKey.keyDataEvents).toBe(1)
  expect(afterKey.unpaired).toBe(0)
  expect(afterKey.samples[0].ms).toBeGreaterThan(0)
})
