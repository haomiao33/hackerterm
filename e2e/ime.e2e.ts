/**
 * 中文输入法：组词 →上屏 →退格 的端到端断言。
 *
 * 为什么这条链路值得单独测：输入法走的不是普通按键路径。用户敲 `n`、`i` 时，
 * 这些字节**绝不能**跑到 PTY 里去（否则 shell 会收到一串拼音字母），必须先被
 * 输入法吃掉、组成候选词，直到用户选定才作为一个整体上屏。xterm 靠
 * composition 事件（compositionstart/update/end）区分这两种情况。这中间任何
 * 一环接错，症状都是"打中文出来一堆拼音字母"或者"打中文什么都没有"——
 * 又是一类不抛异常的静默故障。
 *
 * ── 为什么用 CDP 而不是 Playwright 的 keyboard API ──────────────────────
 * Playwright **没有**公开的输入法接口。`playwright-core` 1.62.1（当前 npm 上的
 * 最新版）的 `Keyboard` 只有 down/up/press/type/insertText 五个方法，没有
 * `imeSetComposition` / `imeCommitComposition`——那两个名字属于 **CDP 协议**
 * （`Input.imeSetComposition`，见 playwright-core 自带的 types/protocol.d.ts），
 * 不属于 Playwright 的客户端 API。
 * 所以这里用 `context.newCDPSession(page)` 直接发协议命令。这不是绕路：
 * Playwright 自己的键盘方法底层同样是往 CDP 发 `Input.*`，我们只是少了一层
 * 包装。Electron 是 Chromium，CDP 通道原生可用（实测 `newCDPSession` 在
 * ElectronApplication.context() 上可用）。
 *
 * ── 测不了什么（不假装能测） ─────────────────────────────────────────
 * 候选框（那个列着"你/尼/泥"的小窗）的**屏幕物理位置**由操作系统的输入法框架
 * 决定，不在页面里，CDP 看不到也摆不动。所以本文件不碰它。能测的是数据流：
 * 组词期间有没有字节漏进 PTY、上屏之后进去的是不是正确的 UTF-8、退格删掉的
 * 是一个汉字还是一个字节。
 */
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { CDPSession, ElectronApplication, Page } from 'playwright-core'
import { launchApp, MOUNT_TIMEOUT_MS, readDiagnosticLog } from './electron-app'

/** 组词过程中的中间态（拼音）。这串字母一个都不许跑到 PTY 里去。 */
const COMPOSING_PINYIN = 'nihao'
/** 候选词高亮阶段的中间态。同样不许出现在 PTY 上。 */
const COMPOSING_HANZI = '你好'
/** 最终上屏的文字。 */
const COMMITTED = '你好'

/**
 * 每一步之后给 IPC 往返留的时间。回显要走完整链路，比纯页面事件慢。
 *
 * 只用在"接下来要断言**什么都没发生**"的地方（组词中间态不许发字节）——那种
 * 断言天然只能靠等一段时间来立论，没有可等的判据。凡是断言"某件事发生了"的
 * 地方一律改用 `waitForSnapshot` 等判据，不要再用这个常量。
 */
const SETTLE_MS = 600

/**
 * 等一次真实回显走完屏幕的上限。
 *
 * 给得比 SETTLE_MS 宽两个量级，是因为它要覆盖 Windows 冷启动：ConPTY 起
 * conhost + PowerShell 启动 + PSReadLine 加载，叠加 Defender 实时扫描能到几十秒。
 * 这只是**上限**不是固定等待，判据一满足立刻往下走。
 */
const ECHO_TIMEOUT_MS = 60_000

let app: ElectronApplication
let page: Page
let cdp: CDPSession

