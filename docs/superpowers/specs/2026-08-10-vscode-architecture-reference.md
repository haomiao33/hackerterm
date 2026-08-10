# VS Code 架构参考

> 日期：2026-08-10 · 目的：**我们抄什么、改什么、不抄什么**
> 不是 VS Code 架构的完整介绍，只记与 HackerTerm 决策相关的部分。

---

## 1. 为什么值得参照

VS Code **同一套核心跑三种外壳**：Electron 桌面版、浏览器版（vscode.dev）、
Remote（客户端本地 + Server 远端）。这正是我们「外壳可换」目标的成品案例。

---

## 2. 分层 + 按运行环境切目录 —— 要抄

### VS Code 的做法

核心分四层：

| 层 | 职责 |
|---|---|
| `base` | 通用工具 + UI 构件 |
| `platform` | **服务注入支持 + 基础服务**（不含编辑器/工作台的具体逻辑） |
| `editor` | Monaco 编辑器 |
| `workbench` | 承载编辑器，提供资源管理器、状态栏、菜单栏等框架 |

**每层内部再按目标运行环境切目录**：

| 目录 | 只能用什么 API | 能跑在哪 |
|---|---|---|
| `common` | 只用基础 JavaScript | **所有环境** |
| `browser` | 可用 DOM 等 Web API | 浏览器 + Electron |
| `node` | 可用 Node API | Node + Electron |
| `electron-browser` | 可用 Electron API | **只有 Electron** |

### 为什么这条最关键

**代码放在 `common` 里，物理上就不可能 import 到 Electron API。**
不靠自觉、不靠 review，靠目录结构和构建约束强制。

所以后来做 vscode.dev 时，`common` 那部分一行不用改。

### 我们怎么用

**UI 层必须照抄这个切法**：

```
ui/
├── common/      纯逻辑：状态管理、协议编解码、格式化、校验
│                ★ 不许 import 任何 DOM / Electron / Node
├── browser/     用 DOM：组件、xterm.js 挂载、数据网格、拖拽
│                ★ 不许 import Electron
└── electron/    用 Electron API：窗口、托盘、菜单、MessagePort 建立
                 ★ 换外壳时只有这一层要重写
```

**必须配 lint 规则强制**，不然写着写着就散了。

> 我们比 VS Code 简单的地方：**业务逻辑本来就在 Rust 核心里**，
> 所以 `common` 层很薄，主要是协议编解码和状态管理。

---

## 3. 进程模型 —— 部分抄，且要改我们的设计

### VS Code 的进程

| 进程 | 数量 | 职责 |
|---|---|---|
| **Main** | 1 | 处理用户输入 |
| **Renderer** | 每窗口 1 个 | Workbench UI + Monaco |
| **Extension Host** | 每窗口 1 个 | 跑所有扩展，与渲染进程隔离，双向 RPC |
| **Shared Process** | **1 个（全局）** | 一个隐藏窗口，**所有窗口和主进程都能与之通信**，卸载性能密集的活 |
| **Utility Processes** | 若干 | **PTY host**、文件监视、搜索 |

### 两个反直觉的设计

**① PTY host 和文件监视是 Shared Process 的子进程**
任何窗口需要终端或文件监视，都通过 **message ports** 向 Shared Process 请求。

**② Extension Host 由 Renderer 派生，不是 Main**
而且**主进程和 Extension Host 之间没有直连通道** —— 只有
Main↔Renderer 和 Renderer↔ExtHost 两条。这是刻意的隔离设计。

### 对我们的修正

> **⚠️ 改动：Rust 核心必须是单实例、跨窗口共享，不是每窗口一个。**

我们的 Rust 核心对应 VS Code 的 Shared Process：

| 为什么必须单实例 | |
|---|---|
| 操作日志 | 全局一份，每窗口一个会写乱 |
| 补全索引 | 全局一棵前缀树，分裂就失去意义 |
| 连接树 + 配置 | 一处改动要所有窗口立刻可见 |
| SSH 连接复用 | 数据库走 SSH 隧道要复用同一条连接 |

所以架构修正为：

```
Electron 主进程（1）
  └── Rust 核心 utility process（1，全局单实例）★
  └── 渲染进程（每 Tab 1 个）
        └── 各自通过 MessagePort 直连 Rust 核心
```

---

## 4. 沙箱迁移 —— 教训要记，路不用走

### VS Code 经历了什么

