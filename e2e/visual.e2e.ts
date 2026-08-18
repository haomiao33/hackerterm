/**
 * 视觉回归：把终端渲染出来的**像素**跟入库基线比对。
 *
 * 为什么非要有它（这条链路上已经吃过两次亏，两次都是靠用户截图才发现的）：
 *
 * 1. `src/ui/browser/terminal/mount.ts` 里少了 `import '@xterm/xterm/css/xterm.css'`
 *    —— 终端塌缩成页面顶部一个小框。**没有任何异常、没有任何日志**，屏幕缓冲区
 *    里字符一个不少，e2e/smoke.e2e.ts 那种读 `term.buffer.active` 的断言全绿。
 * 2. 亮色主题的 `ITheme` 没给 `cursor` 配色，xterm 退回内置默认色，跟白底几乎
 *    重合 —— 光标与背景**零像素差异**，完全看不见。同样零异常、零日志，缓冲区
 *    里 cursorX/cursorY 一切正常。
 *
 * 两个故障的共同点：**只有像素能证伪**。读缓冲区的断言对它们完全免疫，这也正是
 * 本项目最典型的"看着对、不报错、就是不工作"。所以这个文件的判据必须是、且只能是
 * 截图。
 *
 * ── 为什么现在 Windows 也跑（以前整个文件在 Windows 上是跳过的）──────────
 * 跳过的直接原因是**判据写死了 Linux**：文件顶部那个"字体在不在"的前提检查指的是
 * `/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf`，Windows 上这个路径永远
 * 不存在，于是 `skipIf` 把每一条都跳掉了。跳过是**静默**的——vitest 报告里就是几个
 * 灰色的 skipped，没人会去追问为什么，于是"视觉回归在正式目标平台上一条都没跑"
 * 这件事就这么无声无息地存在了很久。这正是本项目的主导故障类型（看着在测、其实
 * 没测）长在测试自己身上的一次。
 *
 * 底下真正的困难是**跨平台像素不可共用**：Linux 用 fontconfig + FreeType 画
 * DejaVu Sans Mono，Windows 用 DirectWrite 画 Consolas，同一段文字不可能得到相同
 * 的像素。解决办法是**每个平台一套独立基线**（文件名带 `.linux` / `.win32` 后缀，
 * 见 e2e/screenshot.ts 的 PLATFORM_SUFFIX），**不是**放宽比较阈值去强行共用一张图
 * ——放宽到能容忍整片文字区域的差异，这个测试就再也抓不到它要抓的那两个故障了。
 *
 * ── 可复现性：四个变量必须全部钉死，否则基线在别的机器上必然对不上 ──────
 * a. **字体**：两个平台各自钉一次。
 *    - Linux：`FONTCONFIG_FILE` 指到 e2e/fixtures/fonts.conf，理由见那个文件。
 *    - Windows：**没有 fontconfig**（Chromium 走 DirectWrite），那个环境变量在这里
 *      是空转，所以不设。改为依赖 mount.ts 里 `fontFamily: 'Menlo, Consolas,
 *      monospace'` 的第二档：Consolas 是 Windows 自 Vista 起随系统分发的组件，
 *      不是"碰巧装了"的第三方字体，所以它本身就是钉死的。前提检查因此改成
 *      "系统字体目录里有 consola.ttf"。
 * b. **渲染器**：两种渲染器（WebGL / DOM）的输出像素**不一样**，基线只对其中一种
 *    成立。下面有一条断言把"当前平台实际跑的是哪个"钉在 EXPECTED_RENDERER 上——
 *    哪天 CI 镜像换了（比如带了 GPU），这条会先红，而不是让一堆截图莫名其妙全红。
 * c. **窗口尺寸**：截图不截整个 `#terminal` 元素（它的尺寸跟窗口/窗管有关，
 *    换台机器就变），而是从页面左上角截一块**固定像素尺寸**的区域。xterm 的行
 *    从容器左上角开始排，只要基线内容不换行，这块区域就跟窗口多大、终端多少列
 *    完全无关。
 * d. **屏幕上没有别的东西**：见 waitForOutputQuiet 的注释——Windows 上 PTY 那头是
 *    真 PowerShell，它会自己往屏幕上写 banner 和提示符，抢在这些字节到齐之前截图
 *    就是一张随机的图。
 *
 * 更新基线：`pnpm test:e2e:update-screenshots`（更新完必须人眼看一遍图再入库）。
 * 注意它只更新**当前这个平台**的那一套；另一个平台的基线得在那个平台上生成
 * （CI 里跑一次 smoke job 拿产物是最省事的办法）。
 */