beforeAll(async () => {
  ({ app, page } = await launchApp())
  cdp = await app.context().newCDPSession(page)

  // 清屏 + 装一个 onData 记录器。
  //
  // 为什么必须先清：Linux 上 PTY 子进程 fork 之后就被 Chromium 的 fd 归属检查
  // 打死了（见 electron-app.ts 的 FD_OWNERSHIP_CRASH_MARKER），临死前把一整段
  // 崩溃回溯写进了 PTY，屏幕上一开始就有十几行栈回溯，断言"屏幕上有没有拼音"
  // 会被这堆噪声干扰。
  await page.evaluate(() => {
    const w = window as unknown as { __sent: string[] }
    w.__sent = []
    const term = window.__htDiagnostics!.term
    // 这个监听器和 boot.ts 里那个是并列的，不替换、不影响真实数据流——
    // 它只是**旁听**同一个 onData，用来断言"到底往 PTY 发了什么"。
    term.onData((data) => w.__sent.push(data))
    term.reset()
  })
  await new Promise((r) => setTimeout(r, SETTLE_MS))
}, MOUNT_TIMEOUT_MS + 30_000)

afterAll(async () => {
  await app?.close()
})

/**
 * xterm **自动回复**的判据：**以 ESC(0x1b) 开头**。
 *
 * 为什么必须把它们滤掉：`term.onData` 不只在用户输入时触发——xterm 收到终端
 * 查询会自动回话，而 **PSReadLine 每次重绘都会问一次光标位置**（`ESC[6n`）。
 * 这件事在本仓库里已经有前车之鉴：e2e/latency-probe.ts 顶部记着旧的时延测量
 * 就是因为把这些自动回复当成了按键，Windows 上 60 次按键量出 61 个样本。
 * 本文件的断言是"上屏恰好发一次、退格恰好发一次"，Linux 上没有 shell 所以
 * 没人问光标位置，看着一切正常；到了 Windows（真 PowerShell + PSReadLine）
 * 就会平白多出若干条自动回复，断言凭空变红——而那跟输入法一点关系都没有。
 *
 * ── 判据为什么从 `/^\x1b\[[\d;]*[Rc]$/` 放宽到"以 ESC 开头" ────────────────
 * 原来那条只认 CPR（`…R`）和 DA（`…c`）两种，是**按名单堵**。名单漏了的那些
 * 立刻就咬人了：Windows CI 上 e2e/latency-pairing.e2e.ts 红掉，日志里第一条
 * 非按键 onData 是 `1b 5b 49` = `ESC[I`，**焦点上报**（DEC 私有模式 1004，真
 * PowerShell 自己会开）——它不以 R 或 c 结尾，会被这条正则放行，于是本文件那几条
 * `toHaveLength(0)` / `toHaveLength(1)` 在 Windows 上就是一颗定时炸弹。
 *
 * 现在改成类级判据：xterm 会主动写进 onData 的东西**无一例外都是 ANSI 控制
 * 序列**（CSI `ESC[` 或 DCS `ESC P`）——CPR / DECXCPR / DA1 / DA2 / DSR /
 * DECRPM / 窗口操作 / 鼠标上报 / 焦点上报 / 括号粘贴，完整名单与源码出处见
 * e2e/latency-probe.ts 里 `classifyNonKey` 的注释。将来 xterm 新增任何一种
 * 上报也照样被接住，不需要有人回来补名单。
 *
 * 放宽会不会把**真的用户输入**一起滤掉？本文件里不会：它注入的输入只有中文
 * 上屏文本（`你好`）和退格（DEL，0x7f），都不以 ESC 开头。方向键、Esc 键那类
 * ESC 开头的按键本文件一个都没用到——真要测那些键，得在这里另开一条不套滤镜的
 * 通道，别直接放宽这条判据。
 */
const AUTO_REPLY = /^\x1b/

/**
 * 当前状态快照。
 *
 * `sent` 只保留**真正的用户输入**（滤掉上面那些自动回复）；`rawSent` 留着全量，
 * 断言失败时能一眼看出多出来的到底是什么，不至于对着一条"应该 1 条实际 3 条"
 * 干瞪眼。
 *
 * 屏幕内容取**整屏**而不是第 0 行：Linux 上没有 shell，文字就落在第 0 行；
 * Windows 上 PSReadLine 会把提示符和输入一起重绘在它自己选的位置，钉死第 0 行
 * 会在那边必然失败。
 */
