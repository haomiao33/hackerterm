/**
 * 重新生成视觉回归的基线截图（e2e/__screenshots__/*.png）。
 *
 * 为什么要单独一个脚本，而不是在 package.json 里写 `HT_UPDATE_SCREENSHOTS=1 ...`：
 * 那个写法是 POSIX shell 语法，Windows 的 cmd/pwsh 上直接报错，而本项目的正式
 * 目标平台就是 Windows。引一个 cross-env 只为设一个环境变量也不划算——在 Node
 * 里设 `process.env` 再 spawn，行为在两个平台上完全一致，且零新依赖。
 *
 * 用法：pnpm test:e2e:update-screenshots
 *
 * 生成完**必须人眼看一遍图**再入库。基线是这套测试的判据本身，一张错的基线会
 * 把故障永久固化成"预期行为"，比没有测试更糟。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { runHeadless } from './headless.mjs'

const require = createRequire(import.meta.url)

// 同 run-e2e.mjs：解析 vitest 自己的 CLI 入口，跨平台都对。
const vitestPkgPath = require.resolve('vitest/package.json')
const vitestCli = path.join(path.dirname(vitestPkgPath), require(vitestPkgPath).bin.vitest)

process.env.HT_UPDATE_SCREENSHOTS = '1'

// 只跑 visual 这一个文件：其余端到端测试跟基线无关，没必要陪跑几十秒。
runHeadless(process.execPath, [vitestCli, 'run', '--config', 'e2e/vitest.config.ts', 'visual'])
