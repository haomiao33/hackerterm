/**
 * 时延分段测量：回答「敲一个键到屏幕上出现回显的那 14–20ms，PTY 自己占多少、
 * 我们的 IPC 占多少」。
 *
 * 跑法（Linux 需要 X 服务器，用 xvfb 起一个）：
 *   pnpm build:native && pnpm build
 *   xvfb-run -a pnpm measure:latency        # Linux
 *   pnpm measure:latency                    # Windows / macOS
 *
 * ── 六个理论测点，实际测到了哪几个 ─────────────────────────────────────
 *
 * 任务给的分段是：
 *   t0 xterm onData 触发（渲染进程）
 *   t1 字节到达 core-host
 *   t2 Rust 侧写入 PTY 之后
 *   t3 Rust 侧从 PTY 读回
 *   t4 字节到达渲染进程
 *   t5 xterm write 回调（消费完成）
 *
 * t1 / t2 / t3 / t4 这四个点要拿到，就得往 src/core-host/index.ts 和
 * crates/ht-core/src/session.rs 的**热路径上插时间戳并把它们回传出来**——前者是
 * 本轮明令不得改动业务逻辑的文件，后者往数据面加旁路上报等于改行为。所以这里
 * 换了个不碰生产代码的做法：**用三条嵌套的往返，靠相减把中间几段挤出来**。
 *
 *   FULL  = t0 → t5   渲染进程整程往返（xterm onData → xterm 解析完回显）
 *           在页面里挂 term.onData / term.onWriteParsed 量，全程不改 boot.ts。
 *   NAPI  = 普通 Node 进程里 sendData() → startData() 回调
 *           ≈ t1 → t4 去掉两跳 MessagePort，即 napi 进出 + Rust + PTY。
 *   PTY   = 纯 Rust：SessionManager::write() → data_out 回调
 *           = t2 → t3，即 PTY 自己（写系统调用 + 内核行规程回显 + 读线程唤醒）。
 *
 * 于是：
 *   PTY               = PTY 本身的开销
 *   NAPI − PTY        = napi/线程安全函数 + Node 事件循环那一跳
 *   FULL − NAPI       = 我们自己的 Electron 链路：两跳数据面 MessagePort
 *                       （渲染 ↔ utility，各一次 structured clone）+ preload/渲染
 *                       进程调度 + xterm 解析回显
 *
 * 直接测不到、只能这么倒推的是 t1、t2、t3、t4 这四个点各自的绝对时刻；能给出的
 * 是上面三段的**分布**。这一点在报告里如实写明，不假装六段都测了。
 *
 * 三条往返量的都是「往 PTY 写一个可打印字符、等它被行规程回显回来」，口径完全
 * 一致，所以相减有意义；也正因为回显来自内核行规程而不是 shell，测量不掺 shell
 * 的调度抖动。
 */
import { spawn } from 'node:child_process'
import { launchApp, REPO_ROOT } from './electron-app'
import { openCoreSession } from './core-session'

/** 每段采样次数。几十次才谈得上中位数/p95。 */
const SAMPLES = 60
/** 两次采样之间的间隔：留足时间让上一轮完全走完，避免相邻两轮互相污染。 */
const GAP_MS = 120
/**
 * 正式采样前先空跑几轮丢掉。实测头几次往返要 20-30ms、之后稳定在几毫秒——
 * 那是 V8 的 JIT、xterm 的首次解析路径、渲染进程首次唤醒等一次性开销，
 * 混进样本里会把中位数和 p95 一起抬高，掩盖稳态的真实分布。
 */
const WARMUP = 10

interface Stats {
  n: number
  min: number
  median: number
  p95: number
  max: number
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    n: sorted.length,
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  }
}

const ms = (v: number): string => v.toFixed(2).padStart(7)

function printRow(label: string, s: Stats): void {
  console.log(
    `${label.padEnd(34)} n=${String(s.n).padStart(3)}  ` +
    `min=${ms(s.min)}  中位数=${ms(s.median)}  p95=${ms(s.p95)}  max=${ms(s.max)}  (ms)`,
  )
}

// ── PTY 段（纯 Rust，t2 → t3）────────────────────────────────────────────
async function measurePty(): Promise<number[]> {
  console.log('· PTY 段（纯 Rust，t2 → t3）：cargo run --example pty_latency …')
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      'cargo',
      ['run', '-p', 'ht-core', '--release', '--example', 'pty_latency'],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
    )
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { stdout += c })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`cargo run --example pty_latency 退出码 ${code}`))
    })
  })
  const line = out.split('\n').find((l) => l.startsWith('PTY_LATENCY_JSON '))
  if (!line) throw new Error(`没在 cargo 输出里找到 PTY_LATENCY_JSON 行：\n${out}`)
  return (JSON.parse(line.slice('PTY_LATENCY_JSON '.length)) as { samples_ms: number[] }).samples_ms
}

