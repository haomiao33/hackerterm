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
 * ── 可复现性：三个变量必须全部钉死，否则基线在别的机器上必然对不上 ──────
 * a. **字体**：`FONTCONFIG_FILE` 指到 e2e/fixtures/fonts.conf，理由见那个文件。
 * b. **渲染器**：headless 无 GPU 环境里 WebGL2 起不来，xterm 会退回 DOM 渲染器
 *    （本地实测日志：`WebGL renderer unavailable, falling back to DOM renderer:
 *    Error: WebGL2 not supported`）。两种渲染器的输出像素**不一样**，基线只对
 *    其中一种成立，所以下面有一条断言专门钉住"当前跑的确实是 DOM 渲染器"——
 *    哪天 CI 镜像带了 GPU，这条会先红，而不是让一堆截图莫名其妙全红。
 * c. **窗口尺寸**：截图不截整个 `#terminal` 元素（它的尺寸跟窗口/窗管有关，
 *    换台机器就变），而是从页面左上角截一块**固定像素尺寸**的区域。xterm 的行
 *    从容器左上角开始排，只要基线内容不换行，这块区域就跟窗口多大、终端多少列
 *    完全无关。
 *
 * 更新基线：`pnpm test:e2e:update-screenshots`（更新完必须人眼看一遍图再入库）。
 */
import { afterAll, beforeAll, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import type { ElectronApplication, Page } from 'playwright-core'
import { consoleLog, launchApp, MOUNT_TIMEOUT_MS, REPO_ROOT } from './electron-app'
import { compareToBaseline, UPDATING } from './screenshot'

/**
 * 钉死字体所依赖的唯一外部前提。缺了就跳过整个文件——拿一个不同的字体去比对
 * 只会红成一片，而那个红跟代码质量毫无关系。CI 侧由 smoke job 装 fonts-dejavu-core。
 */
const DEJAVU_MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
const FONTS_CONF = path.join(REPO_ROOT, 'e2e/fixtures/fonts.conf')

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

let app: ElectronApplication
let page: Page
/** DejaVu 缺失时整个文件跳过。 */
const fontAvailable = existsSync(DEJAVU_MONO)

beforeAll(async () => {
  if (!fontAvailable) return
  ;({ app, page } = await launchApp({
    env: {
      // 见 e2e/fixtures/fonts.conf 顶部注释。只有这个文件的用例设它。
      FONTCONFIG_FILE: FONTS_CONF,
    },
  }))
}, MOUNT_TIMEOUT_MS + 30_000)

afterAll(async () => {
  await app?.close()
})

/**
 * 把终端清成一个**完全确定**的状态再截图。
 *
 * 为什么必须先清：Linux 上 PTY 子进程 fork 之后就被 Chromium 的 fd 归属检查
 * 打死了（见 electron-app.ts 的 FD_OWNERSHIP_CRASH_MARKER），它临死前把一整段
 * 崩溃回溯写进了 PTY，于是终端一挂载屏幕上就有十几行带**内存地址**的栈回溯——
 * 每次运行地址都不一样，拿它当基线等于每次都红。
 */
async function paintBaselineContent(): Promise<void> {
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
  '前提：跑的是 DOM 渲染器（基线只对这一种渲染器成立）',
  () => {
    const webglLines = consoleLog(page).filter((l) => l.includes('WebGL renderer'))
    const attached = webglLines.some((l) => l.includes('WebGL renderer attached'))
    expect(
      attached,
      'WebGL 渲染器起来了，但入库基线是在 DOM 渲染器下生成的，两者像素不同。\n' +
      '这不是代码回归，是运行环境变了（比如 CI 镜像开始带 GPU 了）。\n' +
      `相关日志：${JSON.stringify(webglLines)}`,
    ).toBe(false)
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
