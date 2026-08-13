/**
 * 「shell 自己占多少」的本地对照测量：**同一条管道**（Node → napi → Rust →
 * PTY），一边跑不做回显的从端程序（回显由内核行规程给出，等价于"裸 PTY"），
 * 一边跑真 shell，交替按键，比较按键往返分布。
 *
 * 跑法：`pnpm measure:shell-cost`（不需要 Electron、不需要 X server、无人工）
 *
 * ── 为什么这条对照最有决策价值 ──────────────────────────────────────────
 *
 * 真机（Windows + PowerShell）上量到的按键往返是 10–41ms，而 CI 上整程往返只有
 * 1.1–1.2ms，差 10–30 倍。假设是：**大头是 shell 自己**——PSReadLine 每次按键都
 * 做语法高亮 + 整行重绘，那部分工作发生在 PTY 从端，跟我们的 IPC 一点关系都没有。
 * 如果这个假设成立，优化 IPC 的天花板就极低，投入应该转向别处。
 *
 * 这个假设**在 Linux 上就能验证**，不需要 Windows：把从端程序换掉，其余一切
 * 不变。bash + readline 已经是"轻量 shell"的下限了（没有语法高亮、没有整行重绘），
 * 如果连它都能让往返涨一个数量级，PowerShell + PSReadLine 只会更重。
 *
 * ── 两条会话的从端分别是什么 ────────────────────────────────────────────
 *
 * - **裸 PTY**：从端跑 `cat`。它不碰 termios，PTY 保持在规范模式（canonical +
 *   echo），我们写进去的那个字符**由内核行规程直接回显**，`cat` 自己在收到换行
 *   之前一个字节都不会读走、更不会输出。所以这条量到的是"PTY + 内核 + 我们的
 *   读线程"的地板价，不含任何用户态 shell 的按键处理。
 *   （为什么不干脆不起从端程序：`SessionManager::open` 一定要 spawn 一个子进程，
 *   portable-pty 的从端必须有人持有；`cat` 是最接近"什么都不做"的那个。）
 * - **真 shell**：从端跑 `$SHELL`（钉死 bash）。交互式 bash 的 readline 会把终端
 *   设成 raw 模式、**回显由 readline 自己做**，于是这条往返里包含了 bash 每次
 *   按键的全部工作。
 *
 * ── 为什么是交替按键而不是先跑完一条再跑另一条 ──────────────────────────
 *
 * 两条会话同时开着、一轮 A 一轮 B 交替敲，机器状态（CPU 频率、调度、缓存、别的
 * 进程）对两条的影响是同一份。这是配对实验：除了并列两条分布，还能给出**逐轮
 * 差值**的分布。先后跑两遍就没有这个性质，两组数字之间隔着几秒钟的机器状态漂移，
 * 相减出来的东西跟 latency.ts 里那个被废掉的"中位数拆账"是同一类错误。
 */
import { accessSync, constants } from 'node:fs'
import { connectCore } from './core-session'
import {
  GAP_MS, KEY, ROUNDTRIP_TIMEOUT_MS, SAMPLES, SETTLE_MS, WARMUP,
  gap, measurementShell, ms, printSegment, stats, type Segment,
} from './latency-protocol'

/**
 * 裸 PTY 那一侧的从端程序。选 `cat` 的理由见文件头。
 *
 * Windows 上没有"内核行规程"这回事（ConPTY 的回显来自 conhost + 从端程序），
 * 这条对照本身就只在类 Unix 上成立，所以这里不做跨平台分支，直接在 Windows 上
 * 明确拒绝跑，而不是给出一个看着像那么回事、实际口径全错的数字。
 */
const BARE_PTY_PROGRAM = '/bin/cat'

interface Arm {
  name: string
  shell: string
  what: string
  all: number[]
  timeouts: number
  lateChunks: number
  /** 回显来源自检收到的字节（见 probeEchoSource）。 */
  probe: number[]
}

/** 回显来源自检用的按键：Ctrl-L。 */
const CTRL_L = 0x0c
/** 自检里等回应的时长。一次往返是亚毫秒，300ms 是三个数量级的余量。 */
const PROBE_WAIT_MS = 300

