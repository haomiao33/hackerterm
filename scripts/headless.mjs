/**
 * 无头 Linux 上自动套一层 xvfb 的通用启动器。
 *
 * 起因：任何要拉真 Electron 的命令（端到端测试、时延测量）直接跑都会以
 * `Missing X server or $DISPLAY` 失败——容器 / CI / 无桌面开发机上根本没有
 * X server。此前只有端到端测试那条命令自己包了一层，时延测量没有，于是
 * `pnpm measure:latency` 在本机必须由人手写 `xvfb-run -a` 前缀才跑得起来。
 * 「测试要本地 headless 自动跑、尽量不要人工」是长期约定，包装就得是通用的。
 *
 * 包一层的判据是「Linux 且当前没有可用的 DISPLAY」，不是「平台是 Linux」：
 * - Windows / macOS 有原生窗口系统，既没有 xvfb 也不需要，照常直接跑；
 * - Linux 桌面上 DISPLAY 已经有了，用真桌面跑（还能看见窗口，便于排障）；
 * - 外面已经套了 `xvfb-run -a ...` 的老用法照样能用：外层已经把 DISPLAY 设好了，
 *   这里就不会再嵌套起第二个 Xvfb。
 *
 * 这个文件只导出函数，不自己当 CLI 跑：调用方（run-e2e.mjs / run-measure.mjs）
 * 各自负责把要跑的东西解析成绝对路径，那部分逻辑跨平台差异更大，不适合塞进
 * 通用包装里。
 */
import { spawn, spawnSync } from 'node:child_process'

/** 只查 PATH 里有没有 xvfb-run，不真的去启 X server。 */
export function hasXvfbRun() {
  return spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0
}

/**
 * 按需套 xvfb 跑一条命令，退出码原样透出。
 *
 * 退出码必须原样透出去，否则测试红了这条命令还是 0，CI 门禁形同虚设。
 * 被信号打死时没有退出码，统一按失败算。
 */
export function runHeadless(command, args) {
  const headlessLinux = process.platform === 'linux' && !process.env.DISPLAY
  const useXvfb = headlessLinux && hasXvfbRun()

  if (headlessLinux && !useXvfb) {
    // 提前把话说清楚，好过让人对着 Chromium 那句 "Missing X server or $DISPLAY"
    // 自己猜要装什么。
    console.warn('[headless] 无头 Linux 但没找到 xvfb-run，Electron 起不了窗口。请安装 xvfb（Debian/Ubuntu: apt-get install xvfb）。')
  }

  // -a：让 xvfb-run 自动挑一个没被占用的 display number，多条命令并行时不会撞车。
  const [cmd, argv] = useXvfb ? ['xvfb-run', ['-a', command, ...args]] : [command, args]
  const child = spawn(cmd, argv, { stdio: 'inherit' })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}
