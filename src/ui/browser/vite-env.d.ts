// 让 `import '@xterm/xterm/css/xterm.css'`（见 terminal/mount.ts）这类 CSS
// side-effect import 在 tsc 下有类型声明可查——不这么做的话 `pnpm exec tsc
// --noEmit` 会报 "Cannot find module '...css'"。vite/client 是 Vite 自带的
// 环境类型包，标准做法，不是本项目特例。
/// <reference types="vite/client" />
