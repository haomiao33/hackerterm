import tseslint from 'typescript-eslint'

// 偏离 brief 逐字稿：brief 给的配置没有声明 TS 解析器，默认 espree 无法解析
// `interface`/`enum` 等 TS 语法（`pnpm lint` 直接报 Parsing error）。补一段全局
// parser 配置让规则真正跑起来，其余规则块保持 brief 原文不变。见 task-5-report.md。
export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
  },
  {
    files: ['src/ui/common/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['electron', 'electron/*'], message: 'ui/common 不得依赖 Electron' },
          { group: ['node:*', 'fs', 'path', 'child_process'], message: 'ui/common 不得依赖 Node' },
        ],
      }],
      'no-restricted-globals': ['error',
        { name: 'window', message: 'ui/common 不得依赖 DOM' },
        { name: 'document', message: 'ui/common 不得依赖 DOM' },
      ],
    },
  },
  {
    files: ['src/ui/browser/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['electron', 'electron/*'], message: 'ui/browser 不得依赖 Electron，换外壳时这层要能复用' }],
      }],
    },
  },
]
