/**
 * 不经过 Electron，直接在普通 Node 进程里驱动真会话：
 * napi（ht-node）→ Rust Core → SessionManager → 真 PTY → 真 shell。
 *
 * 存在的理由有三个：
 *
 * 1. 补上 Electron 端到端测试在 Linux 上补不了的那一块。Linux 下 Electron 进程内
 *    fork PTY 子进程会被 Chromium 的 fd 归属检查打死（见 electron-app.ts 里
 *    FD_OWNERSHIP_CRASH_MARKER 的注释），shell 根本没跑起来，也就没有命令输出可断言。
 *    普通 Node 进程里没有那个被 Chromium 覆盖过的 `close()`，shell 能正常起来，
 *    于是「命令真的执行、真的有输出」这件事在 Linux 上仍然有自动化断言兜底。
 *
 * 2. 它是时延测量的 NAPI 段：这条路径 = 完整链路减去两跳数据面 MessagePort、
 *    减去 xterm 解析（见 latency.ts）。
 *
 * 3. 它让"同一条管道换一个从端程序"成为可能——`e2e/shell-cost.ts` 靠这一点在同
 *    一个进程里同时开一条裸 PTY 会话和一条真 bash 会话，交替按键，量出 shell
 *    自己占了多少。这就是 `connectCore()` 要跟 `openCoreSession()` 分开的原因：
 *    `start()`/`start_data()` 在 Rust 侧是 OnceLock，**一个进程只能调一次**，
 *    所以"连上核心"和"开一条会话"必须是两件事。
 */
import {
  CoreStatsRequest, CoreStatsResponse,
  Envelope, Hello, SessionAckRequest, SessionCloseRequest, SessionOpenRequest, SessionOpenResponse,
  SessionSignalRequest, Signal,
} from '../src/ui/common/protocol/hackerterm'

/** 协议请求的自增 id。核心按 id 配对响应，只要不重复就行。 */
let nextRequestId = 1

export interface SessionOptions {
  cols?: number
  rows?: number
  /**
   * PTY 从端跑什么程序。空串 = 核心的默认 shell（`session.rs::default_shell()`，
   * 类 Unix 读 `$SHELL`、缺省 /bin/zsh；Windows 固定 powershell.exe）。
   */
  shell?: string
}

export interface CoreSession {
  sessionId: string
  /** 往 PTY 写字节（等价于渲染进程敲键）。 */
  write(bytes: Uint8Array): void
  /** 注册**这条会话**出向字节的回调。回调在 napi 线程安全函数上被调用。 */
  onData(cb: (bytes: Uint8Array) => void): void
  /**
   * 确认消费了 `bytesConsumed` 字节，等价于渲染层 `AckBatcher` 冲刷时发的那条
   * `session.ack`。
   *
   * 为什么测试也必须发 ack：核心的流控窗口（`flow.rs`）只认 ack。不发 ack 的
   * 消费方在核心眼里等于"一个字节都没消费"，未确认量涨过高水位后读线程直接
   * 暂停，五秒后看门狗强制清零窗口（`session.flow_stalled`）——量出来的既不是
   * 真实吞吐，也不是真实的水位行为，而是一条**永远处于降级路径**的假链路。
   * 压测要检验的恰恰是 1MiB/256KiB 这对水位在**正常 ack 节奏**下到底管不管用，
   * 所以这里必须把渲染层那半边补上。
   */
  ack(bytesConsumed: number): Promise<void>
  /** 发一次中断（`session.signal` + SIGNAL_INT，核心侧就是往 PTY 写 0x03）。 */
  signalInt(): Promise<void>
  /** 关掉会话，杀掉子进程。不关的话测试进程退出后会留下孤儿进程。 */
  close(): Promise<void>
}

export interface CoreConnection {
  /** 在同一个核心上再开一条会话。可以开多条，出向数据按 sessionId 分流。 */
  openSession(options?: SessionOptions): Promise<CoreSession>
  /**
   * 订阅核心主动推的事件（`session.exit` / `session.state` /
   * `session.flow_stalled`），回调拿到的是**未解码**的 payload。
   *
   * 压测需要它的理由很具体：`session.flow_stalled` 是"我们刚刚放弃了一次背压"
   * 的自白书。一次刷屏压测如果吞吐漂亮但中途报了 flow_stalled，说明水位其实
   * 没起作用、是看门狗在兜底——那个数字不能拿来给水位背书。所以压测必须能
   * 看见这个事件，而不能只看收了多少字节。
   */
  onEvent(topic: string, cb: (payload: Uint8Array) => void): void
  /**
   * 向核心要一次诊断快照（控制面的 `core.stats` 方法）。
   *
   * 目前只有一个字段：**存活的 PTY 读线程数**。并发测试拿它当"会话数和线程数
   * 对不对得上"的直接判据——每条会话恰好一个读线程，会话全关掉之后必须归零。
   * 这比"数据还来不来"强得多：读线程静默退出（`Ok(0) | Err(_)` 那两个分支曾经
   * 是直接 break、连日志都没有）时，症状只是"某条会话不再有输出"，从外面看跟
   * "shell 正好没输出"分辨不出来，而这个数字会直接掉下去。
   */
  stats(): Promise<{ liveReadThreads: number }>
}

