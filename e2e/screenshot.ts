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
 * 基线文件名里的平台后缀（`terminal-light.linux.png` / `terminal-light.win32.png`）。
 *
 * 为什么**每个平台一套基线**，而不是共用一张图：
 * 终端里 99% 的像素都是字形，而字形是操作系统的字体栈画出来的——Linux 上是
 * fontconfig + FreeType 渲染 DejaVu Sans Mono，Windows 上是 DirectWrite 渲染
 * Consolas。字体不同、光栅化器不同、抗锯齿算法不同，同一段文字在两个平台上
 * **不可能**得到相同的像素。这不是 bug，是两个平台本来就长得不一样。
 *
 * 那为什么不改成"共用一张基线 + 把比较阈值放宽到能容忍字体差异"：
 * 因为跨平台的字形差异是**整片文字区域**级别的（远大于任何真实回归），要放宽到
 * 能容忍它，等于把阈值调到"整块文字都变了也不算差异"。到那个程度，这个测试要抓
 * 的两个历史故障（xterm.css 没引入导致布局塌缩、亮色主题光标与白底零像素差异）
 * 一个都抓不到了——它会变成一个永远绿、什么都测不出来的摆设，正是本项目最痛恨
 * 的那种"看着在测、其实测不出东西"。所以阈值一个字不动（见 PIXEL_THRESHOLD），
 * 改的是"跟谁比"：每个平台只跟**自己平台**的基线比，比的仍然是严格逐像素相等。
 *
 * 用 `process.platform` 而不是自己编一套名字：它就是 Node 对"哪个操作系统"的
 * 唯一事实来源（linux / win32 / darwin），多一层映射只会多一处能写错的地方。
 */
export const PLATFORM_SUFFIX = process.platform

/** 某个平台的基线文件名（不含目录）。生成与比对两侧必须走同一个函数，免得写歪。 */
export function baselineFileName(name: string): string {
  return `${name}.${PLATFORM_SUFFIX}.png`
}

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
  const baselinePath = path.join(SCREENSHOT_DIR, baselineFileName(name))

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
      `缺少 ${PLATFORM_SUFFIX} 平台的基线截图 ${baselinePath}。\n` +
      '基线是每平台一套的（字体栈不同，像素必然不同，见 PLATFORM_SUFFIX 的注释），\n' +
      `所以必须在 ${PLATFORM_SUFFIX} 上生成：pnpm test:e2e:update-screenshots\n` +
      '生成后必须人工看一眼图对不对再入库——基线是错的，测试再绿也没有意义。',
    )
  }

  const actual = PNG.sync.read(actualPng)
  const baseline = PNG.sync.read(readFileSync(baselinePath))
  const totalPixels = baseline.width * baseline.height

  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    writeArtifact(`${name}.${PLATFORM_SUFFIX}.actual.png`, actualPng)
    return {
      diffPixels: totalPixels,
      totalPixels,
      summary:
        `尺寸不一致：基线 ${baseline.width}×${baseline.height}，实际 ` +
        `${actual.width}×${actual.height}。布局塌缩（比如 xterm.css 没被引入）就是这个症状。` +
        `实际图已写到 ${path.join(ARTIFACT_DIR, `${name}.${PLATFORM_SUFFIX}.actual.png`)}`,
    }
  }

  const diff = new PNG({ width: baseline.width, height: baseline.height })
  const diffPixels = pixelmatch(
    baseline.data, actual.data, diff.data, baseline.width, baseline.height,
    { threshold: PIXEL_THRESHOLD },
  )

  if (diffPixels > 0) {
    writeArtifact(`${name}.${PLATFORM_SUFFIX}.actual.png`, actualPng)
    writeArtifact(`${name}.${PLATFORM_SUFFIX}.diff.png`, PNG.sync.write(diff))
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