async function snapshot(): Promise<{
  sent: string[], rawSent: string[], screen: string, cursorX: number,
}> {
  return page.evaluate((autoReplySource) => {
    const autoReply = new RegExp(autoReplySource)
    const buf = window.__htDiagnostics!.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }
    const raw = (window as unknown as { __sent: string[] }).__sent.slice()
    return {
      sent: raw.filter((d) => !autoReply.test(d)),
      rawSent: raw,
      screen: lines.join('\n'),
      cursorX: buf.cursorX,
    }
  }, AUTO_REPLY.source)
}

/**
 * 轮询快照直到 `predicate` 满足；超时则返回**最后一份快照**（不抛异常）。
 *
 * 不抛异常是刻意的：调用点后面紧跟着一条正常的 `expect`，让它去报错能给出
 * "屏幕上没有出现 X + 诊断日志"这种可读的失败信息，比在这里抛一个通用超时
 * 有用得多。这个函数只负责"别过早往下走"。
 */
async function waitForSnapshot(
  predicate: (s: Awaited<ReturnType<typeof snapshot>>) => boolean,
  what: string,
  timeoutMs = ECHO_TIMEOUT_MS,
): Promise<Awaited<ReturnType<typeof snapshot>>> {
  const deadline = Date.now() + timeoutMs
  let last = await snapshot()
  while (!predicate(last)) {
    if (Date.now() > deadline) {
      console.log(`  ⚠ 等待「${what}」超过 ${timeoutMs}ms 仍未满足，按当前状态继续断言`)
      break
    }
    await new Promise((r) => setTimeout(r, 100))
    last = await snapshot()
  }
  return last
}

/** 设置组词中间态（等价于用户还在拼、还没选词）。 */
async function setComposition(text: string): Promise<void> {
  await cdp.send('Input.imeSetComposition', {
    text, selectionStart: text.length, selectionEnd: text.length,
  })
  await new Promise((r) => setTimeout(r, SETTLE_MS))
}

