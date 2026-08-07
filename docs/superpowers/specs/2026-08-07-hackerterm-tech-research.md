# HackerTerm 技术调研

> 日期：2026-08-07 · 配套文档：`2026-08-07-hackerterm-v1-product-design.md`
> 目的：在动手前把不确定性最高的几处摸清楚，避免写到一半返工。

---

## 0. 结论速览

| 层 | 选型 | 把握度 |
|---|---|---|
| 语言 | Rust | 高 |
| 终端内核 | `alacritty_terminal` + `vte` | 高 |
| PTY | `portable-pty`，**Windows 需打 ConPTY 补丁** | ⚠️ 中，第 1 周必须验证 |
| SSH | `russh`（纯 Rust）+ `russh-sftp` | 高 |
| 文字渲染 | `glyphon`（cosmic-text + etagere + wgpu） | 中高 |
| UI | `egui` + `egui_extras` 系表格生态 | ⚠️ 中，见 §3 |
| GPU | `wgpu` → Metal / DX12 | 高 |
| 数据库 | `sqlx`（MySQL + PG，纯 Rust） | 高 |
| 本地存储 | SQLite（补全 + 操作日志） | 高 |

**三个必须在第 1 周验证的风险点**：Windows ConPTY、中文输入法、字体渲染质量。

---

## 1. 终端内核

### 选 `alacritty_terminal` + `vte`

- `vte`：ANSI/VT 转义序列解析状态机（基于 Paul Williams 的 DEC 解析器状态图）
- `alacritty_terminal`：Term / Grid / Cursor / Scrollback / Selection / Search / PTY 派生
- 许可 Apache-2.0，**Zed 编辑器的内置终端就是基于它**，生产验证充分

**这一层等于白拿**：产品文档 §2② 要求的 VT 兼容性长尾（DEC 私有序列、CJK 宽字符、
mouse 上报、bracketed paste）全都在里面，自己写要 6+ 人月。

### 备选：`wezterm-term`
MIT 许可，DEC 私有序列和 Sixel 覆盖更全。如果 alacritty_terminal 有兼容性缺口再换。

---

## 2. PTY —— ⚠️ Windows 是最大的坑

### 查到的问题

`portable-pty` 上游 **不传现代 ConPTY 的创建标志**，导致在 Windows 10/11 上行为不正确。
社区 fork（如 `portable-pty-psmux`）打了三个补丁：

| 补丁 | 解决什么 |
|---|---|
| `PASSTHROUGH_MODE` | VT 序列直通，不被 ConPTY 二次处理 |
| `WIN32_INPUT_MODE` | 按键正确传递（否则组合键会丢） |
| `RESIZE_QUIRK` | 修 resize 时的画面残留 |

### 对我们的影响

产品文档 §2② 承诺「`cat` 几十 MB 二进制文件不卡、能 `Ctrl+C` 立刻中断」，
这三个补丁没打全的话，**Windows 上直接做不到**。

### 行动
**第 1 周就要在 Windows 上跑通一个最小 PTY demo**，验证：
`cat` 大文件、`Ctrl+C` 中断、resize 无残留、组合键传递、PowerShell / CMD / WSL / Git Bash 四种都能起。

> 这条不验证就开工，是整个项目最大的返工风险。

---

## 3. UI 框架 —— ⚠️ 中文输入法是关键风险

### 查到的情况

**egui 的 IME 支持历史上很弱，但 2026 已有明显改善**：

| 时间线 | 状态 |
|---|---|
| 早期 | eframe 原生端根本没有 IME，卡在 winit 没有 IME 支持 |
| 现在 | winit 的 IME 支持已落地；egui TextEdit 支持 IME，有 composition 视觉和候选框定位 |
| 已知 bug | #5544「IME 在 Linux 上从 v0.29.0 起失效」 |
| 另一个坑 | **egui 不带默认中文字体**，要手动加载（issue #162 / #3060） |

### 风险评估：比看上去小，但不能不管

