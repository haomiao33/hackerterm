/**
 * onData（键盘输入发出去的字节）以及收到的终端数据，在诊断日志里都需要
 * 回答"这几个字节到底是什么"——这是判断"英文到底有没有发出去"最直接的
 * 证据，比任何推理都可靠。
 */

// 十六进制格式本身（进制、每字节固定几位）不是业务可调参数，但仍按项目
// 约定具名，避免裸数值字面量。
const HEX_RADIX = 16
const HEX_DIGITS_PER_BYTE = 2

/**
 * 预览字节数上限。诊断真正要回答的问题是"键按下去了没有、发出去的是
 * 什么"——一次按键通常只有 1~4 字节（ASCII 或 UTF-8 多字节序列），16
 * 字节留了余量给转义序列（比如方向键会发 ESC [ A），同时避免大块粘贴
 * 时把日志刷屏（见 index.html 里日志区必须固定高度的同一约束）。
 */
const HEX_PREVIEW_BYTE_COUNT = 16

/** 把字节数组的前若干字节格式化成空格分隔的十六进制串，超出部分用省略号提示。 */
export function hexPreview(bytes: Uint8Array): string {
  const slice = bytes.subarray(0, HEX_PREVIEW_BYTE_COUNT)
  const hex = Array.from(slice, (b) => b.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, '0')).join(' ')
  return bytes.length > HEX_PREVIEW_BYTE_COUNT ? `${hex} …` : hex
}