import { afterAll, beforeAll, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import type { ElectronApplication, Page } from 'playwright-core'
import { consoleLog, launchApp, MOUNT_TIMEOUT_MS, REPO_ROOT } from './electron-app'
import { compareToBaseline, UPDATING } from './screenshot'

/**
 * 每个平台"字体钉住了"所依赖的那个外部前提文件。缺了就跳过整个文件——拿一个不同的
 * 字体去比对只会红成一片，而那个红跟代码质量毫无关系。
 *
 * - linux：DejaVu Sans Mono（Debian/Ubuntu 的 fonts-dejavu-core 包）。CI 侧由 smoke
 *   job 的 apt 步骤显式安装；配合 e2e/fixtures/fonts.conf 把解析结果钉死到它一个。
 * - win32：Consolas。它是 Windows 的**系统组件**（自 Vista 起随系统分发），不是
 *   "碰巧装了"的第三方字体，所以不需要 fontconfig 那种改写规则，mount.ts 里
 *   `fontFamily: 'Menlo, Consolas, monospace'` 的第二档在 Windows 上必然命中它。
 *   这里仍然检查文件存在，是为了让"哪天精简版镜像把它裁了"表现成一个说得清原因的
 *   跳过，而不是一堆对不上的像素。
 *
 * 表里没有的平台（darwin 等）一律跳过：没有基线，也没有人在那上面验证过。
 */
const FONT_PRECONDITION: Record<string, string> = {
  linux: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  win32: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts', 'consola.ttf'),
}
const FONTS_CONF = path.join(REPO_ROOT, 'e2e/fixtures/fonts.conf')

/**
 * 每个平台的基线是用哪个 xterm 渲染器生成的。
 *
 * 不是配置项，是**观测到的事实的记录**：两种渲染器输出的像素不一样，所以基线只对
 * 生成它的那一种成立。把它写成常量并加一条断言，是为了让"环境变了"这件事以一条
 * 说得清的失败出现，而不是让所有截图一起变红让人去猜。
 * 取值依据（两个平台都是 CI 上的实测日志，不是推断）：
 * - linux（ubuntu-latest）：`WebGL renderer unavailable, falling back to DOM
 *   renderer: Error: WebGL2 not supported`——无 GPU、也没有可用的 GL 实现。
 * - win32（windows-latest）：见下面那条断言第一次跑出来的日志。
 */
const EXPECTED_RENDERER: Record<string, 'dom' | 'webgl'> = {
  linux: 'dom',
  win32: 'dom',
}

/** 截图区域（CSS 像素）。取够大以覆盖下面写进去的全部基线内容，又不触及窗口边缘。 */
const CLIP_WIDTH = 640
const CLIP_HEIGHT = 220

/**
 * 光标特写的边距（CSS 像素）：以光标外接矩形为中心向外扩这么多。
 *
 * 为什么要单独截一张光标特写，而不是只靠上面那张大图：光标是个大约 8×17 的
 * 色块，在 640×220 里只占 0.1%。整图比对当然也能看见这 0.1%，但一旦将来有人
 * 为了容忍字体微差把整图的容差调松，光标就会第一个漏网——而它恰恰是已经真实
 * 发生过的那个故障。特写图里光标占比接近 10%，任何合理容差都拦不住它。
 */
const CURSOR_MARGIN_PX = 12

/** 渲染稳定判据：连续这么多帧没有新的绘制回调就认为落定。 */
const SETTLE_FRAMES = 3

/**
 * 判定「PTY 那头已经不再往屏幕上写东西」的静默时长（毫秒）。
 *
 * Windows 上非有这一步不可：那边 ConPTY 真的把 powershell.exe 起起来了，它会自己
 * 往终端里写一段 banner + 一个提示符，而这些字节**什么时候到**取决于这台机器当时
 * 有多忙（PSReadLine 初始化、模块加载、Defender 扫描都在这条路上）。抢在它们到齐
 * 之前 `term.reset()` 再截图，剩下的字节会在截图之后陆续落到屏幕上——于是同一份
 * 代码有时截到干净的图、有时截到带半行提示符的图，基线永远对不上，而失败长得像
 * "渲染回归了"。这不是要等一个固定的时长（那只是把赌注换个地方压），而是要等到
 * **数据流真的静下来**。
 *
 * Linux 上这一段是零成本的：PTY 子进程 fork 之后就被打死了（见 paintBaselineContent
 * 的注释），崩溃回溯写完就再没有字节，第一次轮询就满足静默条件。
 *
 * 取值依据：1.5 秒 = 本机实测 PowerShell 从第一个字节到提示符画完约 300-600ms，
 * 取其约 3 倍余量。判据是"最后一次收到字节之后过了多久"，所以这个数字只影响
 * 每条用例多等多久，不影响正确性——真要选，宁可选大。
 */
const OUTPUT_QUIET_MS = 1_500

/**
 * 等静默的总上限（毫秒）。超时就是失败而不是"那就先截吧"：屏幕一直在动的时候
 * 截出来的图没有任何判据价值，与其产出一张随机的图去跟基线比，不如以一个说得清
 * 原因的失败停下来。
 * 取值依据：Windows runner 冷启动 + Defender 实时扫描下 shell 起来要十几秒，
 * 30 秒给了约一倍余量，同时远小于 vitest 的 testTimeout。
 */
const OUTPUT_QUIET_TIMEOUT_MS = 30_000

/** 轮询"静了多久"的间隔（毫秒）。比 OUTPUT_QUIET_MS 小一个量级就够，不必更密。 */
const OUTPUT_QUIET_POLL_MS = 100

declare global {
  interface Window {
    /**
     * 最后一次 xterm 解析完一批写入的时刻（`Date.now()`）。只有本文件用，靠
     * beforeAll 里挂的 `onWriteParsed` 维护——见 waitForOutputQuiet。
     */
    __htVisualLastWriteAt?: number
  }
}

let app: ElectronApplication
let page: Page
/** 当前平台钉字体的前提文件；不在表里的平台拿到 undefined，直接跳过整个文件。 */
const fontPreconditionPath = FONT_PRECONDITION[process.platform]
const fontAvailable = fontPreconditionPath !== undefined && existsSync(fontPreconditionPath)

beforeAll(async () => {
  if (!fontAvailable) return
  ;({ app, page } = await launchApp({
    env: {
      // 见 e2e/fixtures/fonts.conf 顶部注释。只有这个文件的用例设它，而且**只在
      // Linux 上**：Windows 的 Chromium 走 DirectWrite，根本不读 fontconfig，
      // 设了是空转——空转的配置最容易让人误以为字体在那边也被钉住了。
      ...(process.platform === 'linux' ? { FONTCONFIG_FILE: FONTS_CONF } : {}),
    },
  }))
  // 静默判据的埋点必须在这里挂一次（而不是每条用例挂一次）：onWriteParsed 每挂一次
  // 就多一个监听器，重复挂不会出错但会让"谁在改这个时间戳"变得说不清。
  await page.evaluate(() => {
    const term = window.__htDiagnostics!.term
    window.__htVisualLastWriteAt = Date.now()
    term.onWriteParsed(() => { window.__htVisualLastWriteAt = Date.now() })
  })
}, MOUNT_TIMEOUT_MS + 30_000)

afterAll(async () => {
  await app?.close()
})

/**
 * 等到 PTY 那头**不再往屏幕写字节**为止。理由和取值依据见 OUTPUT_QUIET_MS。
 *
 * 判据是"最后一次 `onWriteParsed` 到现在过了多久"，不是"睡够多少毫秒"——前者
 * 问的是流真的静了没有，后者只是赌它够快。
 */
async function waitForOutputQuiet(): Promise<void> {
  await page.waitForFunction(
    (quietMs) => Date.now() - (window.__htVisualLastWriteAt ?? 0) >= quietMs,
    OUTPUT_QUIET_MS,
    { timeout: OUTPUT_QUIET_TIMEOUT_MS, polling: OUTPUT_QUIET_POLL_MS },
  )
}

/**
 * 把终端清成一个**完全确定**的状态再截图。
 *
 * 为什么必须先清：Linux 上 PTY 子进程 fork 之后就被 Chromium 的 fd 归属检查
 * 打死了（见 electron-app.ts 的 FD_OWNERSHIP_CRASH_MARKER），它临死前把一整段
 * 崩溃回溯写进了 PTY，于是终端一挂载屏幕上就有十几行带**内存地址**的栈回溯——
 * 每次运行地址都不一样，拿它当基线等于每次都红。
 * Windows 上屏幕上的东西不一样（是真 PowerShell 的 banner 和提示符），但结论
 * 一模一样：不清就没有确定的判据。
 *
 * 清之前必须先等静默：`reset()` 只擦掉**已经到了**的字节，还在路上的那些会在
 * 截图之后落到屏幕上（见 waitForOutputQuiet）。
 */
async function paintBaselineContent(): Promise<void> {
  await waitForOutputQuiet()
  await page.evaluate(async () => {
    const term = window.__htDiagnostics!.term
    term.reset()
    // 内容全部 < 80 列，保证在任何列数下都不换行——截图区域因此与终端列数无关。
    const lines = [
      'HackerTerm visual baseline',
      '0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz',
      '\x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m \x1b[34mblue\x1b[0m \x1b[1mbold\x1b[0m \x1b[4munderline\x1b[0m \x1b[7mreverse\x1b[0m',
      'box: +--------+  |  |  +--------+',
    ]
    await new Promise<void>((res) => term.write(lines.join('\r\n'), () => res()))
    // 光标挪到一块空白区域（第 7 行第 3 列，绝对定位，与终端行列数无关），
    // 下面的光标特写才不会把字形一起框进去——那样字体一抖特写就跟着红。
    await new Promise<void>((res) => term.write('\x1b[7;3H', () => res()))
  })
  // 等绘制落定：DOM 渲染器把实际的 DOM 更新排在 rAF 里，write 的回调只保证
  // 解析完成，不保证画完。
  await page.evaluate(async (frames) => {
    for (let i = 0; i < frames; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    }
  }, SETTLE_FRAMES)
}

/** 页面左上角固定尺寸区域的截图。 */
async function screenshotClip(): Promise<Buffer> {
  return page.screenshot({ clip: { x: 0, y: 0, width: CLIP_WIDTH, height: CLIP_HEIGHT } })
}

/** 光标外接矩形向外扩 CURSOR_MARGIN_PX 的特写截图。 */
async function screenshotCursor(): Promise<Buffer> {
  const box = await page.evaluate((margin) => {
    // DOM 渲染器把光标画成 .xterm-cursor 这个 span。拿它的外接矩形做基准，
    // 比自己按行高列宽推算稳得多（行高/列宽是 xterm 内部量出来的浮点数）。
    const el = document.querySelector('.xterm-cursor')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.left - margin), y: Math.round(r.top - margin),
      width: Math.round(r.width + margin * 2), height: Math.round(r.height + margin * 2),
    }
  }, CURSOR_MARGIN_PX)
  if (!box) {
    throw new Error(
      '页面里找不到 .xterm-cursor 元素——DOM 渲染器在有焦点时一定会画这个 span。' +
      '要么终端失去了焦点，要么 xterm 换了 DOM 结构，两种都得先查清楚再谈截图。',
    )
  }
  return page.screenshot({ clip: box })
}

