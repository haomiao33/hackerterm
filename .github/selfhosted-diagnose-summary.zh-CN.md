<!--
  这份文件是 .github/workflows/build.yml 里 selfhosted-diagnose 这个 job 的
  **中文文案表**，由该 job 的「写入运行摘要」步骤读取后拼成 $GITHUB_STEP_SUMMARY。

  ── 为什么中文要单独放一个文件，而不是写在 PowerShell 脚本里 ──────────────
  GitHub runner 把 workflow 里的 `run:` 内联脚本落成一个临时 .ps1 文件（UTF-8 无
  BOM），而**中文 Windows 上的 Windows PowerShell 5.1 是按系统 ANSI 代码页（GBK）
  读脚本文件的**。UTF-8 的中文字节被当 GBK 解，轻则乱码，重则解出能撑破引号的
  字节，让整个脚本解析失败（真机上就是这么炸的：`The string is missing the
  terminator: ".`，PATH 修正步骤没跑，后面全部 skipped，job 直接红）。

  注意这跟"输出编码"是两件事：往 $GITHUB_STEP_SUMMARY 写的时候用
  [System.IO.File]::AppendAllText(..., UTF8Encoding($false)) 已经处理好了；
  **脚本文件自身被读取时的编码**是另一回事，PowerShell 不给你选。

  所以规矩是：**脚本里一个非 ASCII 字符都不许有**（注释和字符串字面量都算），
  中文一律放这里，由脚本用 [System.IO.File]::ReadAllLines($p, UTF8Encoding)
  **显式按 UTF-8 解码**读进去——显式指定编码的读取跟系统区域设置无关。

  ── 编辑须知 ──────────────────────────────────────────────────────────
  * 本文件必须存成 **UTF-8 无 BOM**。
  * 三个分区标记必须独占一行、逐字匹配：`=== labels ===` / `=== values ===`
    / `=== body ===`。标记之前的内容（比如这段注释）会被忽略。
  * labels / values 两个分区每行是 `键<TAB>中文`，用**真正的制表符**分隔。
  * body 分区里的 {{FACTS_TABLE}} / {{STARTUP_TIMELINE}} 必须**独占一行**
    （会被整块替换成多行）；{{OUTCOME_*}} 是行内替换。
  * 加了新的 Add-Fact 键却忘了在 labels 里加中文标签，不会炸——表格里会退化成
    显示原始英文键名。宁可退化也不要让摘要步骤失败。
-->

=== labels ===
probe_ps_version	PowerShell 版本
probe_ps_edition	PowerShell 版本类型
probe_ps_host	PowerShell 宿主
probe_console_output_encoding	[Console]::OutputEncoding（控制台输出编码）
probe_console_input_encoding	[Console]::InputEncoding（控制台输入编码）
probe_output_encoding_var	$OutputEncoding（管道给原生命令的编码）
probe_ansi_codepage	**系统 ANSI 代码页 —— 5.1 就是用它读脚本文件的**
probe_chcp	chcp（当前控制台代码页）
probe_culture	区域设置 (CurrentCulture)
probe_ui_culture	界面语言 (CurrentUICulture)
pathfix_bash_before	修正前 `bash` 解析到
pathfix_git_before	修正前 `git` 解析到
pathfix_candidates	Git 安装候选
pathfix_rejected	被否决的候选
pathfix_chosen	选中的 Git 安装
pathfix_prepended	已前置到 PATH
whoami	运行账户
machine	机器名
session_id	会话 ID（0 = 服务会话，无交互桌面）
user_interactive	是否交互式
os	操作系统
cpu	CPU
cores	逻辑核数
ram_gb	内存 (GB)
window_station	窗口站
desktop	桌面
video_controllers	显卡
desktop_monitors	枚举到的显示器数
defender_service	WinDefend 服务状态
defender_realtime	Defender 实时保护
defender_engine	Defender 引擎版本
defender_exclusions	Defender 排除路径
workspace	工作目录
ps_version	PowerShell 版本（诊断步骤实测）
ps_edition	PowerShell 版本类型（诊断步骤实测）
pwsh_available	pwsh（PowerShell 7）
bash_available	bash

