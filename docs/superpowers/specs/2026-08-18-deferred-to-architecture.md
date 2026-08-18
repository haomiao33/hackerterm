# 搁置到整体设计阶段的问题登记

> 状态：登记簿，不是设计文档。
> 触发：用户 2026-08-18 明确当前阶段定位——
> 「目前的完整的目标是做丝滑和并发和可行性测试，还没开发呢」
> 「目前只是一个 demo 测测看看效果。如果可以就再开始做架构」
> 「把搁着的问题记录到文档，后续我们做整体设计再来看」
>
> **本文档的价值不在于列任务，而在于存住每一条已经查清的事实**——
> 整体设计时直接用，不要重查。凡是推断而非实测的地方都已标注。

## 0. 当前阶段的判定标准

`m0-risk-spike` 分支只回答三个问题：**丝滑、并发、可行**。
一件事进不进 demo，判据只有一条：**它能不能改变「这条路走不走得通」的答案**。
不能改变的，一律登记到本文档，等整体设计。

---

## 1. 进程模型（架构阶段的第一决策）

**用户已拍板，不再讨论粒度**：一个 tab 一个进程，SSH 会话单独一个进程。
用户 2026-08-18 原话：「一个tab一个进程，不能卡其他tab，要丝滑。一个终端里面
运行了 ssh，这个地方要好好处理，应该是 ssh 单独的」。这是第二次重申——
早期已说过「可以使用一个tab一个进程」「不用管内存」。

### 现状与目标的差距（2026-08-18 读码实测）

| | 现状 | 目标 |
|---|---|---|
| core-host | **只有 1 个** utility 进程带全部会话（`src/main/index.ts:26`） | 每 tab 一个 |
| 窗口 | **只有 1 个** BrowserWindow（`src/main/index.ts:36`），tab 概念未实现 | 多 tab |
| 会话隔离 | 每会话一个 Rust 读线程（**线程不是进程**） | 进程级 |

### 设计时必须记住的一条

**进程隔离不能替代异步化。** 调用一旦是阻塞的，每 tab 一进程只是把冻结范围缩小到
那一个 tab——而那个 tab 恰恰是用户刚点开、正在盯着的那个。反过来，调用异步了，
一个进程带 100 个会话也不卡。

进程边界真正买到的是**崩溃隔离**和**内存隔离**，不是流畅。两件事分开决策。

### 业内对照（读过源码，非常识，别再重查）

VS Code `src/vs/platform/terminal/node/ptyService.ts:100` 是
`_ptys: Map<number, PersistentTerminalProcess>`——**一个 ptyHost 进程带全部终端**。
它不靠加进程，靠四样东西：

1. 接口**全 async**（`createProcess` 是 `async`，永不占住线程）
2. **心跳看门狗**，`HeartbeatConstants`（`common/terminal.ts:461`）：
   `BeatInterval = 5000`、`ConnectingBeatInterval = 20000`（启动期放宽以迁就慢机器）、
   `FirstWaitMultiplier = 1.2`，**两级超时后才告诉用户——第二级存在的唯一理由是
   避免电脑从睡眠唤醒时误报**
3. `createProcess` **单独挂一个** `CreateProcessTimeout`（`ptyHostService.ts:212`）
4. `restartPtyHost()` + `MaxRestarts` **自动重启**

**我们的粒度选择与 VS Code 不同，那是基于崩溃隔离的产品判断；但上面这四样跟
进程粒度正交，照样要抄。**

---

## 2. SSH 层（核心场景，设计已写，未实现）

设计文档：`docs/superpowers/specs/2026-08-17-hackerterm-ssh-design.md`
（分支 `ssh-design`，提交 `bf20f6f`，**尚未推送**）。

用户定性：「ssh 是核心场景，基本上终端都是连接 ssh 的」。

### 已从 russh 源码查清、整体设计时直接用的两条

**(a) russh 的窗口补充与消费解耦——我们的背压传不到远端。**
`adjust_window_size` 在 `sender_window_size < target/2` 时立刻补满窗口，
**由「收到多少字节」驱动，与消费方处理没处理完毫无关系**。
本地 PTY 那套「渲染层 ack → Rust 暂停读 → 子进程被内核阻塞」的链条，
到 SSH 上**断了**：我们暂停消费，远端照发。数据只能堆在 russh 内部缓冲。

> 待验证：`adjust_window_size` 的**调用点**还没读到（不在 `channels/mod.rs`、
> `session.rs`、`client/mod.rs` 里，推测在 `lib_inner.rs` 的收包路径）。
> 实现前必须读到，确认：是否每收一个 `CHANNEL_DATA` 就无条件调用；
> russh 递给消费者用的是有界还是无界通道；`Config::window_size` 默认值。
> **在读到之前，上面的后果分析属于推断。**