test.skipIf(!fontAvailable)(
  '前提：跑的渲染器跟本平台基线是同一个（基线只对生成它的那一种成立）',
  () => {
    const webglLines = consoleLog(page).filter((l) => l.includes('WebGL renderer'))
    const actual = webglLines.some((l) => l.includes('WebGL renderer attached')) ? 'webgl' : 'dom'
    expect(
      actual,
      `本平台（${process.platform}）的基线是在 ${EXPECTED_RENDERER[process.platform]} 渲染器下生成的，` +
      `现在实际跑的是 ${actual}，两者像素不同。\n` +
      '这不是代码回归，是运行环境变了（比如 CI 镜像开始带 GPU、或者不带了）。\n' +
      '正确处理是先确认环境变化本身合不合理，再在该平台上重新生成基线——\n' +
      '不要去改比较阈值来"和稀泥"。\n' +
      `相关日志：${JSON.stringify(webglLines)}`,
    ).toBe(EXPECTED_RENDERER[process.platform])
  },
)

test.skipIf(!fontAvailable)(
  '亮色主题整体渲染：布局塌缩（xterm.css 没引入）会在这里变红',
  async () => {
    await page.emulateMedia({ colorScheme: 'light' })
    await paintBaselineContent()
    const result = compareToBaseline('terminal-light', await screenshotClip())
    expect(result.diffPixels, result.summary).toBe(0)
  },
)

