import { Terminal, type ITheme } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { FitAddon } from '@xterm/addon-fit'
import { log } from '../diagnostics/log'
import { createOnDataLogger } from '../diagnostics/byte-throttle'

export interface TerminalHandle {
  write(bytes: Uint8Array): void
  dispose(): void
}

export interface MountOptions {
  onInput(bytes: Uint8Array): void
  onResize(cols: number, rows: number): void
  /** 渲染层消费了多少字节，用于流控 */
  onConsumed(bytes: number): void
}

/** 终端默认字号（px）。暂定值，等真机验证后按实际观感调整。 */
const DEFAULT_FONT_SIZE_PX = 13

/**
 * WebGL 上下文丢失后连续重建的次数上限。来源：暂定值，不是压测出来的——单纯是
 * "不能无限递归/抖动"的保护，不做指数退避（没有观察到需要退避的症状，不引入
 * 没验证过的复杂度）。正常场景（休眠/唤醒等）一次重建就够，连续丢 3 次基本可以
 * 判定是 GPU 驱动本身有问题，此时放弃并留在 DOM 渲染器上更稳妥。
 */
const MAX_WEBGL_CONTEXT_LOSS_RETRIES = 3

// 亮/暗两套主题的取值本身不是本任务重点（暂定值，等设计稿定稿后替换）；
// 重点是切换时必须连同 WebGL 纹理图集一起清空，见下面 applyTheme。
const LIGHT_THEME: ITheme = { background: '#ffffff', foreground: '#1e1e1e' }
const DARK_THEME: ITheme = { background: '#1e1e1e', foreground: '#d4d4d4' }

function themeFor(prefersDark: boolean): ITheme {
  return prefersDark ? DARK_THEME : LIGHT_THEME
}

/**
 * 挂载一个 xterm.js 终端，WebGL 优先、DOM 兜底，并针对「字体发糊」做三处专门处理
 * （详见 task-6-report.md）：
 *
 * 1. 主题切换（`prefers-color-scheme` 变化）：换主题的同时必须清空纹理图集，
 *    否则旧主题的字形还留在图集里，新旧混杂导致边缘发虚。
 * 2. `devicePixelRatio` 变化（换屏/缩放）：浏览器没有原生的“DPI 变了”事件，
 *    xterm.js 自己也是用 `matchMedia` 监听 resolution 媒体查询做到的
 *    （见 xterm 源码 `CoreBrowserService.ts` 的 `ScreenDprMonitor`，这里采用同样
 *    的“查询失配就重新注册”手法）。这正是 xterm.js issue #1118 描述的场景
 *    （高低 DPI 显示器之间切换需要刷新纹理图集）；#955/#2662 是同类问题的
 *    另外两个已知案例。xterm.js 内部的自动处理只在 DPR 真变化时触发一次
 *    `handleResize`，不保证等价于完全清图集，所以这里显式再清一次 + `fit()`。
 * 3. WebGL 上下文丢失（典型触发场景：系统休眠唤醒）：只 `dispose()` 不重建的话，
 *    终端会永久退化成 DOM 渲染器。这里在丢失后立即尝试重新创建一份 WebGL addon，
 *    换一个新的上下文，把硬件加速渲染找回来；连续丢失超过
 *    `MAX_WEBGL_CONTEXT_LOSS_RETRIES` 次就放弃重建，留在 DOM 渲染器，
 *    避免 GPU 驱动持续故障时无限递归重建抖动。
 */
