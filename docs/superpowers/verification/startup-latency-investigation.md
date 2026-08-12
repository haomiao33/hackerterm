# 冷启动 80/160 秒排查记录（Win11, i7-1260P）

> 状态：**根因未最终确认**。已排除 5 个假设，锁定一条强线索。
> 本文档记录全部实测数据与已排除项，避免重复排查。

## 现象

打包后的应用在真机上冷启动需要 50–160 秒才能使用。开发容器与 CI 均无法复现。

**关键对照：应用内「强制重载」页面只需 200ms**（同一进程，不新建子进程）。

## 五次实测数据

时间轴统一换算到渲染进程日志的 `+Xms` 轴。

| # | 参数 | `fork_call→core_spawn` | `did_finish_load` | 比值 |
|---|---|---|---|---|
| 1 | 无 | 48.7s | 50.0s | 1.03× |
| 2 | 无 | 80.5s | 160.9s | **2.00×** |
| 3 | `--disable-gpu` | 81.1s | 122.3s | 1.51× |
| 4 | `--enable-logging --v=1` | 80.7s | 160.2s | **1.99×** |
| 5 | `--disable-features=UseEcoQoSForBackgroundProcess` | 81.1s | 161.2s | **1.99×** |

**恒定量：`fork→spawn` 四次落在 80.5–81.1s 区间。**
**倍数关系：`did_finish_load` 三次恰为其 2.00 倍。**

随机性的环境干扰（云查杀超时、CPU 降频、网络超时）不会产生这种量化规整的数字。
指向**一个固定成本的操作被串行执行了两次**。

## 我们自己的代码从来不是瓶颈

同一份日志里，核心链路全部在毫秒级：

| 环节 | 耗时 |
|---|---|
| ht-node 原生模块加载 | **11–18ms** |
| 协议握手 | 9–29ms |
| `session.open` | 65–75ms |
| 数据端口就绪 | 7–15ms |
| WebGL 挂载 | 275–645ms |
| 键盘往返（真机实测） | 14–20ms |

## 已排除的假设（附排除依据）

| # | 假设 | 排除依据 |
|---|---|---|
| 1 | Defender 首次访问扫描 | 第二次启动**更慢**（50s→161s），缓存过的扫描不可能更慢 |
| 2 | Mark-of-the-Web / Block at First Sight | 对整个目录跑 `Unblock-File` 后无变化 |
| 3 | 代理 / WPAD / PAC 超时 | 用户关闭代理无变化；`--enable-logging` 日志中无任何代理解析卡顿 |
| 4 | GPU 初始化卡死 | `--disable-gpu` 后 `fork→spawn` 仍为 81.1s |
| 5 | Windows 11 EcoQoS 把进程赶到 E 核 | `--disable-features=UseEcoQoSForBackgroundProcess` 后仍为 81.1s；任务管理器确认「电源节流 = 已禁用」 |

补充事实：
- CPU 为 i7-1260P（4 P 核 + 8 E 核，混合架构），`% Processor Performance` 空闲时 68–79%，
  `CurrentClockSpeed` 满速 2100MHz，**机器本身未被限速**。
- Chromium 日志里 `MSPL::OnSpeedLimitChange` 报 10–21（满值 100）。经查
  `base/power_monitor/power_observer.h`，该值含义是「操作系统通告的 CPU 速度上限百分比」。
  在混合架构上该估算会因工作被调度到 E 核而偏低，**不能直接当作全机降频的证据**。
- 安全软件只有 Windows Defender，无第三方（已用 `root/SecurityCenter2` 确认）。
- 任务管理器观察到的「已挂起」进程状态是 **Chromium 沙箱的正常启动流程**
  （子进程先挂起创建、设好沙箱限制再恢复），不是故障。

## 当前最强线索

Electron 主二进制 `electron.exe` 体积约 150–180MB，**Chromium 的每个子进程都是重新
启动这同一个 exe**。若安全软件在每次进程创建时对该文件做完整深度扫描，单次耗时正好
落在一分多钟量级，且**因文件大小恒定而每次耗时一致**——这同时解释了「81 秒恒定」
「两倍关系（两次进程创建）」「强制重载只要 200ms（不创建新进程）」三件事。

**待验证**：`Add-MpPreference -ExclusionPath <应用目录>` 后重启测试。

**若确认，根治手段是代码签名**——签名后的可执行文件带可信发布者身份，不会每次深度扫描。
这从「合规要求」升级为「性能刚需」，必须进 V1 发布前的必做项。

## 与根因无关、必须修的自伤

不论上述根因是什么，下面这段是我们自己浪费的：

```
+81294ms  core-host:ht_node_import_end   ← 核心完全就绪
+161224ms main:did_finish_load
+161249ms control port ready             ← 才连上
```

**核心就绪后又空等了 79.9 秒**，因为 `src/main/index.ts` 把控制端口的发送挂在
`did-finish-load`（页面 `load` 事件）上。而渲染进程在 **+0ms** 就已执行完脚本并挂好了
`message` 监听器——**两边都准备好了，是我们没把它们接起来**。

官方文档 `docs/tutorial/message-ports.md` 的标准模式是**由渲染进程主动请求通道**
（`ipc.on('request-worker-channel', ...)`）。讽刺的是本项目的**数据端口本来就是这么做的**
（`window.ht.openDataPort`），唯独控制端口不是。

用户的「强制重载」实验已经反证了这个修复必然有效：重载后核心早已存在
（`core_spawn: -192144ms`），控制端口 **180ms** 就接上了。

修复后即使根因未解，**冷启动时间直接砍掉一半**。见任务 #21。
