# HackerTerm 技术方案

> 日期：2026-08-07 · 配套：`2026-08-07-hackerterm-v1-product-design.md`
> **技术栈已定：Electron 外壳 + Rust 核心（napi-rs）+ VS Code 式 PTY 架构**

---

## 0. 结论速览

| 层 | 选型 | 理由 |
|---|---|---|
| 外壳 | **Electron** | 两平台一个引擎（Chromium），行为一致；Chrome 进程模型白拿；Node 内置 |
| 终端渲染 | **xterm.js + WebGL addon** | 比其它渲染器快 3-5 倍；大输出下瓶颈已转移到 PTY 投递，渲染不是瓶颈 |
| PTY | **node-pty**（VS Code 同款） | Windows 走 ConPTY，旧版回退 winpty，已被 VS Code 打磨多年 |
| PTY 架构 | **独立 PTY Host 进程 + 流控 + 事件批处理** | 见 §2，这是「大输出不卡」的真正答案 |
| SSH / SFTP | **russh**（Rust，经 napi-rs 暴露） | 纯 Rust 无 C 依赖；微软有 `vscode-russh` fork |
| 数据库 | **sqlx**（Rust，经 napi-rs） | 纯 Rust MySQL + PG |
| 本地存储 | **SQLite**（Rust 侧） | 操作日志 + 补全索引 |
| **IPC** | **MessagePort + Transferable / SharedArrayBuffer；数据库走 Apache Arrow** | 零序列化、进程直连、不经主进程中转 |
| 补全查找 | **前缀树 Trie**（Rust 内存态） | 微秒级，主线程不碰磁盘 |
| UI | Web（框架待定） | 数据网格、表单、i18n、拖拽全是成熟生态 |
| 插件 | Node（Electron 自带） | 零成本，且 Claude Code / Codex 等 AI CLI 直接能跑 |

### 为什么不是 Rust 原生 / Tauri

| 方案 | 否决理由 |
|---|---|
| Rust 原生（egui + winit） | UI 层全部手搓：可视化建表、快捷键管理器 + 6 套预设、连接表单、主题编辑器、数据网格，即时模式 GUI 里一个现成控件都没有。egui 中文输入法有已知问题、不带默认中文字体、API 仍在破坏性变更。跨窗口拖 Tab winit 什么都不给 |
| Tauri | 技术上可行（WebView2 本身就是 Chromium 多进程），但 **macOS 用 WKWebView，两个引擎行为不一致，每个功能要各测一遍**。省下的装机体积换不来这个代价 |

### 认下来的代价

| 代价 | 说明 |
|---|---|
| 装机 ~150MB | 用户已明确表示体积和内存不管 |
| 冷启动 1-2 秒 | 用户已明确表示启动慢没事 |
| **空闲 CPU 做不到 0%** | 产品文档 §7 那条要下调为「空闲时接近 0、不引起风扇转」 |
| 「又一个 Electron 终端」的印象分 | 靠实际手感翻盘，见 §2 |

---

## 1. 整体架构

```
┌──────────────────────────────────────────────────────────┐
│  Electron 主进程                                          │
│  窗口管理 · Tab 编排 · 自动更新 · 托盘 · 全局快捷键        │
└────────┬─────────────────────────────┬───────────────────┘
         │                             │
┌────────▼──────────┐      ┌───────────▼──────────────────┐
│  PTY Host 进程     │      │  Rust 核心（napi-rs 原生模块）│
│  node-pty          │      │  SSH / SFTP（russh）          │
│  ConPTY / Unix PTY │      │  数据库（sqlx）                │
│  流控 XOFF/XON     │      │  补全索引（前缀树 + SQLite）    │
│  事件批处理        │      │  操作日志（SQLite）             │
│                   │      │  凭据存储 · 配置 · 授权检查     │
└────────┬───────────┘      └───────────┬──────────────────┘
         │                              │
┌────────▼──────────────────────────────▼──────────────────┐
│  渲染进程 —— 一个 Tab 一个                                 │
│  终端 xterm.js + WebGL · 数据库网格 · 文件面板 · 表单       │
└──────────────────────────────────────────────────────────┘
```

**分工原则**：
- **性能与安全关键 → Rust**（SSH、数据库、补全索引、操作日志、凭据）
- **OS 胶水层 → 用被验证过的现成件**（node-pty）
- **UI → Web 生态**（数据网格、表单、拖拽、i18n 全是成熟货）

---

## 2. 「丝滑」怎么落地（产品文档 §2②）

> **丝滑不是框架决定的，是架构决定的。**
> Tabby 是 Electron 被喷，VS Code 也是 Electron 但终端很好。差别就在下面这几条。

