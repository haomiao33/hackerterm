/**
 * 端到端测试的启动器：在无头 Linux 上自动套一层 xvfb（判据与实现见
 * scripts/headless.mjs）。
 *
 * 起因：`pnpm test:e2e` 直接跑会以 `Missing X server or $DISPLAY` 失败——
 * 端到端测试拉的是真的 Electron，要开真窗口，而容器 / CI / 无桌面的开发机上
 * 根本没有 X server。此前只有 CI 的命令行里手写了 `xvfb-run -a`，本地跑的人
 * 只能先踩一次再去翻文档，白白浪费一轮。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { runHeadless } from './headless.mjs'

const require = createRequire(import.meta.url)

// 解析 vitest 自己的 CLI 入口，而不是去拼 node_modules/.bin/vitest：后者在
// Windows 上是 .cmd、非借 shell 不能执行，而 pnpm 的软链接布局下它也不一定
// 就在仓库根的 node_modules 里。走 require.resolve 两边都对。
const vitestPkgPath = require.resolve('vitest/package.json')
const vitestCli = path.join(path.dirname(vitestPkgPath), require(vitestPkgPath).bin.vitest)

// 额外参数原样透传（例如 `pnpm test:e2e -t 回显`），不然这层包装会挡住 vitest
// 自己的过滤/报告选项，变成一个只能全跑的死命令。
const vitestArgv = [vitestCli, 'run', '--config', 'e2e/vitest.config.ts', ...process.argv.slice(2)]

runHeadless(process.execPath, vitestArgv)
