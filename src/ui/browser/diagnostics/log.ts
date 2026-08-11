/**
 * 页面级诊断日志：所有埋点都写这里的 #log 区，而不只是 console——真机上
 * 用户没有 DevTools，唯一能带回来的证据就是这块文字的截图或选中复制
 * （可复制见 index.html 里 #log 的 user-select: text）。
 *
 * 时间戳直接用 performance.now()：它本身就是"相对页面开始加载的毫秒数"，
 * 不需要另外记一个启动时刻，也不会因为模块加载顺序产生偏差。
 */

const LOG_ELEMENT_ID = 'log'

/** 写一行诊断日志，自动带上距页面开始加载的毫秒数前缀，例如 "+142ms ...". */
export function log(message: string): void {
  const elapsedMs = Math.round(performance.now())
  const line = `+${elapsedMs}ms ${message}`
  const el = document.getElementById(LOG_ELEMENT_ID)
  if (el) {
    el.textContent += `\n${line}`
  } else {
    // 日志容器本身找不到也不能静默吞掉这条日志，至少落到 console。
    console.error(`#${LOG_ELEMENT_ID} not found, diagnostic line dropped:`, line)
  }
  console.log(line)
}
