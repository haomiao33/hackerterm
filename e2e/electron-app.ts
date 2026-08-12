/**
 * 端到端测试的启动器：用 Playwright 的 `_electron.launch()` 拉起**真实构建产物**
 * （out/main/index.js），跑真的主进程 + utility 进程 + Rust 原生模块 + 真 PTY。
 *
 * 为什么是 playwright-core 而不是 playwright：Electron 模式下 Playwright 用的是
 * 应用自带的那份 Electron 二进制，不需要 Chromium/Firefox/WebKit 那三份浏览器
 * 二进制（约 300MB）。playwright-core 这个包本身就不带下载器，装它等于零额外
 * 下载。（等价做法是装 playwright 时设 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1，
 * 但那要求每个装依赖的人/每条 CI 都记得设这个变量，不如换个包来得可靠。）
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 构建产物入口。测试跑的必须是这个，不是 dev server。 */
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js')

/**
 * 启动到终端挂载完成的超时。冷启动要经过 Electron 起进程、fork utility 进程、
 * 加载 napi 原生模块、协议握手、session.open 建 PTY 这一长串，本机实测约 1-2 秒，
 * CI 上（尤其带 Rust 编译缓存未命中的机器）会慢不少，留足余量。
 */
export const MOUNT_TIMEOUT_MS = 60_000

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
}

/**
 * 拉起应用并等到终端真正挂载完成。
 *
 * “挂载完成”的判据是 `window.__htDiagnostics.term` 出现（见
 * src/ui/browser/terminal/mount.ts 里那段注释）。这个判据不只是“页面加载完了”：
 * mountTerminal 只在数据端口就绪之后才被调用（boot.ts 的 waitForDataPort），
 * 所以它出现就意味着**协议握手成功、session.open 成功、数据面 MessagePort
 * 两端都接好了**。等到它，后面敲键才有意义。
 */
export async function launchApp(): Promise<LaunchedApp> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `找不到构建产物 ${MAIN_ENTRY}。端到端测试跑的是真实产物，请先执行：\n` +
      '  pnpm build:native && pnpm build',
    )
  }

  const app = await electron.launch({
    args: [MAIN_ENTRY],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // 类 Unix 下核心用 $SHELL 决定开哪个 shell（crates/ht-core/src/session.rs
      // 的 default_shell），缺省回退是 /bin/zsh——很多 CI 镜像/容器里根本没装
      // zsh，会话就会开不起来。这里钉死 bash，让测试结果不受宿主环境影响。
      // Windows 上这个变量不参与决策（那边固定 powershell.exe），设了也无害。
      ...(process.platform === 'win32' ? {} : { SHELL: '/bin/bash' }),
    },
  })

  const page = await app.firstWindow()
  await page.waitForFunction(
    () => Boolean(window.__htDiagnostics?.term),
    undefined,
    { timeout: MOUNT_TIMEOUT_MS },
  )
  return { app, page }
}

/**
 * 读 xterm 的屏幕缓冲区（`term.buffer.active` 逐行 `translateToString()`）。
 *
 * 这是整套测试的立身之本：断言必须落在**屏幕上真的出现了什么字符**，而不是
 * “没抛异常”或“元素存在”。历史上四个真故障（xterm.css 没引入、MessagePort
 * transfer 静默丢消息、亮色主题光标不可见、读线程吞错误）全都不抛异常，
 * 只表现为屏幕上没东西——只有读缓冲区能抓到它们。
 */
export async function readScreen(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const term = window.__htDiagnostics!.term
    const buf = term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      // translateToString(true)：裁掉行尾空白，否则每行都被补齐到 cols 宽，
      // 断言“这一行就是 hello”会被一堆尾随空格搅黄。
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }
    return lines
  })
}

/**
 * 轮询屏幕缓冲区直到 `predicate` 满足，超时则抛错并把当前屏幕内容一并带出来
 * （失败时最需要看的就是“屏幕上到底有什么”）。
 */
export async function waitForScreen(
  page: Page,
  predicate: (lines: string[]) => boolean,
  { timeoutMs = 20_000, what = 'screen condition' }: { timeoutMs?: number, what?: string } = {},
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  let lines: string[] = []
  for (;;) {
    lines = await readScreen(page)
    if (predicate(lines)) return lines
    if (Date.now() > deadline) {
      throw new Error(
        `等待「${what}」超时（${timeoutMs}ms）。当前屏幕内容：\n` +
        lines.filter((l) => l.length > 0).map((l) => `  | ${l}`).join('\n'),
      )
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** 页面诊断日志区（#log）的全文，失败时打出来最能说明卡在链路哪一节。 */
export async function readDiagnosticLog(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('log')?.textContent ?? '')
}

/**
 * Linux 上 Electron 内 fork PTY 子进程会被 Chromium 的 fd 归属检查打死的特征串。
 *
 * portable-pty 在 fork 之后、exec 之前调 `close_random_fds()` 逐个 close 掉
 * fd > 2；而 Chromium 在自己的可执行文件里覆盖了 `close()` 符号，一旦发现被关的
 * fd 是它用 ScopedFD 登记过的，就直接 IMMEDIATE_CRASH。结果是子进程还没 exec
 * 就死了，把这段栈回溯写进了 PTY（所以它会出现在终端屏幕上），shell 从来没跑起来。
 *
 * 这条限制只在 Linux 成立：Windows 走 ConPTY，根本没有 fork/close-fds 这一段。
 * 详见报告。测试用**屏幕上真的出现了这段崩溃回溯**作为判据（而不是
 * `process.platform === 'linux'`），这样哪天上游修好了，被跳过的断言会自动恢复
 * 执行，不需要有人记得回来改测试。
 */
export const FD_OWNERSHIP_CRASH_MARKER = 'FD ownership violation'

export function ptyChildFailedToExec(lines: string[]): boolean {
  return lines.some((l) => l.includes(FD_OWNERSHIP_CRASH_MARKER))
}
