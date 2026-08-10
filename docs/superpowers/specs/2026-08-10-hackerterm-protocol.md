# HackerTerm 核心协议

> 日期：2026-08-10 · 配套：产品设计 / 技术方案两份文档
> **这是 Rust 核心与外壳之间唯一的契约。定成语言无关的消息协议，不是 napi 函数签名。**

---

## 1. 设计原则

| 原则 | 说明 |
|---|---|
| **语言无关** | 协议里不出现任何 Node / napi / JS 概念。napi 只是当前宿主的传输实现之一 |
| **外壳可换** | 换 Tauri、换原生、换 Web 版，**Rust 核心和本协议一行不改** |
| **可演进** | 握手协商 major/minor + 能力集（§7）；字段只增不改不复用；未知字段/方法/事件一律安全忽略 |
| **控制面与数据面分离** | 控制消息走 schema 编码，大数据走裸二进制，两者永不混在一起 |
| **错误不带成品文案** | 传本地化 key + 参数，**渲染层负责翻译**（i18n 在渲染层） |
| **凭据不出核心** | 明文凭据**永远不进入渲染进程**，只在 Rust 内部使用 |

---

## 2. 传输分层

```
┌─────────────────────────────────────────────────────────┐
│  渲染进程（一个 Tab 一个）                                │
└──────┬────────────────────────────────┬─────────────────┘
       │ 控制通道                        │ 数据通道
       │ MessagePort · Protobuf 编码     │ MessagePort · 裸二进制
       │ 低频、有 schema、要演进          │ 高频/大块、无 schema
┌──────▼────────────────────────────────▼─────────────────┐
│  Rust 核心（utility process）                            │
└─────────────────────────────────────────────────────────┘
```

### 两类通道

| | 控制通道 | 数据通道 |
|---|---|---|
| 用途 | 打开会话、执行 SQL、改配置、查补全… | 终端字节流、数据库结果集 |
| 频率 | 低（每秒几十条） | 高（终端）/ 大块（数据库） |
| 编码 | **Protobuf** | **裸 `ArrayBuffer`**（终端）/ **Apache Arrow**（数据库） |
| 为什么 | 需要 schema、跨语言类型生成、向后兼容规则明确 | 序列化就是性能杀手，绝不能有 |

### 通道拓扑

| 通道 | 数量 | 内容 |
|---|---|---|
| **全局控制通道** | 1 条 | 连接树、配置、凭据、授权、操作日志查询 |
| **会话控制通道** | 每个 Tab 1 条 | 该 Tab 的会话控制消息 |
| **会话数据通道** | 每个 Tab 1 条 | 该 Tab 的终端字节 / 结果集 |

主进程只负责把这些 MessagePort 牵好线，**建好之后数据不再经过它**。

> **Rust 核心是全局单实例**（不是每窗口一个）—— 对应 VS Code 的 Shared Process。
> 所有窗口的所有 Tab 都连到同一个核心，因为操作日志、补全索引、连接树、配置
> 以及 SSH 连接复用都要求全局唯一。

### 为什么控制面选 Protobuf

| 候选 | 结论 |
|---|---|
| **Protobuf** | ✅ schema-first、字段编号保证向后兼容、Rust（prost）和 TS 都有成熟实现 |
| JSON | ❌ 无 schema 保证，字段改名不报错，改坏了运行时才发现 |
| MessagePack | ❌ 只是二进制 JSON，同样没有 schema |
| Cap'n Proto / FlatBuffers | ⚪ 零拷贝读很好，但 TS 侧生态不如 protobuf；而且控制面本来就不是性能瓶颈 |

> 注意：**插件协议是另一回事** —— 那边是 stdio + JSON-RPC 2.0（与 MCP 同构），
> 因为它面向第三方，要的是易写而不是极致性能。两个边界，两套编码，互不影响。

---

## 3. 消息信封

三种消息，全部协议共用这一层：

```protobuf
message Envelope {
  oneof kind {
    Request  request  = 1;
    Response response = 2;
    Event    event    = 3;
  }
}

message Request {
  uint64 id     = 1;   // 调用方生成，用于匹配 Response
  string method = 2;   // 如 "session.open"
  bytes  payload = 3;  // 对应方法的请求消息，已编码
}

message Response {
  uint64 id = 1;
  oneof result {
    bytes payload = 2;  // 成功
    Error error   = 3;  // 失败
  }
}

message Event {
  string topic  = 1;   // 如 "session.state"
  bytes  payload = 2;
}
```

