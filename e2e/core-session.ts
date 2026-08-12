/**
 * 不经过 Electron，直接在普通 Node 进程里驱动一条真会话：
 * napi（ht-node）→ Rust Core → SessionManager → 真 PTY → 真 shell。
 *
 * 存在的理由有两个：
 *
 * 1. 补上 Electron 端到端测试在 Linux 上补不了的那一块。Linux 下 Electron 进程内
 *    fork PTY 子进程会被 Chromium 的 fd 归属检查打死（见 electron-app.ts 里
 *    FD_OWNERSHIP_CRASH_MARKER 的注释），shell 根本没跑起来，也就没有命令输出可断言。
 *    普通 Node 进程里没有那个被 Chromium 覆盖过的 `close()`，shell 能正常起来，
 *    于是「命令真的执行、真的有输出」这件事在 Linux 上仍然有自动化断言兜底。
 *
 * 2. 它天然是时延分段测量里的一个测点：这条路径 = 完整链路减去两跳数据面
 *    MessagePort、减去 xterm 解析。跟渲染进程量到的整程往返一减，就能把
 *    「ConPTY/PTY 自己占多少」和「我们的 IPC 占多少」拆开（见 latency.ts）。
 */
import {
  Envelope, Hello, SessionCloseRequest, SessionOpenRequest, SessionOpenResponse,
} from '../src/ui/common/protocol/hackerterm'

/** 协议请求的自增 id。核心按 id 配对响应，只要不重复就行。 */
let nextRequestId = 1

export interface CoreSession {
  sessionId: string
  /** 往 PTY 写字节（等价于渲染进程敲键）。 */
  write(bytes: Uint8Array): void
  /** 注册 PTY 出向字节的回调。回调在 napi 线程安全函数上被调用。 */
  onData(cb: (bytes: Uint8Array) => void): void
  /** 关掉会话，杀掉 shell 子进程。不关的话测试进程退出后会留下孤儿 shell。 */
  close(): Promise<void>
}

type CoreModule = typeof import('ht-node')

/**
 * 加载 ht-node、握手、开一条真会话。
 *
 * 注意 `start()`/`start_data()` 在 Rust 侧是 OnceLock，**一个进程只能调一次**，
 * 所以这个函数每个进程只能调用一次；vitest 那边用 `pool: 'forks'` 保证每个测试
 * 文件独占一个进程。
 */
export async function openCoreSession(
  { cols = 80, rows = 24 }: { cols?: number, rows?: number } = {},
): Promise<CoreSession> {
  // 类 Unix 下核心用 $SHELL 决定开哪个 shell，缺省回退 /bin/zsh 很多机器上没装，
  // 这里跟 Electron 那边保持同一个口径，钉死 bash。
  if (process.platform !== 'win32') process.env.SHELL ??= '/bin/bash'

  const core: CoreModule = await import('ht-node')

  const pending = new Map<number, {
    resolve: (payload: Uint8Array) => void
    reject: (err: Error) => void
  }>()
  const dataListeners: ((bytes: Uint8Array) => void)[] = []

  // 顺序很重要：start_data 必须在 start 之前（Rust 侧注释写死了这个契约）。
  core.startData((_sessionId: string, buf: Buffer) => {
    const bytes = new Uint8Array(buf)
    for (const cb of dataListeners) cb(bytes)
  })

  core.start((buf: Buffer) => {
    const env = Envelope.decode(new Uint8Array(buf))
    // 只关心响应；session.exit / session.state 这些事件这里用不到，直接忽略。
    if (!env.response) return
    const waiter = pending.get(env.response.id)
    if (!waiter) return
    pending.delete(env.response.id)
    // 协议错误要抛出来而不是当空响应吞掉——不然 session.open 失败会表现成
    // 「sessionId 是空串」，后面写字节石沉大海，排查时完全看不出根因。
    if (env.response.error) {
      waiter.reject(new Error(`${env.response.error.key}: ${env.response.error.detail}`))
      return
    }
    waiter.resolve(env.response.payload ?? new Uint8Array())
  })

  function request(method: string, payload: Uint8Array): Promise<Uint8Array> {
    const id = nextRequestId++
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`核心在 10s 内没有回应 ${method}（id=${id}）`))
      }, 10_000)
      pending.set(id, {
        resolve: (p) => { clearTimeout(timer); resolve(p) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      core.send(Buffer.from(Envelope.encode({ request: { id, method, payload } }).finish()))
    })
  }

  await request('hello', Hello.encode({
    protocolMajor: 1, protocolMinor: 0, minSupportedMajor: 1,
    implVersion: 'e2e', capabilities: [],
  }).finish())

  const openPayload = await request('session.open', SessionOpenRequest.encode({
    shell: '', cols, rows, cwd: '',
  }).finish())
  const { sessionId } = SessionOpenResponse.decode(openPayload)

  return {
    sessionId,
    write: (bytes) => core.sendData(sessionId, Buffer.from(bytes)),
    onData: (cb) => dataListeners.push(cb),
    close: async () => {
      await request('session.close', SessionCloseRequest.encode({ sessionId }).finish())
    },
  }
}
