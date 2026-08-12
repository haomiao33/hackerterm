/**
 * 「napi → Rust → 真 PTY → 真 shell」这一段的端到端断言，不经过 Electron。
 *
 * 和 smoke.e2e.ts 的分工：
 * - smoke.e2e.ts 覆盖**我们自己写的全部链路**（xterm ↔ MessagePort ↔ core-host
 *   ↔ napi ↔ Rust ↔ PTY），判据是屏幕上真的出现了回显字符。
 * - 这个文件覆盖**shell 真的被执行、真的产出了命令输出**这件事。它之所以要单独
 *   存在，是因为 Linux 上 Electron 进程内根本 fork 不出 PTY 子进程（Chromium 的
 *   fd 归属检查，见 electron-app.ts 的注释），那条断言在 Linux 上只能跳过；放在
 *   普通 Node 进程里就没有这个问题，于是这件事在任何平台上都有自动化断言兜底。
 */
import { expect, test } from 'vitest'
import { openCoreSession } from './core-session'

/** 会话开起来 + 敲一条命令 + 等输出，本机不到 1 秒，CI 上留足余量。 */
const TEST_TIMEOUT_MS = 60_000

test('echo hello 经 napi → Rust → PTY → shell 走一遭，拿回真实命令输出', async () => {
  const session = await openCoreSession()

  let received = ''
  const decoder = new TextDecoder()
  session.onData((bytes) => { received += decoder.decode(bytes, { stream: true }) })

  // 等 shell 把提示符打完再敲命令：shell 还没准备好就往 PTY 里灌字节，字节不会丢
  // （在 PTY 缓冲里排队），但输出顺序会跟提示符交错，断言读起来全是噪声。
  await waitUntil(() => received.length > 0, 'shell 首批输出', 20_000)

  const beforeCommand = received.length
  session.write(new TextEncoder().encode('echo hello\r'))

  // 判据：命令**输出**那一行。回显那行长得像 "echo hello"，输出那行是独立的
  // "hello"，所以要找一个跟在换行后面、且不是回显的 hello。这里用最直接的办法：
  // 命令发出去之后新收到的内容里，出现了不属于回显串 "echo hello" 的那个 hello。
  await waitUntil(
    () => outputAfterEcho(received.slice(beforeCommand)).includes('hello'),
    '命令输出 hello',
    20_000,
  )

  const tail = received.slice(beforeCommand)
  expect(outputAfterEcho(tail), `PTY 回传内容：\n${JSON.stringify(tail)}`).toContain('hello')

  // 收尾：不关会话的话，测试进程退出后会留下一个孤儿 shell。
  await session.close()
}, TEST_TIMEOUT_MS)

/**
 * 把回显部分（命令本身那串字符）剪掉，只留下真正的命令输出。
 * shell 先把敲进去的 "echo hello" 原样回显、再换行、再打印输出，所以第一个换行
 * 之后的部分才是输出。
 */
function outputAfterEcho(raw: string): string {
  const firstNewline = raw.search(/[\r\n]/)
  return firstNewline < 0 ? '' : raw.slice(firstNewline)
}

async function waitUntil(pred: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`等待「${what}」超时（${timeoutMs}ms）`)
    await new Promise((r) => setTimeout(r, 50))
  }
}