**为什么 payload 是 bytes 而不是 oneof 展开**：新增方法不用动信封定义，
旧版本收到不认识的 method 能干净地回 `UNKNOWN_METHOD`，而不是解码失败。

---

## 4. 错误模型

```protobuf
message Error {
  ErrorCode code   = 1;
  string    key    = 2;   // 本地化 key，如 "err.ssh.auth_failed"
  map<string,string> params = 3;  // 填充用的参数，如 {"host":"web-01"}
  string    detail = 4;   // 原始技术细节（英文，给日志和"查看详情"用）
  bool      retryable = 5;
}

enum ErrorCode {
  UNKNOWN            = 0;   // ★ 所有 enum 的 0 值都必须是 UNKNOWN/NONE，见 §7.4
  UNKNOWN_METHOD     = 1;
  INVALID_ARGUMENT   = 2;
  NOT_FOUND          = 3;
  PERMISSION_DENIED  = 4;   // 授权检查未通过
  LOCKED_BY_POLICY   = 5;   // 企业策略锁定（V2）
  CONNECT_FAILED     = 6;
  AUTH_FAILED        = 7;
  TIMEOUT            = 8;
  CANCELLED          = 9;
  REMOTE_ERROR       = 10;  // 数据库/SSH 服务端返回的错误
  INTERNAL           = 11;
}
```

> **关键约束：`key` + `params` 才是给用户看的，`detail` 只给日志和「查看详情」。**
> Rust 核心**绝不返回已翻译的成品文案** —— 翻译是渲染层的事，
> 否则中英双语要在 Rust 里再实现一套 i18n。

---

## 5. 核心域模型

### 5.1 连接与凭据（分离存储）

```protobuf
message Connection {
  string id        = 1;
  ConnKind kind    = 2;      // SSH | DATABASE
  string name      = 3;
  string group_id  = 4;
  repeated string tags = 5;
  string color     = 6;      // 空则继承分组颜色
  int32  order     = 7;      // 手动排序用
  string note      = 8;

  Origin origin    = 9;      // LOCAL | MANAGED（V2 企业下发）
  bool   locked    = 10;     // MANAGED 的不可编辑

  oneof config {
    SshConfig ssh  = 11;
    DbConfig  db   = 12;
  }

  string credential_ref = 13;  // ★ 只有引用，没有明文
}

enum Origin { LOCAL = 0; MANAGED = 1; }
```

> **`credential_ref` 是这个设计的关键。** 连接配置里**永远不含密码或私钥内容**，
> 只有一个引用。明文存在系统钥匙串（V1）或由控制面按需下发（V2），
> **渲染进程拿不到，也不需要拿到** —— 建连接是 Rust 干的。
>
> 产品文档 §17 要求「企业版密码不落到员工电脑上」，靠的就是这条。

```protobuf
message SshConfig {
  string host = 1;  uint32 port = 2;  string user = 3;
  AuthMethod auth = 4;              // PASSWORD | KEY_FILE | AGENT | KEYBOARD_INTERACTIVE
  string key_path = 5;

  repeated string jump_chain = 6;   // 跳板：其它 Connection 的 id，可多级
  repeated Tunnel tunnels    = 7;
  Proxy  proxy      = 8;

  string encoding   = 9;            // UTF-8 / GBK …
  string term_type  = 10;
  string init_command = 11;         // 登录后自动执行
  uint32 keepalive_sec = 12;
  bool   auto_reconnect = 13;
  bool   compression = 14;
  map<string,string> env = 15;
}

message Proxy {
  ProxyMode mode = 1;   // NONE | SYSTEM | CUSTOM
  ProxyKind kind = 2;   // HTTP | SOCKS4 | SOCKS5
  string host = 3;  uint32 port = 4;
  string user = 5;  string credential_ref = 6;
}

message DbConfig {
  DbKind kind = 1;      // MYSQL | POSTGRES
  string host = 2;  uint32 port = 3;  string user = 4;
  string default_db = 5;
  string ssh_tunnel_conn_id = 6;   // 直接复用某个已有 SSH 连接
  Ssl    ssl = 7;
  string charset = 8;  string timezone = 9;
  uint32 connect_timeout_sec = 10;
  bool   read_only = 11;
  map<string,string> params = 12;
}
```

### 5.2 会话

