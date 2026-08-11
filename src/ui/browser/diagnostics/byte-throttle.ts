import { log } from './log'
import { hexPreview } from './hex'

/**
 * 一次按键落地的关键证据都在最初这几次 onData 里；超过这个次数后大概率
 * 已经证明了"键盘输入通路是通的"，继续逐条打印只会刷屏（挤掉别的埋点，
 * 见 index.html 固定高度日志区的约束），改成每隔 ONDATA_SUMMARY_INTERVAL
 * 次汇总一次即可。
 */
const ONDATA_FULL_LOG_COUNT = 20
const ONDATA_SUMMARY_INTERVAL = 50

/**
 * 每次 onData 都记：字节数 + 前若干字节的十六进制。这是回答"英文到底有
 * 没有发出去"最直接的证据。返回的函数每调一次代表一次 xterm onData 事件。
 */
export function createOnDataLogger(): (bytes: Uint8Array) => void {
  let callCount = 0
  let bytesSinceSummary = 0
  return (bytes: Uint8Array) => {
    callCount += 1
    bytesSinceSummary += bytes.length
    if (callCount <= ONDATA_FULL_LOG_COUNT) {
      log(`onData #${callCount}: ${bytes.length}B [${hexPreview(bytes)}]`)
    } else if (callCount % ONDATA_SUMMARY_INTERVAL === 0) {
      log(`onData #${callCount} summary: +${bytesSinceSummary}B since last summary`)
      bytesSinceSummary = 0
    }
  }
}

/** 复用与 onData 相同的节流粒度，收到的数据只关心"流没断"，不需要看内容。 */
const INCOMING_DATA_SUMMARY_INTERVAL = 50

/**
 * PTY -> 渲染方向的数据量通常很大（比如 cat 一个大文件），这里只做累计
 * 字节数的节流汇总，不逐条打印、不打 hex。
 */
export function createIncomingDataLogger(): (byteLength: number) => void {
  let callCount = 0
  let totalBytes = 0
  return (byteLength: number) => {
    callCount += 1
    totalBytes += byteLength
    if (callCount === 1 || callCount % INCOMING_DATA_SUMMARY_INTERVAL === 0) {
      log(`data received: cumulative ${totalBytes}B over ${callCount} messages`)
    }
  }
}