沙箱化之前，**渲染进程是 Node API 的大客户**（比如直接读写文件），
IPC 也大量走 Node sockets。迁移时被迫做了这些：

- 渲染进程不能用 Node → 活要委托给有 Node 的进程
- **子进程所有权从渲染进程搬到 Extension Host**
- **集成终端和文件监视搬到 Shared Process 的子进程**
- 窗口改为通过 message ports 获取这些服务

而且他们**没有另做一个沙箱版应用**，而是"几年间每月稳定版都发带沙箱准备的改动但不启用，最后才翻开关"。这个迁移做了数年，2022 年 11 月才宣告完成。

### 我们的做法

**新项目，一开始就沙箱，这几年的债直接不背。** 这是后发优势。

但教训要记死：

> **任何时候都不能让渲染进程直接碰文件、进程、网络。**
> 一旦破例，以后就是 VS Code 那样的多年迁移。

我们的架构天然满足这条 —— **除了画面全在 Rust**，渲染进程本来就没有可碰的东西。

---

## 5. 服务注入 —— 轻量借鉴

VS Code 的 `platform` 层定义**服务注入支持**和基础服务。组件不直接 new 具体实现，
而是声明依赖、由容器注入。

**对我们**：UI 层做一个轻量的服务注册/注入即可，避免组件直接 import 具体实现。
不用上完整的 DI 框架 —— 我们的服务数量比 VS Code 少一个数量级。

关键是：**组件依赖「协议客户端接口」，不依赖「napi 模块」**。
这样测试时能塞假实现，换外壳时能换传输层。

---

## 6. 长期机会：客户端/服务端可分离

### VS Code 做到了什么

| 形态 | 说明 |
|---|---|
| Remote Development | **把 VS Code 劈成两半** —— 客户端在本地，VS Code Server 跑在远端；扩展在远端执行 |
| vscode.dev | 完全跑在浏览器沙箱里；为此做了**跑在 web worker 里的 Extension Host** |
| Remote Tunnels | 不需要 SSH，通过安全隧道连远端机器 |

### 对我们的意义

如果 Rust 核心的协议做对了，以后能做 **HackerTerm Server** ——
核心跑在服务器上，本地只留 UI。

**这对企业版是天然的演进方向**：所有 SSH 和数据库连接都从服务器发起，
凭据根本不下发到员工电脑，审计天然完整。

> **V1 不做，但协议别把这条路堵死。**
> 具体来说：协议里不要出现任何假设「核心和 UI 在同一台机器」的东西 ——
> 比如不要传本地文件路径当句柄、不要假设共享内存一定可用。
>
> 当前设计已经基本满足（消息 + 二进制块），需要复查的是
> `SharedArrayBuffer` 那条数据面路径 —— 它是本机专用的，
> 跨机器时要能降级成流式传输。

---

## 6b. 插件系统 —— 为什么 VS Code 的插件不拖慢主界面

> **结论先行：它快不是因为代码优化得好，是架构上让插件「不可能拖慢 UI」。**

### 四条机制

**① 声明式 manifest —— 不加载代码就知道插件提供什么**

插件的 `package.json` 里用 **contribution points** 声明贡献了哪些命令、菜单项、
快捷键、语言关联、主题。VS Code **完全不用加载插件代码**就能把这些渲染出来。

> **装了 100 个插件，启动时加载 0 个。**
> 这是「快」的最大来源。

**② 激活事件（activation events）—— 按需加载**

插件声明「什么情况下才需要我」。VS Code **尽可能晚地加载扩展**；
一个会话里没用到的扩展**根本不加载，不消耗内存**。

**③ 进程隔离 + 刻意不暴露 DOM**

扩展跑在独立的 Extension Host 进程。官方给了两个理由：

> 1. 防止扩展影响 VS Code 的稳定性和性能
> 2. **让 VS Code 能继续改自己的 DOM 而不破坏现有扩展**

第二条常被忽略，但它保护的是**自己的演进自由** —— 扩展一旦能碰 UI 内部，
UI 就再也改不动了。

**④ API 全异步**

所有操作用 promise 表示。扩展**没有任何办法同步阻塞 UI 线程** ——
不是靠文档劝说，是 API 层面根本不存在同步方法。

**RPC 形态**：渲染进程暴露 `MainThread*` actors，扩展宿主暴露 `ExtHost*` actors，
双向 RPC。

### 最重要的推论：插件 API ≠ 核心协议