### 2.1 四条核心机制（照抄 VS Code）

| 机制 | 做法 | 解决什么 |
|---|---|---|
| **PTY Host 独立进程** | 渲染进程 ↔ PTY Host ↔ shell，PTY 读写不在渲染进程 | **大量输出不冻结界面** |
| **流控 XOFF/XON** | xterm.js `useFlowControl`，**不让 pty 跑得比 xterm.js 快太多** | **`cat` 大文件不卡的真正答案**——不是渲染更快，是让数据别涌进来 |
| **事件批处理** | 数据成批送到渲染进程，不是来一点送一次 | 减少无谓重绘和 IPC 次数 |
| **WebGL 渲染器** | xterm.js WebGL addon（**不用 canvas / DOM 渲染器**） | 比其它渲染器快 3-5 倍 |

### 2.2 还要自己加的

| 要求（产品文档 §7） | 做法 |
|---|---|
| 按键到显示 < 16ms | 按键走最短路径直达 PTY，不经过任何异步队列 |
| 空闲时不重绘 | 无数据时不触发 render loop，**目标是接近 0% CPU 而不是绝对 0%** |
| 10+ 会话并发刷屏互不影响 | 每个 Tab 独立渲染进程 + 各自独立的流控窗口 |
| `Ctrl+C` 立刻中断 | 中断信号走带外通道，不排在输出数据队列后面 |

### 2.3 验收方式
必须做**并发压测**：同时开 10 个会话，其中 3 个 `cat` 大文件、3 个 `tail -f` 高速日志，
在剩下的会话里敲命令，观察输入延迟和帧率。**不能只测单会话。**

---

## 2b. IPC —— 组件间通信（终端和数据库的共同瓶颈）

### 先澄清：Chromium 的 Mojo 抽不出来给我们用

| | 结论 |
|---|---|
| 技术上能不能抽出来 | **能**。C++ 绑定只依赖 Chromium 的 `//base` 一个库；C API 层几乎只依赖 libc / pthreads |
| 官方支不支持 | **不支持**。Chromium 明确说维护这类移植不是他们的目标；**`//base` 不设计稳定 API**，随时会改 |
| 有没有 Rust / Node 绑定 | **没有维护的** |
| **决定性障碍** | **在 Electron 里插不进去** —— 渲染进程由 Electron 拉起，我们无法在它们之间建自己的 Mojo 通道。只能在自己 fork 的进程间用，而那些进程本来就能自由选协议，用 Mojo 毫无意义 |

### 但 Mojo 快在哪，就直接拿那三样

Mojo 不是魔法，它快就快在三件事，Electron 生态里都有成熟对应：

| Mojo 的机制 | 我们用什么 |
|---|---|
| POD 不做序列化 | Transferable `ArrayBuffer` / 自定义二进制布局 / **Apache Arrow** |
| 大负载走共享内存 | `SharedArrayBuffer` + `Atomics` 环形缓冲 |
| 进程直连不中转 | `MessagePort` |

Electron 主进程连 Blink 都没有，所以没有 DOM 的 `MessagePort`——
它另提供了 `MessagePortMain` / `MessageChannelMain`。三样能力都在：

| 需要什么 | Electron 的对应 |
|---|---|
| **组件直连，不走主进程中转** | `MessagePort`：渲染↔渲染、渲染↔主进程都能直连，绕开常规 IPC 开销 |
| **大数据不拷贝** | **Transferable `ArrayBuffer`：转移内存所有权，不是克隆** |
| **不阻塞 UI 线程** | 在 Web Worker 里收和解码，不在主世界处理 |

> 注意：MessagePort 必须用 `ipcRenderer.postMessage` / `webContents.postMessage` 传递，
> **常规的 `send` / `invoke` 传不了 MessagePort**。

### 两条大数据链路，形态不同，分开设计

| | 终端 | 数据库结果集 |
|---|---|---|
| 形态 | **高频小包**，持续不断，**无结构原始字节** | **低频大包**，一次几 MB，**结构化表格** |
| 关键指标 | 延迟 + 不积压 | 吞吐 + 不阻塞 UI |
| 传什么 | 裸 `ArrayBuffer` | **Apache Arrow 列式格式** |
| 关键机制 | **流控 XOFF/XON** + 事件批处理 | **分页拉取** + Worker 里零拷贝读 |

