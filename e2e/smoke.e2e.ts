/**
 * 「键盘 → PTY → 屏幕」最短链路的 headless 端到端冒烟测试。
 *
 * 为什么必须有它：项目连着两天没跑通 demo，四个真故障——xterm.css 没引入、
 * 数据面 MessagePort transfer 静默丢消息、亮色主题光标不可见、PTY 读线程吞
 * 错误——全部落在这条链路上，而这条链路从来没有被自动化验证过，每一轮排查
 * 都靠人下载安装包手敲键截图，一轮一天。
 *
 * 断言口径：**必须断言字节真的走完全程**，也就是读 xterm 的屏幕缓冲区看上面
 * 到底出现了什么字符。只断言“没抛异常”“元素存在”是假测试——上面四个故障
 * 没有一个会抛异常。
 *
 * 这一轮敲下去的字节要依次经过：
 *   渲染进程 keydown → xterm onData → 数据面 MessagePort（渲染 → utility）
 *   → core-host → napi sendData → Rust SessionManager::write → PTY 主端
 *   → 内核行规程回显 → Rust 读线程 → napi 线程安全函数 → core-host
 *   → 数据面 MessagePort（utility → 渲染）→ xterm write → 屏幕缓冲区
 * 中间任何一环哑火，屏幕上就不会出现这些字符，测试就红。
 */
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { ElectronApplication, Page } from 'playwright-core'
import {
  launchApp, MOUNT_TIMEOUT_MS, ptyChildFailedToExec, readDiagnosticLog, readScreen, waitForScreen,
} from './electron-app'

/** 敲进去的命令。选 echo 是因为它在 bash 和 PowerShell 上都存在、输出都只有一行。 */
const COMMAND = 'echo hello'
/** 命令的预期输出。 */
const EXPECTED_OUTPUT = 'hello'

/**
 * 每个字符之间的间隔。不是为了“像人”——是为了让每个字节各自走一趟完整往返，
 * 避免被合并成一条消息，从而让“回显逐字出现”这件事本身也被验证到。
 */
const TYPE_DELAY_MS = 30

let app: ElectronApplication
let page: Page
/** PTY 子进程是否真的 exec 成功了（Linux 上会失败，见下面那条 test 的注释）。 */
let childExeced = false

beforeAll(async () => {
  ({ app, page } = await launchApp())

  // 终端刚挂载，会话的首批输出（提示符/横幅）还在路上，先等它落屏再敲键，
  // 否则回显和首批输出会在缓冲区里交错，断言读起来全是噪声。
  await waitForScreen(page, (lines) => lines.some((l) => l.length > 0), {
    what: '会话首批输出落屏',
  }).catch(() => {
    // 首批输出不是断言对象，等不到也继续——真正的判据是下面的回显。
  })

  await page.keyboard.type(COMMAND, { delay: TYPE_DELAY_MS })
  await page.keyboard.press('Enter')
}, MOUNT_TIMEOUT_MS + 30_000)

afterAll(async () => {
  await app?.close()
})

test('敲进去的字符有回显：字节走完了渲染 → PTY → 渲染的整条往返', async () => {
  const lines = await waitForScreen(page, (ls) => ls.some((l) => l.includes(COMMAND)), {
    what: `回显 "${COMMAND}"`,
  })

  // 这条断言就是那个已知 bug（boot.ts 把 dataPort.postMessage(bytes) 换成
  // postMessage(bytes.buffer, [bytes.buffer])，electron#34905 静默丢整条消息）
  // 的探针：出向一断，PTY 收不到字节，回显自然不会出现，这里必红。
  expect(lines.some((l) => l.includes(COMMAND)),
    `屏幕上没有出现回显 "${COMMAND}"。诊断日志：\n${await readDiagnosticLog(page)}`).toBe(true)
})

test('命令真的执行了：屏幕上出现命令输出 hello', async (ctx) => {
  const lines = await readScreen(page)

  // Linux 专有：PTY 子进程 fork 之后、exec 之前就被 Chromium 的 fd 归属检查
  // 打死了（见 electron-app.ts 里 FD_OWNERSHIP_CRASH_MARKER 的注释），shell
  // 从来没跑起来，屏幕上那些回显是内核行规程给的，不是 shell 给的，也就不会有
  // 任何命令输出。这不是本项目的代码 bug，也不是这条测试的判据松了——上一条
  // 回显断言已经把我们自己的整条 IPC 链路验证完了。
  //
  // 判据取自屏幕上真的出现了崩溃回溯，而不是 process.platform：上游哪天修好，
  // 这条断言会自动恢复执行。Windows（产品的正式目标平台）走 ConPTY，没有这段
  // fork/close-fds 逻辑，这条断言在那边是实打实执行的。
  if (ptyChildFailedToExec(lines)) {
    ctx.skip(
      'PTY 子进程在 Linux 上没能 exec：Chromium 的 fd 归属检查在 portable-pty 的 ' +
      'close_random_fds() 里把 fork 出来的子进程打死了（屏幕上有 "Crashing due to ' +
      'FD ownership violation" 回溯）。shell 没跑起来，不可能有命令输出。' +
      '上一条回显断言已覆盖本项目自己的全部链路。',
    )
    return
  }

  const found = await waitForScreen(
    page,
    // 输出行要跟回显行区分开：回显那行是 "…$ echo hello"，输出那行整行就是 "hello"。
    (ls) => ls.some((l) => l.trim() === EXPECTED_OUTPUT),
    { what: `命令输出 "${EXPECTED_OUTPUT}"` },
  )
  expect(found.some((l) => l.trim() === EXPECTED_OUTPUT),
    `屏幕上没有出现命令输出 "${EXPECTED_OUTPUT}"。诊断日志：\n${await readDiagnosticLog(page)}`)
    .toBe(true)
})