```protobuf
message Session {
  string id      = 1;
  string conn_id = 2;
  SessionKind kind = 3;   // TERMINAL | FILE | DATABASE | SYSINFO
  SessionState state = 4; // CONNECTING | CONNECTED | RECONNECTING | CLOSED | FAILED
}
```

---

## 6. 方法清单

### 6.1 `conn.*` —— 连接与分组

| 方法 | 请求 → 响应 | 说明 |
|---|---|---|
| `conn.list` | `{}` → `{connections[], groups[]}` | 整棵树 |
| `conn.get` | `{id}` → `Connection` | |
| `conn.create` | `Connection` → `{id}` | |
| `conn.update` | `Connection` → `{}` | `origin=MANAGED` 时返回 `LOCKED_BY_POLICY` |
| `conn.delete` | `{id}` → `{}` | 同上 |
| `conn.reorder` | `{id, group_id, order}` → `{}` | 拖拽排序 |
| `conn.import` | `{source, path}` → `{imported[], skipped[]}` | source: XSHELL / FINALSHELL / PUTTY / SSH_CONFIG / MOBAXTERM |
| `conn.group.*` | create / update / delete / reorder | 分组含颜色 |

**事件**：`conn.changed`（V2 控制面下发后推送，V1 也用于多窗口同步）

### 6.2 `cred.*` —— 凭据（明文永不出核心）

| 方法 | 请求 → 响应 |
|---|---|
| `cred.put` | `{ref, secret}` → `{}` |
| `cred.status` | `{ref}` → `{exists: bool}` ← **只回存没存，不回内容** |
| `cred.delete` | `{ref}` → `{}` |

> **协议里没有 `cred.get`。** 明文只在 Rust 内部建连接时使用，
> 不存在任何能把它读到渲染进程的方法。

### 6.3 `session.*` —— 终端会话

| 方法 | 请求 → 响应 | 说明 |
|---|---|---|
| `session.open` | `{conn_id, cols, rows, shell?}` → `{session_id}` | 打开后核心主动建数据通道 |
| `session.resize` | `{session_id, cols, rows}` → `{}` | |
| `session.signal` | `{session_id, signal}` → `{}` | **带外，不排在输出队列后面** |
| `session.close` | `{session_id}` → `{}` | |
| `session.ack` | `{session_id, bytes_consumed}` → `{}` | **流控：渲染层消费多少报多少** |

**数据通道**（不走 Protobuf）：
- 下行：终端字节 → 裸 `ArrayBuffer`，成批发送
- 上行：键盘输入 → 裸 `ArrayBuffer`，**走最短路径，不排队**

**事件**：
| topic | payload |
|---|---|
| `session.state` | `{session_id, state, error?}` |
| `session.exit` | `{session_id, exit_code}` |
| `session.cwd` | `{session_id, cwd}` ← 供「右键终端 → 管理文件」用 |
| `session.title` | `{session_id, title}` |

> **流控约定**：核心维护每个会话的未确认字节数，超过高水位就对 PTY 发 XOFF，
> 收到 `session.ack` 降到低水位再发 XON。**这是「`cat` 大文件不卡」的机制所在。**

### 6.4 `file.*` —— 文件管理

| 方法 | 请求 → 响应 |
|---|---|
| `file.open` | `{conn_id, path?}` → `{file_session_id, cwd}` ← path 为空进 home |
| `file.list` | `{fs_id, path}` → `{entries[]}` |
| `file.mkdir` / `file.rename` / `file.delete` / `file.chmod` / `file.chown` | → `{}` |
| `file.read` | `{fs_id, path, max_bytes}` → 数据通道 |
| `file.write` | `{fs_id, path}` + 数据通道 → `{}` |
| `file.transfer.start` | `{fs_id, direction, src, dst, on_conflict}` → `{transfer_id}` |
| `file.transfer.pause` / `resume` / `cancel` | `{transfer_id}` → `{}` |

`on_conflict`: `ASK | OVERWRITE | SKIP | KEEP_BOTH`
→ `ASK` 时核心发 `file.conflict` 事件，等渲染层回 `file.transfer.resolve`

**事件**：`file.transfer.progress {transfer_id, done, total, bytes_per_sec, eta_sec}`

### 6.5 `db.*` —— 数据库

**结构树（懒加载是硬要求）**