```
终端链路（高频小包，无结构）
  shell ──► PTY Host ──MessagePort + Transferable ArrayBuffer──► 渲染进程 ──► xterm.js
                ▲                                                    │
                └──────────────── XOFF/XON 流控 ◄────────────────────┘

  终端不套任何 schema —— 它就是字节流，裸 ArrayBuffer 就是最优解

数据库链路（低频大包，结构化）
  DB ──► Rust 核心 sqlx ──► arrow-rs 组装 ──SharedArrayBuffer──► Arrow JS 零拷贝读 ──► 网格
                                  ▲                                    ▲
                        列式内存布局，语言无关            只读元数据即可"反序列化"，
                                                        不拷贝、不移动实际数据
              分页：滚到哪拉到哪，不一次性全量
```

### 为什么数据库这条用 Apache Arrow

这就是「成熟的开源零拷贝 IPC 组件」，而且比 Mojo 贴合我们的场景得多：

| 特性 | 说明 |
|---|---|
| 语言无关的列式内存格式 | 天生就是给"跨进程/跨语言传表格数据"设计的 |
| **零拷贝读** | Arrow 的 IPC 消息**只读元数据就能"反序列化"成内存数组对象，不拷贝也不移动实际数据** |
| Rust 侧成熟 | `arrow-rs` 是最成熟的实现之一，官方仓库就有 `zero_copy_ipc` 示例 |
| **JS 侧有实现** | 前端直接用 Arrow JS 读，喂给虚拟滚动网格 |
| 全程零序列化 | sqlx 查出来 → 组装成 Arrow → 传 → 前端读，一次序列化都没有 |

### 三条铁律

> **1. 绝不做 JSON 序列化**
> **2. 绝不转成字符串再传**
> **3. 绝不经主进程中转**

这三样任何一个出现在大数据链路上，性能直接废掉。
主进程只负责建立 MessagePort 连接，建好之后数据不再经过它。

### 待验证
Transferable 相比常规 IPC 的实测收益在传大块 `ArrayBuffer` 时约 10% 量级 ——
**真正的大头是省掉序列化和主进程中转，不是 MessageChannel 本身的加速。**
第 1 周压测要实测这条链路的端到端延迟。

---

## 3. PTY

### 选 node-pty

VS Code 同款。Windows 上默认 **ConPTY**（Win10 build 18309+），旧版回退 **winpty**。

> 这条顺带解决了原先标红的 ConPTY 风险 —— node-pty 是被 VS Code 在海量 Windows
> 机器上打磨过的，比自己从 Rust 侧调 ConPTY 稳妥得多。

### 支持的 Shell（产品文档 §7）
Windows：PowerShell · CMD · WSL · Git Bash
macOS：zsh · bash
启动时自动探测，用户可指定默认。

---

## 4. 终端渲染与字体

### xterm.js + WebGL addon

大输出测试（如 `ls -lR /usr/lib`）中，**瓶颈已经转移到 PTY 投递数据本身**，
终端在等数据、其余时间空闲 —— 渲染不再是瓶颈。

### 字体（产品文档 §13.4 的硬指标）

| 要求 | 说明 |
|---|---|
| 换主题字体观感不变 | Chromium 的字体渲染在两平台一致，这条比 Rust 原生方案更容易达成 |
| 中文不糊、中英混排清晰 | 字体栈里中英文分别指定 |
| **连字** | ⚠️ xterm.js WebGL 渲染器 + 连字有已知问题（issue #3303），**第 1 周要验证** |
| Nerd Font | 内置或检测系统已装的 |

### 主题
- 解析 `.itermcolors`（plist 格式）→ 转成 xterm.js 的 theme 对象，网上 325+ 套现成
- 同一套颜色变量同时驱动终端、数据库网格、文件面板、整个界面
- 提示符不管，交给 oh-my-zsh；只做检测 + 提示装 Nerd Font

---

## 5. SSH / SFTP

### russh（Rust）经 napi-rs 暴露

| | russh | ssh2（npm，libssh2） |
|---|---|---|
| 实现 | 纯 Rust，无 C 依赖 | C 库绑定 |
| 构建 | 简单 | 需要 C 工具链 |
| SFTP | russh-sftp | 自带 |
| 背书 | 微软 `vscode-russh` fork | 老牌 |

选 russh：产品文档 §5 要的多级跳板、三种隧道、代理（HTTP/SOCKS4/SOCKS5）
都要在库之上自己搭一层，用 Rust 写这层比用 JS 写更合适。

**文件管理复用同一条 SSH 连接的 SFTP 子系统**，不重新认证。

---

## 6. 数据库

### 驱动：sqlx（Rust）经 napi-rs

MySQL + PostgreSQL，纯 Rust。

### 「结构解析不卡」（产品文档 §2③ 硬要求）

DataGrip 卡死的根因是**一次性同步加载全部元数据**。我们的做法：