**(b) 窗口耗尽时发送端无限期挂起。**
`reserve_writable_chunk` 在窗口为 0 时 `notified().await`，**没有超时**。
远端若永不发 `WINDOW_ADJUST`（网络黑洞、远端卡死、中间设备吞包），
写操作永久挂起且不报错。**这与我们刚修的「ack 丢失导致终端永久冻结」是同一类故障。**
本地那次的解法是停摆看门狗：超时后强制清零 **+ 上报事件**（绝不静默自愈）。
SSH 这边需要等价物，且必须能区分「远端真的很慢」和「通路已死」。

### 需要用户拍板的（整体设计时问）

- 主机密钥校验策略：首次自动信任（体验好）vs 严格校验（安全）
- 是否支持 agent 转发
- SFTP 是否进 V1
- 重连语义：纯 SSH **不能**恢复原会话（远端进程随连接死）。
  建议 V1 明确「重连 = 新会话，滚动内容保留在本地但远端上下文丢失」，
  **不要给用户虚假承诺**。

---

## 3. 日志子系统（设计已写，实施推迟到 V1）

设计文档：`docs/superpowers/specs/2026-08-12-hackerterm-logging.md`（已提交 `7bef5cd`）。
搁置理由：属于产品功能，不改变可行性结论。

**两条红线，实施时不许妥协**（这是文档的核心价值，别只记住轮转参数）：

1. **载荷内容永不入文件日志。** 终端内容里有密码——用户会敲 `mysql -p<密码>`、
   会在 `sudo` 提示后输入、会粘贴 API key 和私钥。把 PTY 载荷写进日志文件，
   等于在用户硬盘上生成一个明文凭据库。
   现有 `src/ui/browser/diagnostics/byte-throttle.ts` 的 `createOnDataLogger` 打的是
   按键内容十六进制预览——**M0 排障期可以（只进 console、用户本人在场），
   但绝不能跟着文件日志发布**。实施时必须让「内容级诊断」与「文件日志」在**类型上**
   就分开，不能靠约定。
2. **级别判断必须发生在消息构造之前。** JS 里 `log(\`收到 ${n} 字节\`)` 的模板字符串
   在函数调用前就求值完了，级别判断救不了它。数据面刷屏时每秒几千条。

架构选择：**每进程写自己的文件，不汇总**。理由是失败模式——
**最需要的日志恰恰是崩溃时那些**，若经核心进程转发，核心一挂就全部丢失。

---

## 4. Linux 发行阻塞：portable-pty 与 Electron 的 fd 归属检查冲突

`portable_pty::unix::close_random_fds` 会调 `close(fd)`，而 Electron 覆写了 `close()`
做 fd 归属强制检查，直接 `IMMEDIATE_CRASH`。**没有开关可以关掉这个检查。**

搁置理由：demo 在 Windows 上验证可行性；但这是 **Linux 发行的硬阻塞**，
整体设计时必须解决（改用别的 PTY 实现、或绕过 `close_random_fds`、或自己 fork）。

---

## 5. 代码签名（发版硬阻塞）

用户 2026-08 说过「签名这个先不管」。

但要记住那个实测数字：**未签名包在装了杀软的真机上冷启动 80 秒**
（`main:fork_call → main:core_spawn` 恒定 80.5–81.1s），关掉杀软后 **504ms**。
详见 `docs/superpowers/verification/startup-latency-investigation.md`。

**这不是性能问题，是发版问题。** 整体设计排期时按「发版必须项」对待。

---

## 6. ConPTY 那两条（已降级，对核心场景不适用）

- **#31 开启 `PSEUDOCONSOLE_PASSTHROUGH_MODE`**（`0x8`，Win11 22H2+ / build ≥ 22621）：
  portable-pty 里已定义但标着 `#[allow(dead_code)]`，从没传过。
  **microsoft/terminal#1985 明确说它「would not work for cmd.exe or Windows PowerShell
  due to their heavy API dependencies」**——所以对 PowerShell 无效。
- **#32 随包分发 ConPTY redistributable**：`OpenConsole.exe` + `conpty.dll`
  **必须成对更新**；portable-pty 的 `load_conpty()` 已经优先用旁加载的 `conpty.dll`。

**两条都只对「本地 shell」有意义。SSH 会话不经过本地 ConPTY**——字节从网络来。
既然 SSH 是核心场景，这两条的优先级应当低于任何 SSH 相关工作。

---

## 7. 整体设计阶段开工前要先答的问题

1. 上面第 2 节的 russh `adjust_window_size` 调用点——**必须读到源码才能定背压方案**
2. 多路复用（一条 TCP 多通道）vs 每会话一条连接——**取决于能否让每条通道独立背压**，
   做不到就宁可退回每会话一条连接，**慢一点好过全部一起卡死**
3. 用户需要决定的两件环境事：自托管 runner 要不要开回 Defender（否则真机启动
   耗时不反映真实用户）、要不要从服务模式（Session 0）改成交互式登录
   （否则 GPU / 多显示器 / DPI 全都测不了）