VS Code 官方原话：**「vscode API 是一个设计出来的边界」** ——
给扩展能力，同时让它们不可能碰 DOM 或搞乱 UI。

对我们：**插件 API 绝不能是核心协议的直接暴露。**

我们的核心协议有 10 个方法域、几十个方法，是给外壳用的、要能自由演进
（协议 §7 那套 major/minor + 能力集的规则）。如果直接开放给插件，
**以后改协议就会破坏所有插件**，那套演进规则就全废了。

```
插件  ──►  插件 API（窄、稳定、全异步、能力受限）
                    │  ← 这层是对第三方的承诺，轻易不改
            核心协议（宽、可自由演进）
                    │
              Rust 核心
```

### 我们的插件系统该长什么样（V1 不做，但方向定死）

| 机制 | 我们的做法 |
|---|---|
| **声明式 manifest** | 插件用清单声明贡献点，**不加载代码就能渲染** |
| **贡献点** | 命令（进命令面板）· 菜单项 · 快捷键 · 主题 · 面板类型 · 设置项 · 数据库驱动 · 补全来源 |
| **激活事件** | `onCommand:*` · `onConnectionKind:mysql` · `onTerminalOpen` · `onStartupFinished` |
| **进程隔离** | 已定：进程外 + stdio JSON-RPC 2.0（与 MCP 同构） |
| **不暴露 UI 内部** | 插件不能直接操作 DOM；要自定义界面走受限的面板机制 |
| **API 全异步** | 协议层面不提供任何同步调用 |
| **不直接暴露核心协议** | 插件 API 是独立的一层，映射到核心协议但不等于它 |

> **V1 不做插件，但上面这些现在就要想清楚** —— 因为「贡献点」这个机制
> 会反过来要求命令、菜单、快捷键、主题这些**在 V1 就设计成可注册的**，
> 而不是硬编码。事后改要动整个 UI 层。

---

## 7. 不抄的部分

| VS Code 的做法 | 我们不抄的理由 |
|---|---|
| Extension Host 由 Renderer 派生 | 我们 V1 不做插件；将来做时再定，但**要记住这个隔离思路** |
| 每窗口一个 Extension Host | 我们的插件宿主大概率全局一个就够 |
| 完整的 DI 容器 | 服务数量差一个数量级，轻量注册即可 |
| 四层分层（base/platform/editor/workbench） | 我们业务逻辑在 Rust，UI 层不需要这么多层 |

---

## 8. 结论：本次参照带来的三处改动

| # | 改动 | 影响文档 |
|---|---|---|
| 1 | **Rust 核心明确为全局单实例**（对应 Shared Process） | 技术方案 §1b、协议 §2 |
| 2 | **UI 层按 `common` / `browser` / `electron` 切目录并用 lint 强制** | 技术方案新增 |
| 3 | **协议不得假设核心与 UI 同机**，为将来 Server 形态留路 | 协议 §9 待办 |
| 4 | **命令、菜单、快捷键、主题、面板类型 V1 就要设计成「可注册」而非硬编码** | 技术方案、产品文档 §18 |
| 5 | **插件 API 定为独立一层，不直接暴露核心协议** | 技术方案 §11 |

> 第 4 条是这次参照最容易被漏掉、但事后代价最大的一条：
> 「贡献点」机制要求这些东西从一开始就是**注册表驱动**的。
> V1 如果把菜单项和快捷键硬编码在组件里，将来做插件时要动整个 UI 层。

---

## 参考

- [VS Code 源码组织（分层与目标运行环境）](https://github.com/microsoft/vscode/wiki/Source-Code-Organization) · [wiki 原文](https://github.com/microsoft/vscode-wiki/blob/main/Source-Code-Organization.md)
- [Migrating VS Code to Process Sandboxing（2022-11）](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox)
- [PTY Host 与多服务端支持](https://deepwiki.com/microsoft/vscode/9.4-pty-host-and-multi-server-support)
- [VS Code Internals: Extension Host](https://roopik.com/blog/vscode-internals-extension-host) · [IPC Decoded: VS Code 进程间通信](https://roopik.com/blog/vscode-internals-advanced-ipc)
- [VS Code Remote Development 总览](https://code.visualstudio.com/docs/remote/remote-overview) · [VS Code for the Web](https://code.visualstudio.com/docs/remote/vscode-web) · [vscode.dev 发布博客](https://code.visualstudio.com/blogs/2021/10/20/vscode-dev)