| 策略 | 说明 |
|---|---|
| **懒加载** | 只加载当前展开的那一层：点开库才查表，点开表才查列 |
| **并发拉取** | 同一层多个对象并发查，不串行 |
| **先出树后填详情** | 表名先出来，行数/大小等慢字段后台补 |
| **可取消** | 刷新随时能取消，不锁界面 |
| **落盘缓存** | 结构存 SQLite，下次连上先用缓存渲染，后台比对更新 |

最后一条同时满足产品文档 §8「结构没加载完也要有补全」——
**补全读的是本地缓存，不是实时查询。**

### 大结果集
分页流式拉取 + 前端虚拟滚动，绝不一次性拉进内存。

### dump 导入导出
直接调用系统的 `mysqldump` / `mysql` / `pg_dump` / `pg_restore` 子进程，
不自己实现。流式读输出报进度，出错解析出行号。

---

## 7. 补全（产品文档 §8 铁律：可以没有，绝不能卡）

```
用户输入 → Rust 侧内存前缀树 Trie（微秒级）→ 返回候选
                    ▲
                    │ 启动时加载 / 增量更新（后台线程）
              SQLite（操作日志派生的排序表 + 数据库结构缓存）
```

**「绝不卡」的保证**：查询只碰内存 Trie，**SQLite 读写永远在后台线程**，
调用方拿不到结果就直接不显示，不等待。

排序 = 频率 × 新近度 × 当前目录 × 当前主机。

> 名词澄清：LSM-Tree 是 RocksDB / LevelDB 的存储结构，和补全查找不是一回事
> （LSTM 是神经网络，无关）。补全查找要的是前缀树 Trie。

---

## 8. 进程隔离与崩溃（产品文档 §2④ 硬条件）

### 直接继承 Chrome 的进程模型

Electron = Chromium。**一个 Tab 一个渲染进程，崩溃隔离是白拿的。**
Chrome 这套从 2008 年做到现在，最初动机就是崩溃隔离。

| 产品承诺 | 怎么实现 |
|---|---|
| 一个 Tab 崩了不影响别的 | 渲染进程崩溃事件 → 那个 Tab 显示「已崩溃，点击重开」 |
| 界面崩了 SSH 会话不断 | 会话活在 PTY Host / Rust 核心里，不在渲染进程 |
| 更新重启不断会话 | 同上 |
| 画面出问题不白屏 | WebGL 初始化失败自动降级到 canvas 渲染器并提示 |
| 异常退出恢复现场 | 定期快照窗口布局、Tab、每个 Tab 的目录 |

---

## 9. Tab 拖出成窗口 / 拖回

Electron 多窗口是原生能力（`BrowserWindow`）。

**架构红利**：会话活在 PTY Host / Rust 核心里，窗口只是渲染端 ——
搬 Tab = 换个窗口去接那个会话，**状态一个字节都不用序列化**。

| 能力 | 难度 | 要处理什么 |
|---|---|---|
| 拖出成新窗口 | 中 | 拖拽阈值防误触；Windows 上建窗口要避免闪烁 |
| 拖回 / 拖到另一窗口的 Tab 栏 | 中高 | 跨窗口命中测试 + ghost tab 提示 + 拖动中半透明 |
| 右键 Tab →「移动到窗口 X」 | 低 | 拖拽的兜底入口，先做这个 |

Web 生态里有成熟的拖拽库，比 Rust 原生方案省很多。

---

## 10. 国际化与授权口子

### 国际化（客户国内国外都有）
- 文案全部走语言文件，代码里不出现面向用户的字符串字面量
- **选能在构建期发现漏翻译的方案**，不能等运行时才发现
- 布局按最长语言排（英文通常比中文长 30-50%）
- 错误提示也必须进语言文件 —— 最容易漏，但用户最需要看懂

### 授权检查
```
功能执行前 → 授权检查(功能标识) → 放行 / 拒绝
                  ↓
      V1：永远放行，但调用链真实存在
      以后：读配置决定，不改功能代码
```
**关键是 V1 就真的调用它。** 只留 TODO 等于没留。
被拒绝时：功能显示为不可用 + 说明原因，不是点了没反应也不是报错。

---

## 11. 插件与 AI CLI（V1 不做，方向已定）

**Electron 自带 Node，这块成本几乎为零。**

| 决定 | 说明 |
|---|---|
| 进程外，stdio + JSON-RPC 2.0 | 和 MCP 完全同构，以后接 AI 生态几乎免费 |
| 主推 JS，不绑死语言 | 进程外通信天然语言无关 |
| Lua 先不做 | 两套脚本语言 = 两套 API + 两倍 bug |
| **内置 AI CLI 变简单了** | Claude Code / Codex 都是 Node CLI，**Electron 自带 Node，不用再单独内置运行时** |