**好消息**：那个严重 bug (#5544) 是 **Linux 专有**，而我们**只发 Windows + macOS**，
直接绕开了最严重的一个。

**更重要的兜底**：终端面板**可以完全不依赖 egui 的 IME**。
winit 直接提供了完整的 IME 接口：

```
Ime::Enabled   →  IME 已启用，开始接收后续事件
Ime::Preedit   →  正在输入的候选文字 + 光标区间（拼音输入过程中的那串）
Ime::Commit    →  确定上屏的文字
Window::set_ime_cursor_area(位置, 大小)  →  告诉系统候选框画在哪
```

也就是说**终端这块我们自己接 winit 的 IME，行为完全可控**，
只有 SQL 编辑器、搜索框、连接表单这些用 egui 的地方依赖它的实现。

### 为什么还是选 egui

| 框架 | IME | 表格/数据网格 | 结论 |
|---|---|---|---|
| **egui** | 中（Win/Mac 可用，需手动配中文字体） | **强**：`egui_extras::TableBuilder`、`egui_deferred_table`、`egui_virtual_list`、`egui-selectable-table`，另有 Rerun Viewer 这样的生产案例 | ✅ 选它 |
| iced | 中（有候选框定位修复的 PR） | 弱，没有成熟表格生态 | ❌ 数据库网格要从零造 |
| Tauri | **最好**（WebView2 负责，完美） | 强（整个 Web 生态） | ❌ 已排除（性能与体积） |
| gpui | — | 有 `gpui-component` | ❌ pre-1.0，官方不支持 Windows |

**决定性因素是表格。** 产品文档 §9 的数据库结果网格要求虚拟滚动 + 单元格可编辑 +
几十万行不卡，egui 生态里有四个现成的表格 crate，iced 里一个都没有。
自己造这个控件是 2-3 人月。

**egui 的代价要认**：API 仍在变，版本间有破坏性更新。要锁定版本，不跟着最新版跑。

### 行动
**第 1 周验证**：Windows 上用微软拼音和搜狗输入法，在终端面板和 egui 文本框里各打一段中文，
看候选框位置、上屏、退格是否正常。

---

## 4. 文字渲染

### 选 `glyphon`

它就是「cosmic-text 排版 + etagere 打图集 + wgpu 采样」的成品，
Emoji / 连字 / CJK / 字体回退全由 cosmic-text 负责。许可 Apache-2.0 / MIT / zlib。

### 借鉴 iTerm2 的做法

查了 iTerm2 Metal 渲染器的思路，和我们要做的完全一致：

| iTerm2 的做法 | 对应我们的要求 |
|---|---|
| **CPU 管解析和状态，GPU 管画** | 产品文档 §2② 大量输出不卡 |
| 每个格子是一个贴图四边形，**字形图集放在 GPU 内存** | 画 10000 个格子和画 100 个成本差不多 |
| 把绘制从主线程挪走 | 主线程被慢绘制阻塞就会卡住数据处理 —— 这是 CPU 渲染终端的根本瓶颈 |
| 验收标准：**`cat /dev/urandom` 不卡顿** | **和我们定的验收标准是同一个** |

**这验证了产品文档 §2② 那条标准定得对**，是业内公认的硬指标。

### 关键实现要点（决定"丝滑"成败）

1. **只在有变化时重绘**（damage 驱动）—— 对应「无输出时 CPU 0%」
2. **输出洪水时合并渲染**：疯狂刷屏时照样全量解析进 Grid，但**每个垂直同步周期只画最终状态一次**，不是每来一批数据画一次
3. **解析线程和渲染线程解耦** —— 渲染慢不能阻塞 PTY 读取
4. **伽马校正** —— 解决产品文档 §13.4 那条「换个配色字体就废了」

### 行动
**第 1 周验证**：亮色和暗色主题下截图对比字重，中英文混排看中文是否发糊，
125% / 150% / 200% 缩放各看一遍。

---

## 5. SSH

### 选 `russh` + `russh-sftp`

| | russh | ssh2 |
|---|---|---|
| 实现 | **纯 Rust**，基于 Tokio | libssh2 的 C 绑定 |
| 依赖 | 无 C 库 | 需要系统 C 库，**编译复杂、构建时间长** |
| SFTP | `russh-sftp`（客户端 + 服务端） | ssh2 自带 |
| 背书 | **微软有 `vscode-russh` fork** | Rust 核心项目成员开发 |

选 russh 的理由：纯 Rust 意味着交叉编译和 Windows 构建简单得多，
不用为了一个 C 库折腾 MSVC 工具链。微软在 VS Code 上 fork 它，说明生产可用。

**注意**：产品文档 §5 要求多级跳板、三种隧道、代理（HTTP/SOCKS4/SOCKS5）——
这些 russh 都要自己在上面搭一层，不是开箱即用。

---

## 6. 数据库

### 驱动选 `sqlx`

纯 Rust 实现 MySQL 和 PostgreSQL 驱动，零 unsafe。

**已知短板**：不支持 query pipelining（tokio-postgres 和 diesel-async 支持），
有性能 issue #2436 反映比 tokio-postgres 慢。

**但对我们不是问题**：我们不是高并发服务端，是桌面客户端。
瓶颈在「结构加载」和「大结果集分页」，不在单条查询的极限吞吐。

### 「结构解析不卡」怎么做（产品文档 §2③ 的硬要求）

DataGrip 卡死的原因是**一次性同步加载全部元数据**。我们的做法：

| 策略 | 说明 |
|---|---|
| **懒加载** | 只加载当前展开的那一层。点开库才查表，点开表才查列 |
| **并发拉取** | 同一层的多个对象并发查，不串行 |
| **先出树后填详情** | 表名列表先出来（一条查询），行数/大小等慢字段后台补 |
| **可取消** | 刷新时能随时取消，不锁界面 |
| **落盘缓存** | 结构存本地，下次连上先用缓存渲染，后台比对更新 |

最后一条同时解决产品文档 §8 的「结构没加载完也要有补全」——
**补全读的是本地缓存，不是实时查询**。

---

## 7. 本地存储（补全 + 操作日志）

### 选 SQLite

产品文档 §12 要求操作日志「扛住几年、几十万条不变慢」，§8 要求补全「绝不卡」。

| 用途 | 做法 |
|---|---|
| 操作日志 | SQLite 表，按时间和主机建索引 |
| 补全候选 | 从操作日志派生的排序表（频率 × 新近度 × 目录 × 主机） |
| 数据库结构缓存 | 按连接存一份，用于秒出补全 |
| 前缀匹配 | 内存里维护一棵**前缀树（Trie）**，启动时从 SQLite 加载，增量更新 |

> 名词澄清：之前提到的 **LSM-Tree** 是 RocksDB / LevelDB 的存储结构，
> 和补全查找不是一回事（LSTM 则是神经网络，无关）。
> 补全查找要的是**前缀树 Trie** —— 输入 `git ch` 秒出所有 `git ch*` 的候选。

**「绝不卡」的实现原则**：查询走内存里的 Trie（微秒级），
SQLite 只在后台线程读写，**主线程永远不碰磁盘**。

---

## 8. 进程隔离（产品文档 §2④ 硬条件）

### 架构

```
┌─────────────────┐        ┌──────────────────────────┐
│  主进程（UI）    │ ◄────► │  每个 Tab 一个子进程       │
│  渲染 / 交互     │  IPC   │  PTY / SSH / DB 连接      │
│  连接树 / 设置   │        │  scrollback / 结果集      │
└─────────────────┘        └──────────────────────────┘
```

| 好处 | 说明 |
|---|---|
| 一个 Tab 崩了不影响别的 | 子进程挂了主进程只是收到断开事件 |
| 界面崩了会话不断 | 子进程还活着，重开 UI 重新接上 |
| 更新重启不断会话 | 同上 |

**代价**：内存翻倍（用户已明确表示不管）、IPC 有开销、调试更麻烦。

### 要注意的
渲染必须在主进程（GPU 上下文不好跨进程共享），所以子进程传的是**终端 Grid 的变化**，
不是像素。这一层的 IPC 协议设计要早定，改起来很痛。

---

## 9. 主题与字体

| 需求 | 做法 |
|---|---|
| 兼容 iTerm2 配色 | 解析 `.itermcolors`（plist 格式，含 16 色 + 前景/背景/光标/选中）。网上 325+ 套现成 |
| 提示符 | **不做**，交给 oh-my-zsh |
| oh-my-zsh 检测 | 读 `~/.zshrc` 的 `ZSH_THEME`，命中 agnoster / powerlevel10k 时提示装 Nerd Font |
| 中文字体单独设 | cosmic-text 的字体回退链支持按字符范围指定 |
| 字体不发虚 | 伽马校正 + 正确的子像素处理，见 §4 |

---

## 8b. Tab 拖出成窗口 / 拖回去

### egui 多窗口：必须用「延迟视口」

egui 0.24 起有 viewport API，eframe 原生端支持多窗口。两种模式：

| 模式 | 重绘行为 | 通信 | 用不用 |
|---|---|---|---|
| **延迟视口**（deferred） | **各窗口独立重绘** | channel / Arc-Mutex，稍麻烦 | ✅ 用这个 |
| 即时视口（immediate） | 父窗口重绘时子窗口跟着重绘，反之亦然 | 简单 | ❌ 一个窗口刷日志会拖着所有窗口重绘 |

延迟视口"通信麻烦"这个代价对我们等于没有 —— **多进程架构本来就是消息通信**。

### 我们的架构让「拖出去」变简单了

Chrome 式拖出的核心难点是**要把 Tab 状态抽成可序列化的形式**才能跨窗口搬。

而我们「一个 Tab 一个进程」：会话、PTY、scrollback 全在独立进程，窗口只是渲染端。
**搬 Tab = 换个窗口连那个进程，状态一个字节都不用序列化。**
这是进程隔离架构的意外红利。

### 难度分级

| 能力 | 难度 | 要处理什么 |
|---|---|---|
| 拖出成新窗口 | 中 | 拖拽阈值防误触；**Windows 上要用 DWM Cloak 建窗口否则会闪一下** |
| **拖回 / 拖到另一个窗口的 Tab 栏** | **高** | winit 不提供跨窗口命中测试，要自己用窗口位置 + 鼠标位置算；还要做 ghost tab 提示、拖动中窗口半透明 |
| 窗口间同步（主题/设置变更） | 中 | 多窗口都要跟着变 |

### 建议的分步

1. **先做**：拖出成新窗口 + 右键 Tab「移动到窗口 X」（简易版拖回）
2. **后做**：完整的 Chrome 式跨窗口拖放（ghost tab + 半透明反馈）

> 这块是最容易出平台差异 bug 的地方之一，Windows 和 macOS 的窗口行为差别大。
> 建议单独排一个验证。

---

## 9b. 国际化与授权口子

### 国际化（客户在国内也在国外）

V1 要中英双语。技术上不难，但**必须一开始就做，事后补会漏**：

| 做法 | 说明 |
|---|---|
| 文案全部走语言文件 | 代码里不出现任何面向用户的字符串字面量 |
| 用编译期检查的方案 | 少一条翻译要在构建时报错，不能等到运行时才发现 |
| 布局按最长语言排 | 英文通常比中文长 30-50%，控件宽度不能按中文写死 |
| 错误提示也进语言文件 | 最容易漏，但用户最需要看懂 |
| 字体覆盖中英文 | 见 §9 |

### 授权检查口子

产品文档说 V1 可能有部分功能收费。所以这个口子**不是空壳**：

```
功能执行前 → 授权检查（功能标识）→ 放行 / 拒绝
                    ↓
        V1：永远放行，但调用链真实存在
        以后：读配置决定，不改功能代码
```

**关键是 V1 就真的调用它**，只是永远返回放行。
如果只是"留个 TODO 以后插进来"，等真要限制的时候还是得把所有功能翻一遍。

被拒绝时的界面行为也要现在定：**功能显示为不可用 + 说明原因**，
不是点了没反应，也不是弹个报错。

---

## 10. 插件（V1 不做，方向已定）

| 决定 | 理由 |
|---|---|
| 进程外，stdio + JSON-RPC 2.0 | **和 MCP 完全同构**（MCP 就是 JSON-RPC 2.0 over stdio，官方主力 SDK 是 TypeScript），以后接 AI 生态几乎免费 |
| 主推 JS，但不绑死语言 | 进程外通信天然语言无关 |
| Node 运行时默认内置 | 版本可控；且 Claude Code / Codex 等 AI CLI 都是 Node 写的，这个运行时本身就是产品能力 |
| Lua 先不做 | 两套脚本语言 = 两套 API + 两倍 bug |

---

## 11. 排期现实（需要你知情）

你之前定的是 1 个月 beta、2 个月 1.0，那时需求还只有「终端 + SSH + AI」。
需求收完之后，V1 实际包含：

> 终端（4 种 shell、分屏、拖出窗口、代理、Tab 多行）· 连接树（标签/颜色/分组/排序/5 种导入）·
> 数据库（查询、输出区、改单元格、结构树、补全、**可视化建表**、5 种复制导出、dump 导入导出、库信息、危险操作确认）·
> 文件管理 · 服务器信息面板 · 自动补全（命令 + SQL、本地 + 远程）· 操作日志 ·
> **一个 Tab 一个进程** · 统一皮肤 + iTerm2 导入 + 字体渲染 · **快捷键管理器 + 6 套预设**

**按 1-2 人算，这个范围更接近 6-9 个月，不是 2 个月。**
UI 面积是主要成本：可视化建表、快捷键管理器、6 个分组的连接表单、主题设置，
在 egui 这种即时模式框架里没有现成控件，每一个都要手搓。

**这不是要你改目标，是让你知道排期紧张时该砍什么。** 建议的取舍：

| 阶段 | 内容 |
|---|---|
| **第 1 个月** | 风险验证（ConPTY / IME / 字体）+ 终端 + 连接树 + SSH + 主题 |
| **第 2 个月** | 数据库查询 + 结果网格 + 补全 + 操作日志 → **这时候可以叫 beta** |
| **第 3-4 个月** | 文件管理 + 服务器信息 + dump 导入导出 + 可视化建表 + 快捷键管理器 → **1.0** |

**绝不能砍**：ConPTY 验证、IME 验证、一个 Tab 一个进程、补全不卡。
前两个砍了会返工，后两个砍了产品没有存在理由。

---

## 12. 第 1 周要做的三件事

| # | 验证什么 | 通过标准 |
|---|---|---|
| 1 | **Windows ConPTY** | `cat` 大文件不卡、`Ctrl+C` 能断、resize 无残留、四种 shell 都能起 |
| 2 | **中文输入法** | 微软拼音 + 搜狗，在终端和文本框里候选框位置正确、上屏正常、退格正常 |
| 3 | **字体渲染** | 亮/暗主题字重观感一致、中英混排中文不糊、125%/150%/200% 缩放清晰 |

**这三件事任何一件不通过，都要在动手写业务代码前先解决。**

---

## 参考

- [alacritty_terminal](https://crates.io/crates/alacritty_terminal) · [vte](https://crates.io/crates/vte)
- [portable-pty ConPTY 补丁说明](https://lib.rs/crates/portable-pty-psmux) · [winpty-rs](https://github.com/andfoy/winpty-rs)
- [russh](https://github.com/Eugeny/russh) · [microsoft/vscode-russh](https://github.com/microsoft/vscode-russh)
- [glyphon](https://github.com/grovesNL/glyphon)
- [egui](https://github.com/emilk/egui) · [egui IME 支持 issue #248](https://github.com/emilk/egui/issues/248) · [CJK 支持 issue #3060](https://github.com/emilk/egui/issues/3060) · [Linux IME 失效 #5544](https://github.com/emilk/egui/issues/5544)
- [egui_extras TableBuilder](https://docs.rs/egui_extras/latest/egui_extras/struct.TableBuilder.html) · [egui_deferred_table](https://lib.rs/crates/egui_deferred_table) · [egui_virtual_list](https://lib.rs/crates/egui_virtual_list)
- [winit IME 事件](https://docs.rs/winit/latest/winit/event/enum.Ime.html)
- [iTerm2 Metal Renderer Wiki](https://gitlab.com/gnachman/iterm2/-/wikis/Metal-Renderer) · [iTermMetalDriver.m](https://github.com/gnachman/iTerm2/blob/master/sources/Metal/iTermMetalDriver.m)
- [Windows Terminal Atlas Engine](https://deepwiki.com/microsoft/terminal/3.2-atlas-engine)
- [sqlx](https://github.com/launchbadge/sqlx) · [sqlx 性能 issue #2436](https://github.com/launchbadge/sqlx/issues/2436)
- [Tauri / iced / egui 性能对比](http://lukaskalbertodt.github.io/2023/02/03/tauri-iced-egui-performance-comparison.html) · [2025 Rust GUI 库综述](https://www.boringcactus.com/2025/04/13/2025-survey-of-rust-gui-libraries.html)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [MCP 传输层](https://modelcontextprotocol.info/docs/concepts/transports/)