export function mountTerminal(el: HTMLElement, opts: MountOptions): TerminalHandle {
  const term = new Terminal({
    fontFamily: 'Menlo, Consolas, monospace',
    fontSize: DEFAULT_FONT_SIZE_PX,
    allowProposedApi: true,
    theme: themeFor(matchMedia('(prefers-color-scheme: dark)').matches),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el)

  let webgl: WebglAddon | undefined
  // 连续丢失次数：每次 attachWebgl() 成功重建就清零，所以量的是"连续"而不是
  // 全生命周期累计——否则笔记本每天睡眠唤醒一次，三天后就会被误判成 GPU 驱动
  // 故障，永久降级到 DOM 渲染器（睡眠唤醒本来就是 onContextLoss 的典型触发场景，
  // 不该被当成故障累计）。
  let contextLossCount = 0

  // WebGL 失败要降级而不是白屏（产品文档 §17 承诺③）。
  function attachWebgl(): void {
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        addon.dispose()
        webgl = undefined
        // 连续丢失次数超过上限：多半是 GPU 驱动本身有问题，放弃重建，
        // 留在 DOM 渲染器上，避免无限递归重建抖动。
        if (contextLossCount >= MAX_WEBGL_CONTEXT_LOSS_RETRIES) {
          const msg = `WebGL context lost ${contextLossCount + 1} times in a row, giving up and staying on DOM renderer`
          log(msg)
          console.warn(msg)
          return
        }
        contextLossCount += 1
        log(`WebGL context lost, retrying (${contextLossCount}/${MAX_WEBGL_CONTEXT_LOSS_RETRIES})`)
        attachWebgl() // 立刻尝试用新上下文重建，而不是永久退化成 DOM 渲染器
      })
      term.loadAddon(addon)
      webgl = addon
      contextLossCount = 0 // 重建成功说明 GPU 恢复正常了，之前的丢失记录作废
      log('WebGL renderer attached')
    } catch (err) {
      webgl = undefined
      log(`WebGL renderer unavailable, falling back to DOM renderer: ${err}`)
      console.warn('WebGL renderer unavailable, falling back to DOM renderer', err)
    }
  }
  attachWebgl()

  fit.fit()
  log(`fit → ${term.cols} × ${term.rows}, container clientWidth×clientHeight = ${el.clientWidth}×${el.clientHeight}`)
  opts.onResize(term.cols, term.rows)

  term.focus()
  log(`term.focus() called, activeElement = ${document.activeElement?.tagName}`)

  // 窗口重新拿到焦点（比如用户切回这个 Electron 窗口）时，把焦点带回终端的
  // 辅助 textarea——否则用户会看到光标闪烁但键盘输入进不去，和真机报告的
  // "看不见输入"现象同一类。
  const onWindowFocus = (): void => {
    term.focus()
    log(`window focus → term.focus() called, activeElement = ${document.activeElement?.tagName}`)
  }
  window.addEventListener('focus', onWindowFocus)

  // --- 字体不糊之一：亮暗主题切换 ---
  const themeQuery = matchMedia('(prefers-color-scheme: dark)')
  const onThemeChange = (e: MediaQueryListEvent): void => {
    term.options.theme = { ...themeFor(e.matches) }
    webgl?.clearTextureAtlas() // 只改 theme 选项不够，图集里还留着旧主题的字形
  }
  themeQuery.addEventListener('change', onThemeChange)

  // --- 字体不糊之二：devicePixelRatio 变化（换屏/系统缩放） ---
  let dprQuery: MediaQueryList
  const onDprChange = (): void => {
    webgl?.clearTextureAtlas()
    fit.fit()
    registerDprWatcher() // 用新的 DPR 值重新注册监听，因为查询字符串里编了旧 DPR
  }
  function registerDprWatcher(): void {
    dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    dprQuery.addEventListener('change', onDprChange, { once: true })
  }
  registerDprWatcher()

  const enc = new TextEncoder()
  const logOnData = createOnDataLogger()
  term.onData((s) => {
    const bytes = enc.encode(s)
    // 每次 onData 都记字节数 + hex 预览：这是回答"英文到底有没有发出去"
    // 最直接的证据，比任何推理都可靠（节流规则见 byte-throttle.ts）。
    logOnData(bytes)
    opts.onInput(bytes)
  })
  term.onResize(({ cols, rows }) => {
    log(`resize → ${cols} × ${rows}`)
    opts.onResize(cols, rows)
  })

  return {
    write(bytes) {
      // xterm 写完后回调，这时才算真正消费，用于流控
      term.write(bytes, () => opts.onConsumed(bytes.byteLength))
    },
    dispose() {
      themeQuery.removeEventListener('change', onThemeChange)
      dprQuery.removeEventListener('change', onDprChange)
      window.removeEventListener('focus', onWindowFocus)
      term.dispose()
    },
  }
}