/**
 * 回显到底是谁做的？——**这一步不能省**。
 *
 * 整个对照的前提是"真 shell 那一侧的回显由 readline 在 raw 模式下自己做"。万一
 * 那条会话里的 shell 因为某种原因没进交互模式（没起 readline、没设 raw 模式），
 * 回显就会跟裸 PTY 一侧一样来自内核行规程——**两侧量的其实是同一件事**，差值
 * 自然接近零，而输出看上去完全正常，只会被读成"shell 几乎不花钱"这个错误结论。
 * 这正是本项目最典型的静默失效。
 *
 * 判据取一个两种模式下反应截然不同的按键：Ctrl-L。
 * - 规范模式（内核行规程）：ECHOCTL 把它可见化回显成 `^L` 两个字符，没有别的。
 * - bash/readline（raw 模式）：Ctrl-L 是"清屏并重画提示符"，回来的必然是一串
 *   ESC 控制序列。
 * 于是"回来的字节里有没有 ESC"就是一个不会看走眼的指纹。
 */
function describeProbe(bytes: number[]): string {
  const hex = bytes.slice(0, 24).map((b) => b.toString(16).padStart(2, '0')).join(' ')
  const text = bytes.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
  return `${bytes.length}B  ${hex}${bytes.length > 24 ? ' …' : ''}  "${text.slice(0, 24)}"`
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    console.error(
      '这条对照只在类 Unix 上成立：它依赖"从端程序不碰 termios 时回显来自内核行规程"，\n' +
      '而 Windows 的 ConPTY 没有行规程，回显一律来自 conhost + 从端程序，做不出"裸 PTY"那一侧。',
    )
    process.exit(2)
  }
  try {
    accessSync(BARE_PTY_PROGRAM, constants.X_OK)
  } catch {
    throw new Error(`找不到可执行的 ${BARE_PTY_PROGRAM}，裸 PTY 那一侧起不来`)
  }

  const shell = measurementShell()
  console.log('HackerTerm shell 成本对照：同一条管道（Node → napi → Rust → PTY），只换从端程序')
  console.log(`平台 ${process.platform}`)
  console.log(`每侧：晾 ${SETTLE_MS}ms → 丢弃 ${WARMUP} 个预热样本 → 正式 ${SAMPLES} 次，两侧交替，轮间隔 ${GAP_MS}ms\n`)

  const core = await connectCore()
  const arms: Arm[] = [
    {
      name: '裸 PTY（内核行规程回显）',
      shell: BARE_PTY_PROGRAM,
      what: `从端 = ${BARE_PTY_PROGRAM}，不碰 termios，回显由内核行规程给出，不含任何 shell 的按键处理`,
      all: [], timeouts: 0, lateChunks: 0, probe: [],
    },
    {
      name: `真 shell（${shell}）`,
      shell,
      what: `从端 = ${shell}，交互式 readline 把终端设成 raw 模式、自己做回显，含它每次按键的全部工作`,
      all: [], timeouts: 0, lateChunks: 0, probe: [],
    },
  ]

  // 每条会话一套配对状态。两条会话的出向数据按 sessionId 分流（见 core-session.ts），
  // 不会串台——这正是把 connectCore/openSession 拆开的目的。
  const rounds = await Promise.all(arms.map(async (arm) => {
    const session = await core.openSession({ shell: arm.shell })
    let armed = false
    let probing = false
    let onEcho: (() => void) | null = null
    session.onData((bytes) => {
      if (probing) arm.probe.push(...bytes)
      if (!armed) { arm.lateChunks += 1; return }
      armed = false
      onEcho?.()
    })
    const byte = new TextEncoder().encode(KEY)
    return {
      arm,
      session,
      /** 回显来源自检：写一个 Ctrl-L，把回来的字节攒下来（见 describeProbe）。 */
      async probeEchoSource(): Promise<void> {
        probing = true
        session.write(new Uint8Array([CTRL_L]))
        await new Promise((r) => setTimeout(r, PROBE_WAIT_MS))
        probing = false
      },
      async roundtrip(): Promise<void> {
        const started = performance.now()
        const done = new Promise<boolean>((res) => {
          armed = true
          onEcho = () => res(true)
          // 等不到就记成丢失，绝不顺延到下一轮——顺延会让下一轮量出一个假的短往返。
          setTimeout(() => { if (armed) { armed = false; res(false) } }, ROUNDTRIP_TIMEOUT_MS)
        })
        session.write(byte)
        if (await done) arm.all.push(performance.now() - started)
        else arm.timeouts += 1
        onEcho = null
      },
    }
  }))

  // 两条会话都刚开，bash 的提示符还在路上，一起晾。
  await new Promise((r) => setTimeout(r, SETTLE_MS))

  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    for (const round of rounds) {
      await round.roundtrip()
      await gap()
    }
  }
  // 先自检回显来源，再关会话——顺序不能反，关了就问不出来了。
  for (const round of rounds) await round.probeEchoSource()
  for (const round of rounds) await round.session.close()

  const segments: Segment[] = arms.map((arm) => {
    const cut = Math.min(WARMUP, arm.all.length)
    return {
      label: arm.name,
      what: arm.what,
      warmup: arm.all.slice(0, cut),
      measured: arm.all.slice(cut),
      notes: [
        `一次按键回来多块数据的次数：${arm.lateChunks}`,
        `往返超时丢失：${arm.timeouts}`,
      ],
    }
  })

  console.log('\n── 两侧分布 ─────────────────────────────────────────────────')
  for (const seg of segments) printSegment(seg)

  // 逐轮差值：第 i 轮的 bash 减第 i 轮的裸 PTY。两轮相隔一个 GAP_MS，机器状态几乎
  // 相同，所以这个减法是成立的（对比：三段各自独立测量之后相减是不成立的，
  // 见 latency.ts 结尾那段说明）。
  const [bare, real] = segments
  const paired: number[] = []
  for (let i = 0; i < Math.min(bare.measured.length, real.measured.length); i++) {
    paired.push(real.measured[i] - bare.measured[i])
  }
  console.log('\n── 逐轮差值（真 shell − 裸 PTY，同一轮次、相隔一个间隔）───────')
  printSegment({
    label: 'shell 自己的按键成本',
    what: '同一条管道、同一时段，唯一的差别是从端程序',
    warmup: [],
    measured: paired,
    notes: [],
  })

  console.log('\n── 回显来源自检（写一个 Ctrl-L，看回来的是什么）─────────────')
  const ESC = 0x1b
  for (const arm of arms) {
    console.log(`  ${arm.name.padEnd(24)} ${describeProbe(arm.probe)}`)
  }
  const bareHasEsc = arms[0].probe.includes(ESC)
  const shellHasEsc = arms[1].probe.includes(ESC)
  if (shellHasEsc && !bareHasEsc) {
    console.log('  ✓ 真 shell 那侧回来的是 ESC 控制序列（readline 在 raw 模式下自己重画），')
    console.log('    裸 PTY 那侧只有 ^L 的可见化回显（规范模式，内核行规程）。两侧口径确实不同。')
  } else {
    console.log('  ⚠ 口径自检没通过：两侧的回显来源看起来是同一个，下面的差值不能解读成 "shell 的成本"。')
    console.log(`    裸 PTY 含 ESC=${bareHasEsc}，真 shell 含 ESC=${shellHasEsc}`)
  }

  const b = stats(bare.measured), r = stats(real.measured)
  console.log('\n── 结论 ─────────────────────────────────────────────────────')
  console.log(`  裸 PTY 中位数 ${ms(b.median).trim()}ms / p95 ${ms(b.p95).trim()}ms`)
  console.log(`  真 shell 中位数 ${ms(r.median).trim()}ms / p95 ${ms(r.p95).trim()}ms`)
  console.log(`  倍数：中位数 ×${(r.median / b.median).toFixed(1)}，p95 ×${(r.p95 / b.p95).toFixed(1)}`)
  console.log('  管道两侧完全相同，差额只可能来自从端程序自己处理这次按键的工作。')
}

main().then(
  () => {
    // 显式退出：理由同 latency.ts（Rust 侧 Core 是 OnceLock 全局，没有拆卸接口）。
    process.exit(0)
  },
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