=== values ===
@none@	（无）
@none-confirmed@	（无，已确认查询成功）
@query-failed@	查询失败：
@unavailable@	未获取到：
@defender-unavailable@	未获取到（Defender 未运行，或 NETWORK SERVICE 没权限）：
@no-pwsh@	（没有装 PowerShell 7）
@no-bash@	（没有 bash）
@not-found@	（没找到）
@rejected-no-bash-exe@	否决（没有 bin\bash.exe）：
@rejected-probe-failed@	否决（bash 跑不通，实测输出见后）：
@facts-missing@	事实采集步骤没有产出文件（它自己失败了，看 job 日志）
@startup-missing@	未产出。测量步骤失败了，看上面的 job 日志。
@chosen-none@	**没有找到任何能跑通的 Git for Windows bash**——后面凡是内部写死 `shell: bash` 的第三方 action 都会命中 WSL 的 `C:\Windows\System32\bash.exe` 并失败。解决办法：在这台机器上装 Git for Windows。

=== body ===
## 自托管 runner 环境诊断

这个 job 不测代码，测的是**跑它的那台机器**：它到底能替我们验证什么。

> 摘要里的中文来自仓库里的 `.github/selfhosted-diagnose-summary.zh-CN.md`，
> 由步骤显式按 UTF-8 读入。PowerShell 脚本本身保持纯 ASCII——中文 Windows 的
> PowerShell 5.1 按 GBK 读脚本文件，脚本里带中文会被解成乱码并撑破语法。

### 一、运行身份与会话

| 项 | 值 |
| --- | --- |
{{FACTS_TABLE}}

### 二、各步骤结果

| 步骤 | 结果 | 说明 |
| --- | --- | --- |
| build:native (napi-rs) | {{OUTCOME_BUILD_NATIVE}} | Rust 原生模块能不能在这台机器上编出来 |
| build (electron-vite) | {{OUTCOME_BUILD_APP}} | |
| 冷启动时间线 | {{OUTCOME_STARTUP}} | 详见下面第三节 |
| E2E 冒烟 | {{OUTCOME_SMOKE}} | **Electron 能不能在 Session 0 里真的起来并跑完键盘→PTY→屏幕** |

### 三、真实冷启动耗时

{{STARTUP_TIMELINE}}

### 四、哪些结论可信、哪些不可信

这台 runner 装成了 **Windows 服务**，账户是 `NT AUTHORITY\NETWORK SERVICE`，
因此跑在 **Session 0**——没有交互式桌面会话，也不是用户自己的账户。
这直接决定了上面哪些数字能外推到"用户双击图标时的体验"：

| 项 | 可信度 | 为什么 |
| --- | --- | --- |
| Electron 能否启动 / 冒烟能否跑通 | ✅ **可信** | Playwright 经 CDP 驱动页面（`Input.dispatchKeyEvent`），不需要可见桌面或窗口焦点，Session 0 不影响。跑通即证明这条路可用 |
| 原生模块编译、依赖安装 | ✅ **可信** | 纯文件与编译器操作，跟会话无关 |
| 冷启动**分段结构**（哪一段占大头） | 🟡 **参考** | 同一台机器上的趋势有意义，可以用来发现"某一段忽然涨了" |
| 冷启动**绝对毫秒数** | ❌ **不可外推到用户真机** | 三个原因：① Defender 的实时扫描策略按**账户/路径**生效，NETWORK SERVICE 与用户账户不同；② 这里跑的是 CI 工作目录里**现编出来的**文件，而用户跑的是从浏览器下载、带 Mark-of-the-Web 的 zip 解压产物——后者才是当初触发 81 秒扫描的那种文件；③ 没有桌面合成器参与 |
| GPU 特性状态 | ❌ **不可信** | Session 0 没有可见桌面、通常也枚举不到显示器，Chromium 必然落到软件渲染。用户真机是双显示器 + 真显卡，两者没有可比性 |
| 窗口/焦点/DPI/字体渲染相关的一切 | ❌ **不可信** | 非交互式窗口站上根本没有这些东西 |
| 多显示器相关行为 | ❌ **测不了** | 见上 |

**要拿到真正代表用户体验的冷启动数字，只有一条路**：在用户自己的桌面会话里、
用从 Actions 下载下来的 zip 解压后的产物跑一次。把 runner 改成以用户账户登录
运行（而不是服务）可以让上面的 🟡/❌ 变成 ✅，但那要求笔记本保持登录状态。
