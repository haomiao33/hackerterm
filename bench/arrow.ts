// Task 10 Step 5: 实测 Arrow IPC Stream 分帧在“大结果集”场景下的编码/解码耗时与体积。
//
// 流程：
//   1. 跑 Rust 的 `bench_encode` 例子，构造 10 万行 x 10 列的 RecordBatch，
//      用 `ht_core::arrow_frame::encode_batch` 编码，把耗时和字节写到一个临时文件。
//   2. 在纯 Node（非 Electron）里用 `apache-arrow` 的 `tableFromIPC` 解码那份字节，计时。
//   3. 打印四段数据：Rust 编码耗时、IPC 传输耗时（容器内无法测量，见下）、
//      JS 解码耗时、字节体积，并给出是否满足“百毫秒量级”判据的结论。
//
// 关于 IPC 传输耗时：这台机器是 Docker 容器，跑不了 Electron
// （容器内以 root 运行 Electron 需要 --no-sandbox，等于关掉 OS 级沙箱，
// 与项目“渲染进程必须保持 OS 沙箱”的硬约束冲突）。所以 MessagePort 把这份
// 字节从 Rust 侧搬到渲染进程表格的那一段真实传输耗时，这里**测不了**，
// 只能编码 + 解码耗时之和作为下界，传输耗时留给 Windows 真机验证。

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tableFromIPC } from 'apache-arrow'

const REPO_ROOT = join(import.meta.dirname, '..')
const MS_PER_NS = 1_000_000

/** 判据：总计（编码 + 解码）应在百毫秒量级；超过这个上限说明分帧方式有问题。 */
const TOTAL_MS_TROUBLE_THRESHOLD = 1_000

interface EncodeReport {
  rows: number
  cols: number
  bytes: number
  encode_ms: number
}

function runRustEncoder(framePath: string): EncodeReport {
  const stdout = execFileSync(
    'cargo',
    ['run', '--release', '-p', 'ht-core', '--example', 'bench_encode', '--', framePath],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
  const jsonLine = stdout.trim().split('\n').at(-1)
  if (!jsonLine) {
    throw new Error('bench_encode produced no output')
  }
  return JSON.parse(jsonLine) as EncodeReport
}

function decodeWithTiming(framePath: string): { decodeMs: number; rows: number; cols: number } {
  const bytes = readFileSync(framePath)
  const start = process.hrtime.bigint()
  const table = tableFromIPC(bytes)
  const end = process.hrtime.bigint()
  return {
    decodeMs: Number(end - start) / MS_PER_NS,
    rows: table.numRows,
    cols: table.numCols,
  }
}

function main(): void {
  const workDir = mkdtempSync(join(tmpdir(), 'ht-arrow-bench-'))
  const framePath = join(workDir, 'frame.arrow')

  try {
    const encodeReport = runRustEncoder(framePath)
    const decodeReport = decodeWithTiming(framePath)

    if (decodeReport.rows !== encodeReport.rows || decodeReport.cols !== encodeReport.cols) {
      throw new Error(
        `decoded shape (${decodeReport.rows}x${decodeReport.cols}) does not match ` +
          `encoded shape (${encodeReport.rows}x${encodeReport.cols})`,
      )
    }

    const measuredTotalMs = encodeReport.encode_ms + decodeReport.decodeMs
    const verdict =
      measuredTotalMs <= TOTAL_MS_TROUBLE_THRESHOLD
        ? 'OK：编码+解码在百毫秒量级以内'
        : `WARN：编码+解码已超过 ${TOTAL_MS_TROUBLE_THRESHOLD}ms，分帧方式可能有问题`

    console.log('--- Arrow IPC Stream 分帧实测（10 万行 x 10 列）---')
    console.log(`行数 x 列数: ${encodeReport.rows} x ${encodeReport.cols}`)
    console.log(`字节体积: ${encodeReport.bytes} bytes (${(encodeReport.bytes / (1024 * 1024)).toFixed(2)} MiB)`)
    console.log(`Rust 编码耗时: ${encodeReport.encode_ms.toFixed(3)} ms`)
    console.log('IPC 传输耗时: 未测量 —— 容器内无法启动沙箱化 Electron，此段留给 Windows 真机验证')
    console.log(`JS (apache-arrow tableFromIPC) 解码耗时: ${decodeReport.decodeMs.toFixed(3)} ms`)
    console.log(`总计（仅编码+解码，不含传输）: ${measuredTotalMs.toFixed(3)} ms`)
    console.log(verdict)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main()
