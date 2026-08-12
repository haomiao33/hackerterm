/**
 * 页面级诊断日志：写 console，不再往 DOM 里塞节点。
 *
 * 原先所有埋点都写页面上一块固定高度（160px）的 `#log` 区，理由是"真机上用户
 * 没有 DevTools，唯一能带回来的证据就是这块文字的截图"。这个前提不成立了——
 * 用户能开 DevTools 看 console，那块日志区就只是白占屏幕，终端反而被挤小。
 *
 * 为什么用 `console.log` 这种最朴素的 API，而不是 `console.table` / `group` 之类：
 * 主进程加上 `--enable-logging` 之后，渲染进程的 console 会落到 stdout，这才是
 * 打包之后真正可用的那条排障路径；那些只在 DevTools 界面里才有意义的 API 到了
 * stdout 上会退化甚至丢内容。
 *
 * 时间戳直接用 performance.now()：它本身就是"相对页面开始加载的毫秒数"，
 * 不需要另外记一个启动时刻，也不会因为模块加载顺序产生偏差。前缀格式
 * （`+142ms ...`）保持不变——真机排障对着的就是这个格式。
 */

/** 写一行诊断日志，自动带上距页面开始加载的毫秒数前缀，例如 "+142ms ...". */
export function log(message: string): void {
  const elapsedMs = Math.round(performance.now())
  console.log(`+${elapsedMs}ms ${message}`)
}