// ── NAPI 段（普通 Node 进程，≈ t1 → t4 去掉两跳 MessagePort）──────────────
async function measureNapi(): Promise<number[]> {
  console.log('· NAPI 段（Node → napi → Rust → PTY → 回来）…')
  const session = await openCoreSession()
  let resolveRoundtrip: (() => void) | null = null
  session.onData(() => { resolveRoundtrip?.() })

  // 会话刚开，shell 的横幅还在路上，先晾一会儿。
  await new Promise((r) => setTimeout(r, 1000))

  const samples: number[] = []
  const byte = new TextEncoder().encode('x')
  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    const started = performance.now()
    const done = new Promise<void>((res) => { resolveRoundtrip = res })
    session.write(byte)
    await done
    if (i >= WARMUP) samples.push(performance.now() - started)
    resolveRoundtrip = null
    await new Promise((r) => setTimeout(r, GAP_MS))
  }
  await session.close()
  return samples
}

// ── FULL 段（真 Electron，t0 → t5）───────────────────────────────────────
async function measureFull(): Promise<number[]> {
  console.log('· FULL 段（真 Electron，渲染进程整程往返 t0 → t5）…')
  const { app, page } = await launchApp()
  try {
    // 埋点全部挂在页面里，一行生产代码都不改：
    // - t0 取 term.onData——和 boot.ts 里 onInput 同一个事件源。xterm 支持挂多个
    //   监听器，我们这个只读时间、不干预数据。
    // - t5 取 term.write 的完成回调。boot.ts 里就是 `term.write(bytes, cb)`，cb
    //   触发即"xterm 消费完成"，正是任务定义的 t5。这里在测试侧把实例上的 write
    //   包一层再转调原函数（mount.ts 返回的 handle 是在调用时才查 term.write，
    //   所以包在实例上就能拦到），既拿到了准确的 t5，又不动一行生产代码。
    //   （不用 term.onWriteParsed：实测这个公开事件在 @xterm/xterm 6 上根本不
    //   触发，写回调是可靠的那个。）
    await page.evaluate(() => {
      const term = window.__htDiagnostics!.term
      const state: { pendingT0: number | null, samples: number[] } = { pendingT0: null, samples: [] }
      ;(window as unknown as { __htLatency: typeof state }).__htLatency = state

      term.onData(() => { state.pendingT0 = performance.now() })

      const originalWrite = term.write.bind(term)
      term.write = (data: string | Uint8Array, callback?: () => void): void => {
        originalWrite(data, () => {
          // pendingT0 为空说明这次 write 不是某次按键的回显（比如会话横幅），跳过。
          if (state.pendingT0 !== null) {
            state.samples.push(performance.now() - state.pendingT0)
            state.pendingT0 = null
          }
          callback?.()
        })
      }
    })

    await new Promise((r) => setTimeout(r, 1000))
    for (let i = 0; i < WARMUP + SAMPLES; i++) {
      await page.keyboard.press('x')
      await new Promise((r) => setTimeout(r, GAP_MS))
    }
    const all = await page.evaluate(
      () => (window as unknown as { __htLatency: { samples: number[] } }).__htLatency.samples,
    )
    return all.slice(WARMUP)
  } finally {
    await app.close()
  }
}

async function main(): Promise<void> {
  console.log('HackerTerm 键盘 → PTY → 屏幕 时延分段测量')
  console.log(`平台 ${process.platform}，每段 ${SAMPLES} 次采样\n`)

  // 依次跑，不并行：三段互相抢 CPU 会把测量本身搅浑。
  const pty = await measurePty()
  const napi = await measureNapi()
  const full = await measureFull()

  console.log('\n── 分段结果 ─────────────────────────────────────────────────')
  printRow('PTY   t2→t3  PTY 自己', stats(pty))
  printRow('NAPI  ≈t1→t4 +napi/Node', stats(napi))
  printRow('FULL  t0→t5  整程（含两跳 MessagePort + xterm）', stats(full))

  const p = stats(pty).median, n = stats(napi).median, f = stats(full).median
  console.log('\n── 按中位数拆账 ─────────────────────────────────────────────')
  console.log(`PTY 本身                       ${ms(p)} ms  (${((p / f) * 100).toFixed(1)}%)`)
  console.log(`napi / 线程安全函数 / Node      ${ms(n - p)} ms  (${(((n - p) / f) * 100).toFixed(1)}%)`)
  console.log(`我们的 Electron 链路 + xterm    ${ms(f - n)} ms  (${(((f - n) / f) * 100).toFixed(1)}%)`)
  console.log(`整程合计                       ${ms(f)} ms`)
}

main().then(
  () => {
    // 显式退出：ht-node 里的 Core 是 Rust 侧的 OnceLock 全局，配套的读线程/线程
    // 安全函数没有拆卸接口，进程的事件循环不会自然清空。测量脚本已经把该打印的
    // 都打印完了，直接退出即可，不需要为此给生产代码加一个只有测量用得到的
    // "关掉核心" API。
    process.exit(0)
  },
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
