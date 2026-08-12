import { log } from './log'

/**
 * 渲染进程的兜底错误捕获。
 *
 * 此前一个都没有：boot.ts 里任何一处同步抛异常或 Promise 被拒绝而没人接，
 * 页面就停在半截（终端不挂载、日志停在最后一条），不会多出任何一条线索。
 * 从外面看跟"核心没回消息"完全一样——这正是本项目最怕的那类静默失效，而且
 * 会把排障方向直接带偏到 IPC 链路上去。
 *
 * 只上报、不做恢复：这里没有足够的上下文判断怎么恢复，把"哪一行炸了"写进
 * 诊断日志就是它的全部价值。
 */
export function installErrorHandlers(): void {
  window.addEventListener('error', (e) => {
    // 跨源脚本上 e.error 会是 null（浏览器的同源保护），这时只有
    // message/filename/lineno 拿得到，所以两路都要打。
    const where = e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : ''
    log(`window error: ${e.error?.stack ?? e.message}${where}`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason: unknown = e.reason
    const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
    log(`unhandledrejection: ${detail}`)
  })
}
