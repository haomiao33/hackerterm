/**
 * 测量脚本（e2e/latency.ts、e2e/shell-cost.ts）的启动器：无头 Linux 上自动套
 * xvfb，参数原样透传。
 *
 * 为什么不直接写 `tsx e2e/latency.ts`：那条命令在无头机器上必然以
 * `Missing X server or $DISPLAY` 失败，得由人记得手写 `xvfb-run -a` 前缀。
 * 「测试要本地 headless 自动跑、尽量不要人工」是长期约定，这条同样适用于测量。
 *
 * 用法：`node scripts/run-measure.mjs <入口.ts> [透传参数…]`
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { runHeadless } from './headless.mjs'

const require = createRequire(import.meta.url)

// 解析 tsx 自己的 CLI 入口，而不是去拼 node_modules/.bin/tsx：后者在 Windows 上
// 是 .cmd、非借 shell 不能执行，而 pnpm 的软链接布局下它也不一定就在仓库根的
// node_modules 里。走 require.resolve 两边都对。
const tsxPkgPath = require.resolve('tsx/package.json')
const tsxCli = path.join(path.dirname(tsxPkgPath), require(tsxPkgPath).bin)

const [, , entry, ...rest] = process.argv
if (!entry) {
  console.error('用法：node scripts/run-measure.mjs <入口.ts> [透传参数…]')
  process.exit(2)
}

runHeadless(process.execPath, [tsxCli, entry, ...rest])