test('组词过程中一个字节都不许进 PTY', async () => {
  await setComposition(COMPOSING_PINYIN)
  const pinyinStage = await snapshot()

  expect(
    pinyinStage.sent,
    `组词到 "${COMPOSING_PINYIN}" 时已经往 PTY 发了 ${JSON.stringify(pinyinStage.sent)}` +
    `（含自动回复的全量：${JSON.stringify(pinyinStage.rawSent)}）。` +
    '拼音字母漏进 PTY 的话，shell 会收到一串乱七八糟的字母——这正是"中文打不了"最常见的形态。\n' +
    `诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toHaveLength(0)

  // 屏幕缓冲区也不该有这串拼音：组词态由 xterm 画在一个独立的浮层里，
  // 不进屏幕缓冲区（真进去了就意味着它被当成普通输出处理了）。
  expect(pinyinStage.screen).not.toContain(COMPOSING_PINYIN)

  // 再推进到"候选词已高亮但还没上屏"，同样不许发出去。
  await setComposition(COMPOSING_HANZI)
  const hanziStage = await snapshot()
  expect(
    hanziStage.sent,
    `候选词高亮到 "${COMPOSING_HANZI}" 时就已经发给 PTY 了：${JSON.stringify(hanziStage.sent)}` +
    `（含自动回复的全量：${JSON.stringify(hanziStage.rawSent)}）。` +
    '这会导致用户每换一个候选词，PTY 就收到一份——上屏前的中间态必须一个字节都不发。',
  ).toHaveLength(0)
}, 120_000)

test('上屏之后文字正确进入：一次 onData，内容就是那两个汉字', async () => {
  // 上屏前的光标列。下面断言的是**增量**而不是绝对值：Linux 上没有 shell，
  // 光标从第 0 列起步；Windows 上 PSReadLine 先画了提示符，起点是提示符宽度。
  // 钉死绝对值会在 Windows 上必然失败，而它要证明的事情（两个双宽字符占 4 列）
  // 用增量表达得更准确。
  const before = await snapshot()

  // Input.insertText 就是输入法"确认上屏"这个动作在 CDP 上的等价物：
  // 它结束当前 composition 并把最终文本作为一个整体插入。
  await cdp.send('Input.insertText', { text: COMMITTED })

  // 等**屏幕上真的出现了那两个汉字**再取快照，而不是干等一个固定的 SETTLE_MS。
  //
  // 为什么：600ms 这个数隐含假设了"从端立刻回显"。Linux 上回显来自内核行规程，
  // 确实是立刻；但 Windows 上是真 PowerShell + PSReadLine，冷启动时它可能还没
  // 就绪，字节先在 PTY 里排队、就绪之后才一起回显。同一类假设刚刚让
  // e2e/latency-pairing.e2e.ts 在 Windows CI 上红掉（敲了键但从端没有任何回显）。
  // 改成"等到判据满足"之后，机器快就早点往下走、机器慢就多等一会儿，两边都不
  // 用调参；等不到才失败，而且失败信息说得清是"屏幕上始终没出现"。
  const after = await waitForSnapshot(
    (s) => s.screen.includes(COMMITTED),
    `屏幕上出现 "${COMMITTED}"`,
  )
  const newlySent = after.sent.slice(before.sent.length)

  expect(
    newlySent,
    `上屏应当恰好触发一次 onData，实际是 ${JSON.stringify(newlySent)}` +
    `（含自动回复的全量：${JSON.stringify(after.rawSent)}）。` +
    '拆成多次意味着中间态也被发了出去。',
  ).toHaveLength(1)
  expect(newlySent[0], '发给 PTY 的内容必须就是上屏的文字').toBe(COMMITTED)

  // 走完 PTY 往返之后，屏幕上要真的出现这两个汉字——只断言"发出去了"是不够的，
  // 多字节 UTF-8 在 IPC 任何一段被截断/重编码都会在这里露馅。
  // （上面的 waitForSnapshot 已经等的就是这个条件；这条断言留着是为了在它超时
  // 返回最后一份快照时，给出一句人能直接读懂的失败原因，而不是一个光秃秃的超时。）
  expect(
    after.screen,
    `屏幕上没有出现 "${COMMITTED}"。\n诊断日志：\n${await readDiagnosticLog(page)}`,
  ).toContain(COMMITTED)

  // 两个汉字是双宽字符，占 4 列。这条断言顺带证明了 xterm 认出了它们的宽度
  // （认成单宽的话只会前进 2 列）。
  expect(after.cursorX - before.cursorX, '两个双宽汉字应当让光标前进 4 列').toBe(4)
}, 120_000)

test('退格一次删掉一整个汉字，不是一个字节', async () => {
  const before = await snapshot()
  await page.keyboard.press('Backspace')
  await new Promise((r) => setTimeout(r, SETTLE_MS))
  const after = await snapshot()

  // 这是本条测试**我们自己能控制**的那一半，也是判据最硬的一半：
  // 一次退格必须只发一个 0x7f。"你" 的 UTF-8 是 3 个字节，如果这里发出 3 个
  // 0x7f（或者按字节退格），shell 那边就会把一个汉字拆成三次删除。
  const newlySent = after.sent.slice(before.sent.length)
  expect(
    newlySent,
    `一次退格应当恰好发一次 onData，实际发了 ${JSON.stringify(newlySent)}` +
    `（含自动回复的全量：${JSON.stringify(after.rawSent)}）`,
  ).toHaveLength(1)
  expect(
    [...newlySent[0]].map((c) => c.charCodeAt(0)),
    '一次退格必须只发一个 DEL(0x7f)——按字节退格会把一个汉字拆成三次删除',
  ).toEqual([0x7f])

  // 屏幕这一半：删掉的必须是整个 "好"，而 "你" 要原样留着。
  expect(
    after.screen,
    '退格之后屏幕上还有 "好"，一次退格没能删掉一整个汉字。',
  ).not.toContain('好')
  expect(
    after.screen,
    '退格之后 "你" 也没了，一次退格删掉了不止一个汉字。',
  ).toContain('你')
}, 120_000)