| 方法 | 请求 → 响应 | 说明 |
|---|---|---|
| `db.open` | `{conn_id}` → `{db_session_id}` | |
| `db.schema.children` | `{db_id, node_id?}` → `{nodes[], from_cache}` | **只加载这一层**；`node_id` 为空取顶层 |
| `db.schema.refresh` | `{db_id, node_id}` → `{}` | 后台跑，可取消 |
| `db.schema.cancel` | `{db_id, node_id}` → `{}` | **界面不冻结的前提** |

> `from_cache=true` 表示这批是本地缓存渲染的，核心会在后台比对并发
> `db.schema.updated` 事件。**这条保证「树立刻能展开，不等全部加载完」。**

**查询**

| 方法 | 请求 → 响应 |
|---|---|
| `db.query.exec` | `{db_id, sql, page_size}` → `{query_id}` |
| `db.query.fetch` | `{query_id, offset, limit}` → **Arrow 数据块走数据通道** |
| `db.query.cancel` | `{query_id}` → `{}` |
| `db.tx.set_autocommit` | `{db_id, on}` → `{}` |
| `db.tx.commit` / `rollback` | `{db_id}` → `{}` |

**DDL —— 执行前必须能看到 SQL**

| 方法 | 请求 → 响应 |
|---|---|
| `db.ddl.preview` | `DdlOp` → `{sql}` ← **可视化建表也走这条，先看后执行** |
| `db.ddl.exec` | `DdlOp` → `{affected}` |
| `db.danger.assess` | `{db_id, sql}` → `{is_dangerous, kind, estimated_rows}` |

> `db.danger.assess` 服务产品文档 §9.4：删表 / 清空 / 无 `WHERE` 的
> UPDATE·DELETE 要弹确认并显示**预估影响行数**。判定在 Rust 侧做，
> 渲染层只负责弹窗。

**导入导出**

| 方法 | 请求 → 响应 |
|---|---|
| `db.export.dump` | `{db_id, scope, mode, out_path}` → `{job_id}` | mode: SCHEMA_ONLY / DATA_ONLY / BOTH |
| `db.import.sql` | `{db_id, file_path}` → `{job_id}` |
| `db.export.result` | `{query_id, format, out_path}` → `{job_id}` | format: CSV / JSON / SQL / EXCEL / TSV |
| `db.copy.result` | `{query_id, rows[], format}` → `{text}` | format: **INSERT / UPDATE** / CSV / TSV / JSON |
| `db.job.cancel` | `{job_id}` → `{}` |

**事件**：
| topic | payload | 用途 |
|---|---|---|
| `db.output` | `{db_id, time, sql, ok, affected, elapsed_ms, error?}` | **执行输出区**（产品文档 §9.1） |
| `db.job.progress` | `{job_id, done, total, current_line?}` | dump 导入导出进度 |
| `db.schema.updated` | `{db_id, node_id}` | 后台刷新完成 |

### 6.6 `completion.*` —— 补全（契约上写死不许阻塞）

```protobuf
message CompletionRequest {
  CompletionScope scope = 1;   // SHELL | SQL
  string prefix    = 2;
  string session_id = 3;       // 用于取 cwd / host / 当前库
  uint32 max_items = 4;
  uint32 deadline_ms = 5;      // ★ 超过就返回已有的，不等
}
```

| 方法 | 请求 → 响应 |
|---|---|
| `completion.query` | `CompletionRequest` → `{items[], truncated}` |

> **协议级约束**：本方法**必须在 `deadline_ms` 内返回**，查不到就返回空数组，
> **绝不允许阻塞等待**。产品文档 §8 的铁律「可以没有补全，但绝不能卡」
> 在协议层就落死，不靠实现方自觉。
>
> 候选来源可挂第三方（以后接 AI）：`CompletionItem` 带 `source` 字段，
> **新来源只能追加到列表末尾，不重排已有项**。

### 6.7 `oplog.*` —— 操作日志

写入由核心自己做（**渲染层没有写入方法**，避免被绕过）。渲染层只能查：

| 方法 | 请求 → 响应 |
|---|---|
| `oplog.search` | `{filter, offset, limit}` → `{entries[], total}` |
| `oplog.clear` | `{range}` → `{cleared}` |
| `oplog.set_enabled` | `{on}` → `{}` |