---

## 12. 打包分发（待细化）

| 事项 | 状态 |
|---|---|
| Windows 代码签名 | 待办，不签会报毒 |
| **macOS 公证** | 待办，**不公证用户下载下来直接打不开** |
| 自动更新 | 增量更新 + 失败回滚；**企业版可完全禁用**（内网离线） |
| 只发 Win + Mac | Linux 不发 |

---

## 13. 第 1 周要验证的四件事

| # | 验证什么 | 通过标准 |
|---|---|---|
| 0 | **IPC 链路端到端延迟** | MessagePort + Transferable 直连，测终端字节从 PTY 到屏幕的延迟，以及几 MB 结果集的传输和解码耗时 |
| 1 | **大输出并发压测** | 10 个会话，3 个 `cat` 大文件、3 个 `tail -f`，在其余会话敲命令不卡；`Ctrl+C` 立刻断 |
| 2 | **中文输入法** | Win 微软拼音 + 搜狗、Mac 系统拼音，候选框位置、上屏、退格都正常 |
| 3 | **字体与连字** | 亮/暗主题字重观感一致；中英混排中文不糊；**WebGL 渲染器 + 连字**（已知 issue #3303） |
| 4 | **Tab 崩溃隔离** | 手动杀掉一个渲染进程，确认其它 Tab 照常、SSH 会话不断 |

**任何一件不通过，都要在写业务代码前先解决。**

---

## 待办：还没定的技术选型

- 前端框架（React / Vue / Svelte / Solid）
- 数据网格库（要支持虚拟滚动 + 单元格编辑 + 几十万行）
- i18n 库（要构建期检查）
- SQL 编辑器组件（要支持我们自己的补全接入）
- 打包工具与自动更新方案

---

## 参考

- [VS Code 终端架构](https://deepwiki.com/microsoft/vscode/6-integrated-terminal) · [PTY Host 进程 + 流控 + 事件批处理 issue #74620](https://github.com/microsoft/vscode/issues/74620) · [VS Code 终端渲染器演进](https://code.visualstudio.com/blogs/2017/10/03/terminal-renderer)
- [xterm.js](https://github.com/xtermjs/xterm.js/) · [WebGL Renderer PR #1790](https://github.com/xtermjs/xterm.js/pull/1790) · [@xterm/addon-webgl](https://www.npmjs.com/package/@xterm/addon-webgl) · [连字渲染问题 #3303](https://github.com/xtermjs/xterm.js/issues/3303)
- [NAPI-RS](https://napi.rs/) · [Electron 中使用 napi-rs 示例](https://daveceddia.com/napi-rs-electron-example/) · [Electron 原生代码文档](https://www.electronjs.org/docs/latest/tutorial/native-code-and-electron)
- [Chromium 多进程架构](https://www.chromium.org/developers/design-documents/multi-process-architecture/) · [进程模型与站点隔离](https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md)
- [Electron MessagePorts 教程](https://www.electronjs.org/docs/latest/tutorial/message-ports) · [MessageChannelMain API](https://www.electronjs.org/docs/latest/api/message-channel-main) · [Electron IPC 文档](https://www.electronjs.org/docs/latest/tutorial/ipc) · [contextBridge 与 IPC 性能优化](https://coldfusion-example.blogspot.com/2026/01/electron-performance-optimizing.html)
- Mojo：[在 Chromium 之外使用 Mojo 的讨论](https://groups.google.com/a/chromium.org/g/chromium-mojo/c/BE3wGRpV9Rs) · [Chromium 独立库讨论](https://groups.google.com/a/chromium.org/d/topic/chromium-dev/rJUfp5RQZd4) · [Mojo 文档](https://chromium.googlesource.com/chromium/src/+/HEAD/mojo/README.md)
- [Apache Arrow](https://arrow.apache.org/) · [Arrow 列式格式规范](https://arrow.apache.org/docs/format/Columnar.html) · [arrow-rs 零拷贝 IPC 示例](https://github.com/apache/arrow-rs/blob/main/arrow/examples/zero_copy_ipc.rs)
- [WebView2 进程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)（用于对比 Tauri 路线）
- [russh](https://github.com/Eugeny/russh) · [microsoft/vscode-russh](https://github.com/microsoft/vscode-russh)
- [sqlx](https://github.com/launchbadge/sqlx)
- [iTerm2 Color Schemes（325+ 套）](https://iterm2colorschemes.com/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [MCP 传输层](https://modelcontextprotocol.info/docs/concepts/transports/)
