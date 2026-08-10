import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

// electron-vite 只认 main / preload / renderer 三个顶层配置块，没有给
// utility process 单开一个构建目标的一等公民支持。core-host（宿主 Rust 核心
// 的 utility process 脚本）本质上和 main 一样——纯 Node/CJS、没有 index.html——
// 所以把它挂在 main 这块配置的第二个 rollup 入口上来构建，靠
// `output.entryFileNames: '[name].js'` + 把入口 key 写成 'core-host/index'，
// 让产物落在 out/core-host/index.js（和 out/main/index.js 同级）。
// 这样 brief 原文 src/main/index.ts 里
// `utilityProcess.fork(path.join(__dirname, '../core-host/index.js'))`
// 这行写死的相对路径不用改一个字。
//
// renderer 同理：electron-vite 默认只会去找 src/renderer/index.html，
// 但页面按 brief 放在 src/ui/browser 下，所以要显式指定 root 和
// rollupOptions.input，并把 outDir 定到 out/ui/browser，好让
// src/main/index.ts 里 `win.loadFile(path.join(__dirname, '../ui/browser/index.html'))`
// 这个写死的相对路径同样不用改。
//
// preload 用默认约定（src/preload/index.ts -> out/preload/index.js），
// 因此配置里只放一个空对象——空对象仍然是真值，electron-vite 靠它判断
// "要不要构建这个目标"，留空等于"用默认目录、按默认方式构建"。

const rootDir = __dirname

export default defineConfig({
  main: {
    build: {
      outDir: resolve(rootDir, 'out'),
      rollupOptions: {
        input: {
          'main/index': resolve(rootDir, 'src/main/index.ts'),
          'core-host/index': resolve(rootDir, 'src/core-host/index.ts'),
        },
        output: {
          entryFileNames: '[name].js',
        },
      },
    },
  },
  preload: {},
  renderer: {
    root: resolve(rootDir, 'src/ui/browser'),
    build: {
      outDir: resolve(rootDir, 'out/ui/browser'),
      rollupOptions: {
        input: resolve(rootDir, 'src/ui/browser/index.html'),
      },
    },
  },
})