```protobuf
message OpLogEntry {
  string id = 1;  int64 at_unix_ms = 2;
  OpKind kind = 3;      // CONNECT|DISCONNECT|COMMAND|SQL|DDL|FILE|IMPORT_EXPORT
  string conn_id = 4;  string host = 5;  string cwd = 6;
  string content = 7;   // ★ 已脱敏
  bool   ok = 8;  int32 exit_code = 9;  int64 elapsed_ms = 10;
  int64  affected_rows = 11;
}
```

> 一份数据服务四个用途（产品文档 §12）：历史查询、补全排序、AI 上下文、V2 企业审计。
> **`content` 入库前必须脱敏**（密码 / token / 密钥），脱敏在 Rust 侧做。

### 6.8 `config.*` —— 配置（三层覆盖 + 锁定）

| 方法 | 请求 → 响应 |
|---|---|
| `config.get` | `{key}` → `{value, source, locked}` |
| `config.get_all` | `{prefix?}` → `{entries[]}` |
| `config.set` | `{key, value}` → `{}` ← locked 时回 `LOCKED_BY_POLICY` |
| `config.reset` | `{key}` → `{}` |

`source`: `DEFAULT | USER | POLICY`

**事件**：`config.changed {key, value, source, locked}`
→ 本地热加载和 V2 远端推送**走同一条路**，渲染层只订阅这一个事件。

### 6.9 `entitlement.*` —— 授权检查

| 方法 | 请求 → 响应 |
|---|---|
| `entitlement.check` | `{feature_id}` → `{allowed, reason_key?}` |
| `entitlement.list` | `{}` → `{features[]}` ← 界面据此把功能置灰 |

> **V1 永远返回 `allowed=true`，但调用链真实存在。**
> 每个功能有自己的 `feature_id`，将来限制哪个改配置即可，不动功能代码。
> 被拒时渲染层显示「功能不可用 + 原因」，不是点了没反应也不是报错。

### 6.10 `sysinfo.*` —— 服务器信息

| 方法 | 请求 → 响应 |
|---|---|
| `sysinfo.start` | `{conn_id, interval_ms}` → `{}` |
| `sysinfo.stop` | `{conn_id}` → `{}` |

**事件**：`sysinfo.sample {conn_id, cpu, mem, disks[], net, load, uptime_sec, os, top_procs[]}`

> 探测失败（权限不够 / 命令不存在）时**不发错误**，只在 sample 里把对应字段留空，
> 界面安静降级 —— 产品文档 §11 要求「不弹错误框骚扰用户」。

---

## 7. 版本与演进

### 7.1 握手

任何通道建立后的**第一条消息必须是 `Hello`**，外壳先发，核心回。

```protobuf
message Hello {
  uint32 protocol_major      = 1;  // 不兼容变更才 +1
  uint32 protocol_minor      = 2;  // 向后兼容的新增
  uint32 min_supported_major = 3;  // 对方低于这个就拒绝握手
  string impl_version        = 4;  // 实现版本，如 "core-0.3.1"，仅用于日志和崩溃上报
  repeated string capabilities = 5;
}
```

**协商规则**：

| 情况 | 结果 |
|---|---|
| 双方 `major` 相同 | ✅ 通过。共同基线取 `min(minor_a, minor_b)` |
| 一方 `major` 落在对方 `[min_supported_major, major]` 区间内 | ✅ 通过，按低的那个 major 走 |
| 都不在对方支持区间 | ❌ 拒绝，返回 `Error{code: INTERNAL, key: "err.proto.version_mismatch"}`，**并明确告诉用户是哪一边旧了** |

能力集取**交集**。

### 7.2 能力名（capabilities）

比版本号更重要 —— **判断"能不能用某功能"一律查能力，不查版本号**。

```
db.mysql          db.postgres       db.dump_import_export
ssh.jump_chain    ssh.tunnel        ssh.proxy
file.sftp         completion.sql    completion.shell
oplog.search      sysinfo.probe     plugin.host
entitlement.gate  config.policy
```

命名规范：`<域>.<能力>`，全小写下划线，只增不删（功能下线时保留名字但不再上报）。

> **为什么不用版本号判断**：功能可能被回退、可能在不同分支各自加、
> 企业版和个人版能力集也不同。`capabilities.contains("db.postgres")` 永远是对的，
> `version >= 3` 迟早会错。

### 7.3 六种变更怎么处理