type CoreModule = typeof import('ht-node')

/** 进程内是否已经连过核心。第二次调用是编程错误，直接抛，不要等 Rust 侧的 OnceLock。 */
let connected = false

/**
 * 加载 ht-node、握手，返回一个可以反复开会话的连接。
 *
 * `start()`/`start_data()` 在 Rust 侧是 OnceLock，**一个进程只能调一次**，所以这
 * 个函数每个进程只能调用一次；vitest 那边用 `pool: 'forks'` 保证每个测试文件独占
 * 一个进程。
 */
export async function connectCore(): Promise<CoreConnection> {
  if (connected) {
    throw new Error('connectCore() 一个进程只能调用一次（Rust 侧 start()/start_data() 是 OnceLock）')
  }
  connected = true

  // 类 Unix 下核心用 $SHELL 决定开哪个 shell，缺省回退 /bin/zsh 很多机器上没装，
  // 这里跟 Electron 那边保持同一个口径，钉死 bash。
  if (process.platform !== 'win32') process.env.SHELL ??= '/bin/bash'

  const core: CoreModule = await import('ht-node')

  const pending = new Map<number, {
    resolve: (payload: Uint8Array) => void
    reject: (err: Error) => void
  }>()
  // 按会话分流：多条会话同时开着时，把所有字节广播给所有监听器会让两条会话的
  // 数据互相污染——而这正是 shell-cost.ts 那种"同时开两条会话交替按键"的用法。
  const dataListeners = new Map<string, ((bytes: Uint8Array) => void)[]>()

  // 顺序很重要：start_data 必须在 start 之前（Rust 侧注释写死了这个契约）。
  core.startData((sessionId: string, buf: Buffer) => {
    const listeners = dataListeners.get(sessionId)
    if (!listeners) return
    const bytes = new Uint8Array(buf)
    for (const cb of listeners) cb(bytes)
  })

  // 事件订阅表。默认没人订阅，行为跟以前一样（事件被忽略）。
  const eventListeners = new Map<string, ((payload: Uint8Array) => void)[]>()

  core.start((buf: Buffer) => {
    const env = Envelope.decode(new Uint8Array(buf))
    if (env.event) {
      for (const cb of eventListeners.get(env.event.topic) ?? []) {
        cb(env.event.payload ?? new Uint8Array())
      }
      return
    }
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

  return {
    onEvent(topic, cb) {
      const list = eventListeners.get(topic)
      if (list) list.push(cb)
      else eventListeners.set(topic, [cb])
    },
    async stats() {
      const payload = await request('core.stats', CoreStatsRequest.encode({}).finish())
      const { liveReadThreads } = CoreStatsResponse.decode(payload)
      return { liveReadThreads }
    },
    async openSession({ cols = 80, rows = 24, shell = '' }: SessionOptions = {}): Promise<CoreSession> {
      const openPayload = await request('session.open', SessionOpenRequest.encode({
        shell, cols, rows, cwd: '',
      }).finish())
      const { sessionId } = SessionOpenResponse.decode(openPayload)
      dataListeners.set(sessionId, [])
      return {
        sessionId,
        write: (bytes) => core.sendData(sessionId, Buffer.from(bytes)),
        onData: (cb) => { dataListeners.get(sessionId)!.push(cb) },
        ack: async (bytesConsumed) => {
          await request('session.ack', SessionAckRequest.encode({ sessionId, bytesConsumed }).finish())
        },
        signalInt: async () => {
          await request('session.signal', SessionSignalRequest.encode({
            sessionId, signal: Signal.SIGNAL_INT,
          }).finish())
        },
        close: async () => {
          await request('session.close', SessionCloseRequest.encode({ sessionId }).finish())
          dataListeners.delete(sessionId)
        },
      }
    },
  }
}

/** 连核心 + 开一条会话。只需要一条会话时用这个（每个进程同样只能调一次）。 */
export async function openCoreSession(options: SessionOptions = {}): Promise<CoreSession> {
  const core = await connectCore()
  return core.openSession(options)
}