test.skipIf(!fontAvailable)(
  '亮色主题光标可见：光标与白底零像素差异会在这里变红',
  async () => {
    await page.emulateMedia({ colorScheme: 'light' })
    await paintBaselineContent()
    const result = compareToBaseline('cursor-light', await screenshotCursor())
    expect(result.diffPixels, result.summary).toBe(0)
  },
)

test.skipIf(!fontAvailable)(
  '暗色主题光标可见',
  async () => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await paintBaselineContent()
    const result = compareToBaseline('cursor-dark', await screenshotCursor())
    expect(result.diffPixels, result.summary).toBe(0)
  },
)

test.skipIf(!fontAvailable)(
  '光标确实是一块跟背景不同的像素——不依赖任何基线的自洽判据',
  async () => {
    await page.emulateMedia({ colorScheme: 'light' })
    await paintBaselineContent()
    if (UPDATING) return

    // 这条断言刻意**不用基线**：基线可能被人误更新成"光标不可见"的样子然后入库，
    // 那时上面几条会全绿，故障却还在。这里直接问一个基线篡改不了的问题——
    // 光标那块矩形里，到底有没有颜色跟背景不一样的像素。
    const contrast = await page.evaluate(() => {
      const cursor = document.querySelector('.xterm-cursor')
      if (!cursor) return null
      const style = getComputedStyle(cursor)
      const screen = document.querySelector('.xterm-screen')
      const bg = screen ? getComputedStyle(screen).backgroundColor : ''
      return { cursorBg: style.backgroundColor, cursorColor: style.color, screenBg: bg }
    })
    expect(contrast, '找不到 .xterm-cursor').not.toBeNull()

    // 像素级判据：光标特写图里必须存在**多种**颜色。光标与背景零像素差异时，
    // 这块区域（刻意选在没有字形的空白处）会是纯色一片。
    const png = await screenshotCursor()
    const distinct = countDistinctColors(png)
    expect(
      distinct,
      `光标特写区域只有 ${distinct} 种颜色，说明光标跟背景完全同色、根本看不见。\n` +
      `计算出的样式：${JSON.stringify(contrast)}`,
    ).toBeGreaterThan(1)
  },
)

/**
 * 数一张 PNG 里有多少种不同的 RGB 值。
 *
 * 直接用 pngjs 解码而不是走 screenshot.ts：screenshot.ts 的职责是"跟基线比"，
 * 而这条断言恰恰是**不跟基线比**的那一条，不该反过来依赖它。
 */
function countDistinctColors(png: Buffer): number {
  const img = PNG.sync.read(png)
  const seen = new Set<number>()
  for (let i = 0; i < img.data.length; i += 4) {
    seen.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2])
  }
  return seen.size
}