| 变更 | 做法 | 升什么 |
|---|---|---|
| **加字段** | 用新的字段编号，旧端自动忽略 | minor +1 |
| **加方法** | 直接加，同时加一个 capability | minor +1 |
| **加事件 topic** | 直接加，旧端忽略未知 topic | minor +1 |
| **删字段** | 标 `reserved`，编号**永不复用** | minor +1 |
| **破坏性改某个方法** | **加新方法名带后缀**，如 `db.query.exec2`，老方法保留至少一个大版本 | minor +1 |
| **真的必须整体破坏** | 最后手段 | **major +1** |

**禁止的做法**（会导致新旧端静默错乱，比崩溃更糟）：

> ❌ **改已有字段的语义**（比如 `timeout` 从秒改成毫秒）
> ❌ **复用已删除的字段编号**
> ❌ **改已有方法的行为**（要改就用新方法名）

改语义等同于新字段 —— 加个新字段，老字段标 `deprecated`。

### 7.4 兼容性契约（双方都必须遵守）

| 规则 | 说明 |
|---|---|
| 未知字段 → 忽略 | 新版核心 + 旧版外壳不能崩 |
| 未知 method → 回 `UNKNOWN_METHOD` | 不是解码失败，是明确的错误码 |
| 未知 event topic → 静默丢弃 | 不报错、不打断 |
| 未知 enum 值 → 当作 0（`UNKNOWN`）处理 | **所有 enum 的 0 值必须是 `UNKNOWN`/`NONE`** |
| 新增方法必须配 capability | 否则调用方没法知道能不能调 |

### 7.5 一个例子：以后加 Oracle 支持

1. `DbKind` 加 `ORACLE = 3`（新枚举值，旧端收到当 `UNKNOWN` 处理，不会崩）
2. 核心 `capabilities` 加 `db.oracle`
3. `protocol_minor` +1
4. 旧版外壳连新版核心：能力集里没有 `db.oracle`，界面就不显示 Oracle 选项，**其余功能照常**
5. 新版外壳连旧版核心：同样查不到能力，同样不显示

**全程不需要任何版本号大小比较，也不需要 major 升级。**

---

## 8. 四个口子在协议里的落点

产品文档要求 V1 就留好的四个口子，在本协议里的对应：

| 口子 | 协议落点 |
|---|---|
| **连接来源标记** | `Connection.origin` + `Connection.locked`（§5.1） |
| **设置项可被公司锁定** | `config.get` 返回 `locked`；`config.set` 回 `LOCKED_BY_POLICY`（§6.8） |
| **连接与密码分离** | `Connection.credential_ref`，协议里**没有** `cred.get`（§5.1 / §6.2） |
| **授权检查** | `entitlement.check`，V1 永远放行但真实调用（§6.9） |

---

## 9. 还没定的

| # | 待定 | 影响 |
|---|---|---|
| 1 | Arrow 数据块在数据通道上的分帧格式 | 数据库大结果集链路 |
| 2 | 终端数据通道的批处理窗口（多少毫秒 / 多少字节成一批） | 延迟与吞吐的平衡点，要压测定 |
| 3 | 流控高低水位的具体数值 | 同上 |
| 4 | `DdlOp` 的完整结构（建表/改表/索引/外键） | 可视化建表 |
| 5 | 本地化 key 的命名规范 | 所有错误文案 |
| 6 | 插件宿主如何接入本协议（V1 不做） | 以后插件能调哪些方法 |
| 7 | **数据面在「核心与 UI 不同机」时如何降级** | 为将来的 Server 形态留路，见下 |

### 关于第 7 条：不要堵死客户端/服务端分离这条路

VS Code 把自己劈成两半跑（Remote Development：客户端本地 + Server 远端；
vscode.dev：整个跑浏览器里）。如果我们协议做对了，以后也能做
**HackerTerm Server** —— 核心跑在服务器，本地只留 UI。
对企业版这是天然演进方向：连接全从服务器发起，**凭据根本不下发到员工电脑**，审计天然完整。

**V1 不做，但现在别把路堵死**：

| 要求 | 说明 |
|---|---|
| 不传本地文件路径当句柄 | 跨机器时路径无意义，要用不透明的 id |
| 不假设共享内存可用 | `SharedArrayBuffer` 是本机专用，跨机器要能降级成流式传输 |
| 不假设时钟同步 | 时间戳统一由核心生成 |

当前设计（消息 + 二进制块）基本满足，**需要复查的只有 `SharedArrayBuffer` 那条数据面路径**。

前三条**必须靠第 1 周的压测来定**，不能拍脑袋。
