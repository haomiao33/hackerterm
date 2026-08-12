import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * 渲染进程 ↔ core-host 这对 MessagePort 上，postMessage 一律不许带 transfer 列表。
 *
 * ── 为什么要有这条守卫 ──
 * Electron 在「渲染进程 → MessagePortMain」这个方向上，只要 transfer 列表里出现
 * ArrayBuffer，整条消息（连同数据本身）就会被整体丢弃，不报错、不抛异常——见
 * electron#34905（至今 open，Electron 43 仍复现）。真机症状是：出向的 onData 日志
 * 200+ 条条条都在，PTY 侧一个字节都没收到。反方向（core-host → 渲染）之前已经踩过
 * 一次同样的坑（见 commit bb36cc6），这次是它的镜像。两次的共同点都是有人为了
 * 「零拷贝」把 transfer 写了回去，所以需要一条会变红的测试盯着。
 *
 * ── 这个测试能保证什么 ──
 * 只要有人在 src/ui/browser/boot.ts 或 src/core-host/index.ts 里给 postMessage 加回
 * 第二个实参（transfer 列表），这条测试立刻变红，并指出文件名和行号。它读的是真实的
 * 生产源码文件、用 TypeScript 编译器 API 真解析成 AST，不是正则、不是快照。
 *
 * ── 这个测试不能保证什么（重要）──
 * 1. 它证明不了字节真的到达了 PTY。Electron 的跨进程序列化行为只有真机能验证：
 *    敲键 → 看 PTY 回显，这是唯一的最终判据。
 * 2. 它只看这两个文件里字面写着 `.postMessage(...)` 的调用。如果以后有人把
 *    postMessage 包进一个 helper 再从别处调用，这个守卫看不见（届时应把守卫
 *    一起挪到那个 helper 上）。
 * 3. 它管不了 preload（`window.postMessage(msg, '*', e.ports)`）：那是渲染进程内部
 *    的标准 DOM 语义，transfer MessagePort 本来就是合法且必需的，所以不在守卫范围内。
 *
 * ── 为什么不写「行为测试」 ──
 * 有两种看着更像样、实际是自欺欺人的写法，这里明确拒绝：
 * (a) 用 Node 的 MessageChannel 真跑一遍 postMessage(buf, [buf])，断言对端收到数据。
 *     ——Node/V8 对 ArrayBuffer transfer 支持得好好的，这个测试在 vitest 里带着 bug
 *     也照样绿，只会给出假的安全感，比没有测试更糟。
 * (b) mock 一个「看到 transfer 列表就把消息丢掉」的假 MessagePortMain。
 *     ——那是把结论先写进 mock 再断言一遍，自证循环，证明不了 Electron 真这么干。
 * 所以这里退一步，只做诚实的结构性守卫：不假装能复现 Electron 的语义，只保证那行
 * 危险代码不会被悄悄写回来。
 */

/** 受守卫的文件：渲染侧和 core-host 侧各自持有这对 MessagePort 的一端。 */
const GUARDED_FILES = [
  'ui/browser/boot.ts',
  'core-host/index.ts',
] as const

interface PostMessageCall {
  line: number
  argCount: number
  text: string
}

/** 用 TS 编译器 API 把源码解析成 AST，收集所有 `x.postMessage(...)` 调用。 */
function findPostMessageCalls(fileName: string, source: string): PostMessageCall[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const calls: PostMessageCall[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'postMessage'
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      calls.push({
        line: line + 1,
        argCount: node.arguments.length,
        text: node.getText(sourceFile).replace(/\s+/g, ' '),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

function readGuardedFile(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(`./${relPath}`, import.meta.url)), 'utf8')
}

describe('渲染进程 ↔ core-host 的 MessagePort 不得使用 transfer 列表', () => {
  // 先证明检测器本身是活的。没有这两条，检测器一旦失灵（路径写错读到空文件、
  // AST 匹配条件写错），上面的守卫会变成"什么都没找到所以通过"的哑弹——
  // 静默失效正是这个项目最不能接受的失败方式。
  it('检测器能从样本代码里揪出带 transfer 的 postMessage', () => {
    const sample = `
      const port = getPort()
      port.postMessage(bytes)
      port.postMessage(bytes.buffer, [bytes.buffer])
    `
    const calls = findPostMessageCalls('sample.ts', sample)

    expect(calls).toHaveLength(2)
    expect(calls.filter((c) => c.argCount > 1)).toHaveLength(1)
  })

  it.each(GUARDED_FILES)('%s 里确实解析到了 postMessage 调用（防止空过）', (relPath) => {
    const calls = findPostMessageCalls(relPath, readGuardedFile(relPath))
    expect(calls.length).toBeGreaterThan(0)
  })

  it.each(GUARDED_FILES)('%s 里没有任何 postMessage 带 transfer 列表', (relPath) => {
    const offenders = findPostMessageCalls(relPath, readGuardedFile(relPath))
      .filter((c) => c.argCount > 1)
      .map((c) => `src/${relPath}:${c.line}  ${c.text}`)

    // 断言写成"列表相等"而不是 length===0，失败时能直接看到是哪一行犯规。
    expect(offenders).toEqual([])
  })
})
