import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 端到端测试单独一份 vitest 配置，不并进 `pnpm test`（那条是
 * `vitest run src`，只跑单元测试，秒级返回，谁都跑得起）。端到端要拉真的
 * Electron、真的 PTY，慢一个数量级，混在一起会拖垮日常开发的反馈速度。
 */
export default defineConfig({
  // 配置文件在 e2e/ 下，vitest 默认拿配置文件所在目录当 root；显式指到仓库根，
  // 好让 e2e 里 import '../src/...' 和 import 'ht-node' 都按仓库根解析。
  root: resolve(import.meta.dirname, '..'),
  test: {
    include: ['e2e/**/*.e2e.ts'],
    // 启动 Electron（冷启动 + napi 原生模块加载）本身就要一两秒，CI 上更慢。
    testTimeout: 120_000,
    hookTimeout: 120_000,
    /*
     * forks（子进程）而不是默认的 threads（worker 线程）：
     * - ht-node 是 napi 原生模块，Rust 侧用 OnceLock 保证 start()/startData()
     *   一个进程只调一次，多个测试文件共享一个 worker 会直接撞上"called twice"。
     * - Electron/PTY 这类带原生资源的东西放在真正独立的进程里更容易清干净。
     * 配合 fileParallelism: false，两个文件依次跑，互不抢 CPU（时延测量也需要
     * 一个不被别的测试打扰的环境）。
     */
    pool: 'forks',
    fileParallelism: false,
  },
})
