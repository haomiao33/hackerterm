/**
 * 端到端测试的启动器：在无头 Linux 上自动套一层 xvfb-run。
 *
 * 起因：`pnpm test:e2e` 直接跑会以 `Missing X server or $DISPLAY` 失败——
 * 端到端测试拉的是真的 Electron，要开真窗口，而容器 / CI / 无桌面的开发机上
 * 根本没有 X server。此前只有 CI 的命令行里手写了 `xvfb-run -a`，本地跑的人
 * 只能先踩一次再去翻文档，白白浪费一轮。
 *
 * 包一层的判据是「Linux 且当前没有可用的 DISPLAY」，不是「平台是 Linux」：
 * - Windows / macOS 有原生窗口系统，既没有 xvfb 也不需要，照常直接跑；
 * - Linux 桌面上 DISPLAY 已经有了，用真桌面跑（还能看见窗口，便于排障）；
 * - 外面已经套了 `xvfb-run -a pnpm test:e2e` 的老用法照样能用：外层已经把
 *   DISPLAY 设好了，这里就不会再嵌套起第二个 Xvfb。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

// 解析 vitest 自己的 CLI 入口，而不是去拼 node_modules/.bin/vitest：后者在
// Windows 上是 .cmd、非借 shell 不能执行，而 pnpm 的软链接布局下它也不一定
// 就在仓库根的 node_modules 里。走 require.resolve 两边都对。
const vitestPkgPath = require.resolve('vitest/package.json')
const vitestCli = path.join(path.dirname(vitestPkgPath), require(vitestPkgPath).bin.vitest)

// 额外参数原样透传（例如 `pnpm test:e2e -t 回显`），不然这层包装会挡住 vitest
// 自己的过滤/报告选项，变成一个只能全跑的死命令。
const vitestArgv = [vitestCli, 'run', '--config', 'e2e/vitest.config.ts', ...process.argv.slice(2)]

/** 只查 PATH 里有没有 xvfb-run，不真的去启 X server。 */
function hasXvfbRun() {
  return spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0
}

const headlessLinux = process.platform === 'linux' && !process.env.DISPLAY
const useXvfb = headlessLinux && hasXvfbRun()

if (headlessLinux && !useXvfb) {
  // 提前把话说清楚，好过让人对着 Chromium 那句 "Missing X server or $DISPLAY"
  // 自己猜要装什么。
  console.warn('[e2e] 无头 Linux 但没找到 xvfb-run，Electron 起不了窗口。请安装 xvfb（Debian/Ubuntu: apt-get install xvfb）。')
}

// -a：让 xvfb-run 自动挑一个没被占用的 display number，多条测试并行时不会撞车。
const [command, argv] = useXvfb
  ? ['xvfb-run', ['-a', process.execPath, ...vitestArgv]]
  : [process.execPath, vitestArgv]

const child = spawn(command, argv, { stdio: 'inherit' })
// 退出码必须原样透出去，否则测试红了这条命令还是 0，CI 门禁形同虚设。
// 被信号打死时没有退出码，统一按失败算。
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
