/**
 * 截图比对的最小实现：解 PNG → 逐像素比 → 差异落盘。
 *
 * 为什么自己写这三十行，而不是用 `@playwright/test` 的 `toHaveScreenshot()`：
 * 那个断言住在 `@playwright/test` 这个**测试运行器**里，不在 `playwright-core`
 * 里。本仓库的端到端跑在 vitest 上（见 e2e/vitest.config.ts 的理由：`pool: forks`
 * 是 napi 侧 OnceLock 的硬要求），为一个断言再引入第二个测试运行器，等于让端到端
 * 测试分裂成两套互不相干的体系。pixelmatch + pngjs 正是 `toHaveScreenshot()`
 * 内部用的同一对库，直接用它们成本更低、行为也更透明。
 *
 * 落盘策略：只要有差异就把 **实际图** 和 **差异图** 一起写进
 * `e2e/__screenshots__/__artifacts__/`（已 gitignore，CI 里当 artifact 上传）。
 * 视觉回归失败时"哪几个像素不一样"是唯一有用的信息，只报一个数字等于没报。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { REPO_ROOT } from './electron-app'

export const SCREENSHOT_DIR = path.join(REPO_ROOT, 'e2e/__screenshots__')
export const ARTIFACT_DIR = path.join(SCREENSHOT_DIR, '__artifacts__')

/**
 * 置为 1 时不比对，直接把当前渲染结果写成新基线。
 * 用法：`HT_UPDATE_SCREENSHOTS=1 pnpm test:e2e visual`（也有 npm script 包好）。
 */
export const UPDATING = process.env.HT_UPDATE_SCREENSHOTS === '1'

export interface DiffResult {
  /** 不一致的像素数。 */
  diffPixels: number
  /** 基线总像素数。 */
  totalPixels: number
  /** 人能读的一句话，直接塞进断言的失败消息里。 */
  summary: string
}

/**
 * 单像素颜色距离阈值，透传给 pixelmatch 的 `threshold`。
 *
 * 来源：pixelmatch 自己的默认值 0.1。保持默认而不是调松：本项目要抓的两个历史
 * 故障（xterm.css 没引入导致布局塌缩、亮色主题光标与白底零像素差异）一个是整片
 * 区域变化、一个是纯色块出现/消失，都远远超过这个量级；把阈值调松只会让"光标
 * 颜色变淡了一点"这类真回归漏网。
 */
const PIXEL_THRESHOLD = 0.1

/**
 * 把一张实际截图和入库基线比对。
 *
 * 尺寸不一致直接判为**整张不一致**而不是抛异常：布局塌缩（xterm.css 丢失）的
 * 典型症状就是元素尺寸变了，那正是这个测试要抓的东西，不该表现成一个看起来像
 * 测试自己写错了的 Error。
 */
export function compareToBaseline(name: string, actualPng: Buffer): DiffResult {
  const baselinePath = path.join(SCREENSHOT_DIR, `${name}.png`)

  if (UPDATING) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    writeFileSync(baselinePath, actualPng)
    const img = PNG.sync.read(actualPng)
    return {
      diffPixels: 0,
      totalPixels: img.width * img.height,
      summary: `已写入基线 ${baselinePath}（${img.width}×${img.height}）`,
    }
  }

  if (!existsSync(baselinePath)) {
    throw new Error(
      `缺少基线截图 ${baselinePath}。\n` +
      '生成办法：pnpm test:e2e:update-screenshots\n' +
      '生成后必须人工看一眼图对不对再入库——基线是错的，测试再绿也没有意义。',
    )
  }

  const actual = PNG.sync.read(actualPng)
  const baseline = PNG.sync.read(readFileSync(baselinePath))
  const totalPixels = baseline.width * baseline.height

  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    writeArtifact(`${name}.actual.png`, actualPng)
    return {
      diffPixels: totalPixels,
      totalPixels,
      summary:
        `尺寸不一致：基线 ${baseline.width}×${baseline.height}，实际 ` +
        `${actual.width}×${actual.height}。布局塌缩（比如 xterm.css 没被引入）就是这个症状。` +
        `实际图已写到 ${path.join(ARTIFACT_DIR, `${name}.actual.png`)}`,
    }
  }

  const diff = new PNG({ width: baseline.width, height: baseline.height })
  const diffPixels = pixelmatch(
    baseline.data, actual.data, diff.data, baseline.width, baseline.height,
    { threshold: PIXEL_THRESHOLD },
  )

  if (diffPixels > 0) {
    writeArtifact(`${name}.actual.png`, actualPng)
    writeArtifact(`${name}.diff.png`, PNG.sync.write(diff))
  }

  const percent = ((diffPixels / totalPixels) * 100).toFixed(4)
  return {
    diffPixels,
    totalPixels,
    summary:
      `${diffPixels}/${totalPixels} 像素不一致（${percent}%），基线 ${baselinePath}` +
      (diffPixels > 0 ? `，实际图与差异图见 ${ARTIFACT_DIR}` : ''),
  }
}

function writeArtifact(fileName: string, png: Buffer): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  writeFileSync(path.join(ARTIFACT_DIR, fileName), png)
}
