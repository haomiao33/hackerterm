# HackerTerm M0 风险验证骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建一个能跑的最小骨架，把 Electron 外壳 + Rust 核心 + 协议这条链路端到端打通，并用压测实测出三个只能靠数据决定的参数。

**Architecture:** Electron 主进程只做编排；Rust 核心以 napi-rs 原生模块的形式跑在**一个全局 utility process** 里，承担 PTY 与流控；渲染进程（一个 Tab 一个，沙箱开启）用 xterm.js + WebGL 显示。控制面走 Protobuf 消息，数据面走裸 `ArrayBuffer`，两者用不同的 MessagePort，**建立连接后都不经过主进程**。

**Tech Stack:** Rust（portable-pty / prost / napi-rs 2）· Electron 33+ · TypeScript · electron-vite · xterm.js + `@xterm/addon-webgl` · ts-proto · vitest · cargo test

## Global Constraints

- **平台**：只支持 Windows 和 macOS。不做 Linux 构建与验证。
- **渲染进程必须沙箱**：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。任何任务都不得为了图方便关掉它们。
- **渲染进程不得直接碰文件、进程、网络**。所有此类能力只能在 Rust 核心里。
- **Rust 核心是全局单实例**，不是每窗口一个。
- **napi 表面必须极薄**：只暴露「发送一个字节块」「注册一个接收回调」两类能力，**不得为每个业务方法开一个 `#[napi]` 函数**。业务语义全部在 Protobuf 消息里。
- **UI 目录分层强制**：`src/ui/common` 禁止 import 任何 DOM / Electron / Node；`src/ui/browser` 禁止 import Electron；只有 `src/ui/electron` 可以 import `electron`。用 ESLint 强制，违反即构建失败。
- **数据面禁止 JSON 序列化、禁止转字符串、禁止经主进程中转**。
- **所有 protobuf enum 的 0 值必须是 `UNKNOWN` 或 `NONE`**。
- **错误不返回成品文案**：只返回 `key` + `params`，翻译在渲染层。
- 包管理器统一用 `pnpm`。Rust 用 stable toolchain。

---

## File Structure

```
hackerterm/
├── Cargo.toml                        Rust workspace 根
├── rust-toolchain.toml
├── proto/
│   └── hackerterm.proto              ★ 协议单一事实来源（Rust 和 TS 都从它生成）
├── crates/
│   ├── ht-proto/                     protobuf 生成产物 + 信封编解码
│   │   ├── Cargo.toml
│   │   ├── build.rs
│   │   └── src/lib.rs
│   ├── ht-core/                      核心逻辑，无 napi 依赖，可脱离 Electron 单测
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                Core 入口 + 出站通道
│   │       ├── dispatch.rs           method 字符串 → 处理函数
│   │       ├── hello.rs              握手与能力协商
│   │       ├── session.rs            PTY 会话生命周期
│   │       └── flow.rs               流控水位计算
│   └── ht-node/                      napi 绑定，极薄
│       ├── Cargo.toml
│       ├── package.json
│       └── src/lib.rs
├── package.json
├── pnpm-workspace.yaml
├── electron.vite.config.ts
├── eslint.config.js                  ★ 目录分层强制规则
├── src/
│   ├── main/index.ts                 Electron 主进程：建窗口、拉起 core-host、牵 MessagePort
│   ├── core-host/index.ts            utility process：加载 ht-node，转发字节
│   ├── preload/index.ts              暴露受限的 MessagePort 接收口
│   └── ui/
│       ├── common/
│       │   ├── protocol/generated.ts ts-proto 生成产物
│       │   ├── protocol/client.ts    ★ 纯逻辑协议客户端，无 DOM/Electron
│       │   └── protocol/client.test.ts
│       ├── browser/
│       │   ├── terminal/mount.ts     xterm.js 挂载 + WebGL + 流控 ack
│       │   └── index.html
│       └── electron/
│           └── bootstrap.ts          唯一允许 import electron 的地方
├── bench/
│   ├── run.ts                        压测编排
│   ├── scenarios.ts                  场景定义
│   └── results/                      ★ 实测结果落盘，供回写协议文档
└── docs/superpowers/verification/
    ├── conpty.md                     Windows ConPTY 验证记录
    ├── ime.md                        中文输入法验证记录
    ├── font.md                       字体与连字验证记录
    └── crash-isolation.md            崩溃隔离验证记录
```

**责任划分**：`ht-core` 不知道 napi 存在（可单测）；`ht-node` 不含业务逻辑（可整体替换成别的宿主）；`ui/common` 不知道 DOM 存在（换外壳时不动）。

---

## Task 1: 仓库骨架与 Rust ↔ Node 字节往返

**Files:**
- Create: `Cargo.toml`, `rust-toolchain.toml`, `package.json`, `pnpm-workspace.yaml`
- Create: `crates/ht-node/Cargo.toml`, `crates/ht-node/package.json`, `crates/ht-node/src/lib.rs`
- Test: `crates/ht-node/__test__/roundtrip.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: napi 模块导出两个函数 —— `start(onMessage: (buf: Buffer) => void): void` 和 `send(buf: Buffer): void`。**整个项目对 Rust 的调用面就只有这两个**，后续任务不得增加第三个。

- [ ] **Step 1: 建 workspace 骨架**

`Cargo.toml`:
```toml
[workspace]
members = ["crates/ht-proto", "crates/ht-core", "crates/ht-node"]
resolver = "2"

[workspace.package]
edition = "2021"
license = "Proprietary"
```

`rust-toolchain.toml`:
```toml
[toolchain]
channel = "stable"
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "crates/ht-node"
```

`package.json`:
```json
{
  "name": "hackerterm",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "build:native": "pnpm --filter ht-node build",
    "test:native": "pnpm --filter ht-node test"
  }
}
```

- [ ] **Step 2: 写失败的往返测试**

`crates/ht-node/__test__/roundtrip.test.mjs`:
```javascript
import test from 'node:test'
import assert from 'node:assert/strict'
import { start, send } from '../index.js'

test('bytes sent into core come back through the callback', async () => {
  const received = []
  start((buf) => received.push(Buffer.from(buf)))

  send(Buffer.from([1, 2, 3]))

  await new Promise((r) => setTimeout(r, 100))

  assert.equal(received.length, 1)
  // M0 阶段核心把收到的字节原样回声，用于验证通道
  assert.deepEqual([...received[0]], [1, 2, 3])
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test:native`
Expected: FAIL，报找不到 `../index.js`（原生模块还没构建）

- [ ] **Step 4: 写 napi 绑定**

`crates/ht-node/Cargo.toml`:
```toml
[package]
name = "ht-node"
version = "0.0.1"
edition.workspace = true
license.workspace = true

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = { version = "2", default-features = false, features = ["napi6", "tokio_rt"] }
napi-derive = "2"

[build-dependencies]
napi-build = "2"
```

`crates/ht-node/package.json`:
```json
{
  "name": "ht-node",
  "version": "0.0.1",
  "main": "index.js",
  "napi": { "name": "ht-node" },
  "scripts": {
    "build": "napi build --platform --release",
    "build:debug": "napi build --platform",
    "test": "node --test __test__/"
  },
  "devDependencies": { "@napi-rs/cli": "^2.18.0" }
}
```

`crates/ht-node/build.rs`:
```rust
fn main() {
    napi_build::setup();
}
```

`crates/ht-node/src/lib.rs`:
```rust
#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::OnceLock;

static OUTBOUND: OnceLock<ThreadsafeFunction<Vec<u8>, ErrorStrategy::Fatal>> = OnceLock::new();

/// 注册出站回调。整个进程只调用一次。
#[napi]
pub fn start(on_message: JsFunction) -> Result<()> {
    let tsfn: ThreadsafeFunction<Vec<u8>, ErrorStrategy::Fatal> = on_message
        .create_threadsafe_function(0, |ctx| {
            Ok(vec![Buffer::from(ctx.value)])
        })?;
    OUTBOUND
        .set(tsfn)
        .map_err(|_| Error::from_reason("start() called twice"))?;
    Ok(())
}

/// 入站字节。M0 阶段原样回声，验证通道通了。
#[napi]
pub fn send(buf: Buffer) -> Result<()> {
    let bytes: Vec<u8> = buf.to_vec();
    let tsfn = OUTBOUND
        .get()
        .ok_or_else(|| Error::from_reason("start() not called"))?;
    tsfn.call(bytes, ThreadsafeFunctionCallMode::NonBlocking);
    Ok(())
}
```

- [ ] **Step 5: 构建并运行测试确认通过**

Run: `pnpm build:native && pnpm test:native`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add Cargo.toml rust-toolchain.toml package.json pnpm-workspace.yaml crates/ht-node
git commit -m "feat(core): napi 字节通道骨架，仅暴露 start/send 两个函数"
```

---

## Task 2: 协议定义与双端代码生成

**Files:**
- Create: `proto/hackerterm.proto`
- Create: `crates/ht-proto/Cargo.toml`, `crates/ht-proto/build.rs`, `crates/ht-proto/src/lib.rs`
- Create: `crates/ht-proto/tests/envelope.rs`
- Modify: `package.json`（加 ts-proto 生成脚本）

**Interfaces:**
- Consumes: 无
- Produces:
  - Rust: `ht_proto::pb::{Envelope, Request, Response, Event, Error, ErrorCode, Hello}`，以及
    `ht_proto::encode_envelope(&Envelope) -> Vec<u8>` 和 `ht_proto::decode_envelope(&[u8]) -> Result<Envelope, DecodeError>`
  - TS: `src/ui/common/protocol/generated.ts` 导出同名 interface 与 `Envelope.encode/decode`

- [ ] **Step 1: 写 proto（M0 子集）**

`proto/hackerterm.proto`:
```protobuf
syntax = "proto3";
package hackerterm.v1;

message Envelope {
  oneof kind {
    Request  request  = 1;
    Response response = 2;
    Event    event    = 3;
  }
}

message Request {
  uint64 id      = 1;
  string method  = 2;
  bytes  payload = 3;
}

message Response {
  uint64 id = 1;
  oneof result {
    bytes payload = 2;
    Error error   = 3;
  }
}

message Event {
  string topic   = 1;
  bytes  payload = 2;
}

enum ErrorCode {
  ERROR_CODE_UNKNOWN          = 0;
  ERROR_CODE_UNKNOWN_METHOD   = 1;
  ERROR_CODE_INVALID_ARGUMENT = 2;
  ERROR_CODE_NOT_FOUND        = 3;
  ERROR_CODE_CONNECT_FAILED   = 6;
  ERROR_CODE_TIMEOUT          = 8;
  ERROR_CODE_CANCELLED        = 9;
  ERROR_CODE_INTERNAL         = 11;
}

message Error {
  ErrorCode code = 1;
  string    key  = 2;
  map<string, string> params = 3;
  string    detail    = 4;
  bool      retryable = 5;
}

message Hello {
  uint32 protocol_major      = 1;
  uint32 protocol_minor      = 2;
  uint32 min_supported_major = 3;
  string impl_version        = 4;
  repeated string capabilities = 5;
}

// ---- session ----

message SessionOpenRequest {
  string shell = 1;   // 空则用系统默认
  uint32 cols  = 2;
  uint32 rows  = 3;
  string cwd   = 4;
}
message SessionOpenResponse { string session_id = 1; }

message SessionResizeRequest { string session_id = 1; uint32 cols = 2; uint32 rows = 3; }
message SessionCloseRequest  { string session_id = 1; }
message SessionAckRequest    { string session_id = 1; uint64 bytes_consumed = 2; }

enum Signal {
  SIGNAL_NONE = 0;
  SIGNAL_INT  = 1;
  SIGNAL_TERM = 2;
  SIGNAL_KILL = 3;
}
message SessionSignalRequest { string session_id = 1; Signal signal = 2; }

message Empty {}

enum SessionState {
  SESSION_STATE_UNKNOWN   = 0;
  SESSION_STATE_CONNECTED = 1;
  SESSION_STATE_CLOSED    = 2;
  SESSION_STATE_FAILED    = 3;
}
message SessionStateEvent { string session_id = 1; SessionState state = 2; Error error = 3; }
message SessionExitEvent  { string session_id = 1; int32 exit_code = 2; }
```

- [ ] **Step 2: 写失败的信封往返测试**

`crates/ht-proto/tests/envelope.rs`:
```rust
use ht_proto::pb::{envelope, Envelope, Request};
use ht_proto::{decode_envelope, encode_envelope};

#[test]
fn request_survives_roundtrip() {
    let env = Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 42,
            method: "session.open".to_string(),
            payload: vec![9, 8, 7],
        })),
    };

    let bytes = encode_envelope(&env);
    let back = decode_envelope(&bytes).expect("decode should succeed");

    match back.kind {
        Some(envelope::Kind::Request(r)) => {
            assert_eq!(r.id, 42);
            assert_eq!(r.method, "session.open");
            assert_eq!(r.payload, vec![9, 8, 7]);
        }
        other => panic!("expected Request, got {other:?}"),
    }
}

#[test]
fn unknown_bytes_fail_cleanly() {
    // 0xFF 开头不是合法的 protobuf tag，必须返回 Err 而不是 panic
    let err = decode_envelope(&[0xFF, 0xFF, 0xFF]);
    assert!(err.is_err());
}
```

- [ ] **Step 3: 运行确认失败**

Run: `cargo test -p ht-proto`
Expected: FAIL，`ht-proto` crate 不存在

- [ ] **Step 4: 实现 ht-proto**

`crates/ht-proto/Cargo.toml`:
```toml
[package]
name = "ht-proto"
version = "0.0.1"
edition.workspace = true
license.workspace = true

[dependencies]
prost = "0.13"

[build-dependencies]
prost-build = "0.13"
```

`crates/ht-proto/build.rs`:
```rust
fn main() {
    println!("cargo:rerun-if-changed=../../proto/hackerterm.proto");
    prost_build::compile_protos(
        &["../../proto/hackerterm.proto"],
        &["../../proto"],
    )
    .expect("failed to compile protos");
}
```

`crates/ht-proto/src/lib.rs`:
```rust
pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/hackerterm.v1.rs"));
}

use prost::Message;
pub use prost::DecodeError;

pub fn encode_envelope(env: &pb::Envelope) -> Vec<u8> {
    let mut buf = Vec::with_capacity(env.encoded_len());
    env.encode(&mut buf).expect("Vec never fails to grow");
    buf
}

pub fn decode_envelope(bytes: &[u8]) -> Result<pb::Envelope, DecodeError> {
    pb::Envelope::decode(bytes)
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cargo test -p ht-proto`
Expected: PASS，两个测试都过

- [ ] **Step 6: 加 TS 端生成**

给 `package.json` 的 `scripts` 加：
```json
"proto:ts": "protoc --plugin=./node_modules/.bin/protoc-gen-ts_proto --ts_proto_out=src/ui/common/protocol --ts_proto_opt=esModuleInterop=true,outputJsonMethods=false,outputPartialMethods=false,useOptionals=messages -I proto proto/hackerterm.proto"
```

并加 devDependency：`"ts-proto": "^2.2.0"`

- [ ] **Step 7: 运行生成并确认产物存在**

Run: `pnpm install && pnpm proto:ts && ls src/ui/common/protocol/`
Expected: 出现 `hackerterm.ts`（ts-proto 按 proto 文件名生成）

- [ ] **Step 8: 提交**

```bash
git add proto crates/ht-proto package.json src/ui/common/protocol
git commit -m "feat(proto): M0 协议子集与 Rust/TS 双端代码生成"
```

---

## Task 3: 核心分发器与握手

**Files:**
- Create: `crates/ht-core/Cargo.toml`, `crates/ht-core/src/lib.rs`, `crates/ht-core/src/dispatch.rs`, `crates/ht-core/src/hello.rs`
- Create: `crates/ht-core/tests/handshake.rs`

**Interfaces:**
- Consumes: `ht_proto::pb::*`、`ht_proto::{encode_envelope, decode_envelope}`（Task 2）
- Produces:
  - `ht_core::Core::new(outbound: Box<dyn Fn(Vec<u8>) + Send + Sync>) -> Core`
  - `ht_core::Core::handle_inbound(&self, bytes: &[u8])`
  - 常量 `ht_core::PROTOCOL_MAJOR: u32 = 1`、`PROTOCOL_MINOR: u32 = 0`、`MIN_SUPPORTED_MAJOR: u32 = 1`

- [ ] **Step 1: 写失败的握手测试**

`crates/ht-core/tests/handshake.rs`:
```rust
use ht_core::Core;
use ht_proto::pb::{envelope, Envelope, Hello, Request, Response};
use ht_proto::{decode_envelope, encode_envelope};
use prost::Message;
use std::sync::{Arc, Mutex};

fn collect() -> (Arc<Mutex<Vec<Vec<u8>>>>, Box<dyn Fn(Vec<u8>) + Send + Sync>) {
    let sink = Arc::new(Mutex::new(Vec::new()));
    let s = sink.clone();
    (sink, Box::new(move |b| s.lock().unwrap().push(b)))
}

#[test]
fn hello_is_answered_with_core_hello() {
    let (sink, out) = collect();
    let core = Core::new(out);

    let hello = Hello {
        protocol_major: 1,
        protocol_minor: 0,
        min_supported_major: 1,
        impl_version: "shell-test".into(),
        capabilities: vec!["terminal".into()],
    };
    let req = Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 1,
            method: "hello".into(),
            payload: hello.encode_to_vec(),
        })),
    };
    core.handle_inbound(&encode_envelope(&req));

    let out = sink.lock().unwrap();
    assert_eq!(out.len(), 1);
    let env = decode_envelope(&out[0]).unwrap();
    let Some(envelope::Kind::Response(Response { id, result: Some(r) })) = env.kind else {
        panic!("expected Response");
    };
    assert_eq!(id, 1);
    let ht_proto::pb::response::Result::Payload(p) = r else {
        panic!("expected success payload, got error");
    };
    let core_hello = Hello::decode(&p[..]).unwrap();
    assert_eq!(core_hello.protocol_major, 1);
    assert!(core_hello.capabilities.contains(&"terminal".to_string()));
}

#[test]
fn unknown_method_returns_unknown_method_error() {
    let (sink, out) = collect();
    let core = Core::new(out);

    let req = Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 7,
            method: "does.not.exist".into(),
            payload: vec![],
        })),
    };
    core.handle_inbound(&encode_envelope(&req));

    let out = sink.lock().unwrap();
    let env = decode_envelope(&out[0]).unwrap();
    let Some(envelope::Kind::Response(Response { id, result: Some(r) })) = env.kind else {
        panic!("expected Response");
    };
    assert_eq!(id, 7);
    let ht_proto::pb::response::Result::Error(e) = r else {
        panic!("expected error");
    };
    assert_eq!(e.code, ht_proto::pb::ErrorCode::UnknownMethod as i32);
    // 关键：只给 key，不给成品文案
    assert_eq!(e.key, "err.proto.unknown_method");
    assert!(!e.key.is_empty());
}

#[test]
fn garbage_inbound_does_not_panic() {
    let (sink, out) = collect();
    let core = Core::new(out);
    core.handle_inbound(&[0xFF, 0xFF, 0xFF]);
    // 解不出信封时无法知道 id，只能丢弃，不能崩
    assert_eq!(sink.lock().unwrap().len(), 0);
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p ht-core`
Expected: FAIL，crate 不存在

- [ ] **Step 3: 实现 ht-core 骨架**

`crates/ht-core/Cargo.toml`:
```toml
[package]
name = "ht-core"
version = "0.0.1"
edition.workspace = true
license.workspace = true

[dependencies]
ht-proto = { path = "../ht-proto" }
prost = "0.13"
```

`crates/ht-core/src/hello.rs`:
```rust
use ht_proto::pb::Hello;

pub const PROTOCOL_MAJOR: u32 = 1;
pub const PROTOCOL_MINOR: u32 = 0;
pub const MIN_SUPPORTED_MAJOR: u32 = 1;

/// M0 阶段核心具备的能力。新增功能时往这里加，不要靠版本号判断。
pub fn capabilities() -> Vec<String> {
    vec!["terminal".to_string()]
}

pub fn core_hello() -> Hello {
    Hello {
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: PROTOCOL_MINOR,
        min_supported_major: MIN_SUPPORTED_MAJOR,
        impl_version: format!("ht-core-{}", env!("CARGO_PKG_VERSION")),
        capabilities: capabilities(),
    }
}
```

`crates/ht-core/src/dispatch.rs`:
```rust
use ht_proto::pb::{Error, ErrorCode};

/// 方法处理的统一返回：成功返回已编码的响应 payload，失败返回结构化 Error。
pub type Handled = Result<Vec<u8>, Error>;

pub fn err(code: ErrorCode, key: &str, detail: impl Into<String>) -> Error {
    Error {
        code: code as i32,
        key: key.to_string(),
        params: Default::default(),
        detail: detail.into(),
        retryable: false,
    }
}

pub fn unknown_method(method: &str) -> Error {
    err(
        ErrorCode::UnknownMethod,
        "err.proto.unknown_method",
        format!("no handler for method `{method}`"),
    )
}
```

`crates/ht-core/src/lib.rs`:
```rust
pub mod dispatch;
pub mod hello;

pub use hello::{MIN_SUPPORTED_MAJOR, PROTOCOL_MAJOR, PROTOCOL_MINOR};

use dispatch::{unknown_method, Handled};
use ht_proto::pb::{envelope, response, Envelope, Hello, Request, Response};
use ht_proto::{decode_envelope, encode_envelope};
use prost::Message;

pub type Outbound = Box<dyn Fn(Vec<u8>) + Send + Sync>;

pub struct Core {
    outbound: Outbound,
}

impl Core {
    pub fn new(outbound: Outbound) -> Self {
        Self { outbound }
    }

    /// 入站字节。解不出信封只能丢弃 —— 没有 id 就无法回响应，但绝不能崩。
    pub fn handle_inbound(&self, bytes: &[u8]) {
        let Ok(env) = decode_envelope(bytes) else {
            return;
        };
        if let Some(envelope::Kind::Request(req)) = env.kind {
            let result = self.route(&req);
            self.reply(req.id, result);
        }
    }

    fn route(&self, req: &Request) -> Handled {
        match req.method.as_str() {
            "hello" => {
                // 对端的 Hello 解析失败也不致命：M0 只回自己的能力集
                let _peer = Hello::decode(&req.payload[..]).ok();
                Ok(hello::core_hello().encode_to_vec())
            }
            other => Err(unknown_method(other)),
        }
    }

    fn reply(&self, id: u64, result: Handled) {
        let result = match result {
            Ok(payload) => response::Result::Payload(payload),
            Err(e) => response::Result::Error(e),
        };
        let env = Envelope {
            kind: Some(envelope::Kind::Response(Response {
                id,
                result: Some(result),
            })),
        };
        (self.outbound)(encode_envelope(&env));
    }

    pub(crate) fn emit(&self, topic: &str, payload: Vec<u8>) {
        let env = Envelope {
            kind: Some(envelope::Kind::Event(ht_proto::pb::Event {
                topic: topic.to_string(),
                payload,
            })),
        };
        (self.outbound)(encode_envelope(&env));
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p ht-core`
Expected: PASS，三个测试都过

- [ ] **Step 5: 把 ht-node 接到 ht-core**

替换 `crates/ht-node/src/lib.rs` 里 `send` 的回声逻辑，改为转发给 Core：

```rust
#![deny(clippy::all)]

use ht_core::Core;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::OnceLock;

static CORE: OnceLock<Core> = OnceLock::new();

#[napi]
pub fn start(on_message: JsFunction) -> Result<()> {
    let tsfn: ThreadsafeFunction<Vec<u8>, ErrorStrategy::Fatal> = on_message
        .create_threadsafe_function(0, |ctx| Ok(vec![Buffer::from(ctx.value)]))?;

    let core = Core::new(Box::new(move |bytes| {
        tsfn.call(bytes, ThreadsafeFunctionCallMode::NonBlocking);
    }));

    CORE.set(core)
        .map_err(|_| Error::from_reason("start() called twice"))?;
    Ok(())
}

#[napi]
pub fn send(buf: Buffer) -> Result<()> {
    CORE.get()
        .ok_or_else(|| Error::from_reason("start() not called"))?
        .handle_inbound(&buf);
    Ok(())
}
```

给 `crates/ht-node/Cargo.toml` 的 `[dependencies]` 加 `ht-core = { path = "../ht-core" }`。

- [ ] **Step 6: 更新 Task 1 的往返测试为握手测试**

替换 `crates/ht-node/__test__/roundtrip.test.mjs` 全文：
```javascript
import test from 'node:test'
import assert from 'node:assert/strict'
import { start, send } from '../index.js'
import { Envelope, Hello } from '../../../src/ui/common/protocol/hackerterm.js'

test('hello handshake round-trips through napi', async () => {
  const received = []
  start((buf) => received.push(Buffer.from(buf)))

  const payload = Hello.encode({
    protocolMajor: 1, protocolMinor: 0, minSupportedMajor: 1,
    implVersion: 'test', capabilities: ['terminal'],
  }).finish()

  send(Buffer.from(Envelope.encode({
    request: { id: 1, method: 'hello', payload },
  }).finish()))

  await new Promise((r) => setTimeout(r, 200))

  assert.equal(received.length, 1)
  const env = Envelope.decode(received[0])
  assert.equal(env.response.id, 1)
  const coreHello = Hello.decode(env.response.payload)
  assert.equal(coreHello.protocolMajor, 1)
  assert.ok(coreHello.capabilities.includes('terminal'))
})
```

- [ ] **Step 7: 构建并运行确认通过**

Run: `pnpm proto:ts && pnpm build:native && pnpm test:native`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add crates/ht-core crates/ht-node
git commit -m "feat(core): 分发器与握手，napi 转发到 Core"
```

---

## Task 4: PTY 会话与数据面

**Files:**
- Create: `crates/ht-core/src/session.rs`
- Modify: `crates/ht-core/src/lib.rs`（注册 session.* 方法、加数据面出站通道）
- Modify: `crates/ht-node/src/lib.rs`（加 `sendData` / 数据回调）
- Create: `crates/ht-core/tests/session.rs`

**Interfaces:**
- Consumes: Task 3 的 `Core`
- Produces:
  - 方法：`session.open` · `session.resize` · `session.signal` · `session.close` · `session.ack`
  - 事件：`session.state` · `session.exit`
  - napi 新增两个函数：`sendData(sessionId: string, buf: Buffer)` 和 `startData(cb: (sessionId: string, buf: Buffer) => void)`
    —— **数据面与控制面用不同的函数，不共用信封，因为数据面不做 protobuf 编码**

- [ ] **Step 1: 写失败的会话测试**

`crates/ht-core/tests/session.rs`:
```rust
use ht_core::Core;
use ht_proto::pb::{envelope, response, Envelope, Request, SessionOpenRequest, SessionOpenResponse};
use ht_proto::{decode_envelope, encode_envelope};
use prost::Message;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn core_with_sink() -> (Arc<Mutex<Vec<Vec<u8>>>>, Arc<Mutex<Vec<(String, Vec<u8>)>>>, Core) {
    let ctrl = Arc::new(Mutex::new(Vec::new()));
    let data = Arc::new(Mutex::new(Vec::new()));
    let c = ctrl.clone();
    let d = data.clone();
    let core = Core::new_with_data(
        Box::new(move |b| c.lock().unwrap().push(b)),
        Box::new(move |sid, b| d.lock().unwrap().push((sid, b))),
    );
    (ctrl, data, core)
}

fn open_session(core: &Core, ctrl: &Arc<Mutex<Vec<Vec<u8>>>>) -> String {
    let payload = SessionOpenRequest {
        shell: String::new(),
        cols: 80,
        rows: 24,
        cwd: String::new(),
    }
    .encode_to_vec();
    core.handle_inbound(&encode_envelope(&Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 1,
            method: "session.open".into(),
            payload,
        })),
    }));

    let out = ctrl.lock().unwrap();
    let env = decode_envelope(out.last().expect("no response")).unwrap();
    let Some(envelope::Kind::Response(r)) = env.kind else { panic!() };
    let Some(response::Result::Payload(p)) = r.result else { panic!("open failed") };
    SessionOpenResponse::decode(&p[..]).unwrap().session_id
}

#[test]
fn opening_a_session_returns_an_id_and_produces_output() {
    let (ctrl, data, core) = core_with_sink();
    let sid = open_session(&core, &ctrl);
    assert!(!sid.is_empty());

    // shell 启动后一定会打印提示符
    std::thread::sleep(Duration::from_millis(1500));
    let got = data.lock().unwrap();
    assert!(!got.is_empty(), "expected shell output on the data channel");
    assert_eq!(got[0].0, sid);
}

#[test]
fn writing_to_a_session_echoes_back() {
    let (ctrl, data, core) = core_with_sink();
    let sid = open_session(&core, &ctrl);
    std::thread::sleep(Duration::from_millis(1000));
    data.lock().unwrap().clear();

    core.write_data(&sid, b"echo hackerterm_marker\n");
    std::thread::sleep(Duration::from_millis(1500));

    let got = data.lock().unwrap();
    let all: Vec<u8> = got.iter().flat_map(|(_, b)| b.clone()).collect();
    let text = String::from_utf8_lossy(&all);
    assert!(
        text.contains("hackerterm_marker"),
        "expected marker in output, got: {text}"
    );
}

#[test]
fn closing_a_session_emits_exit_event() {
    let (ctrl, _data, core) = core_with_sink();
    let sid = open_session(&core, &ctrl);
    std::thread::sleep(Duration::from_millis(800));

    core.handle_inbound(&encode_envelope(&Envelope {
        kind: Some(envelope::Kind::Request(Request {
            id: 2,
            method: "session.close".into(),
            payload: ht_proto::pb::SessionCloseRequest { session_id: sid.clone() }.encode_to_vec(),
        })),
    }));
    std::thread::sleep(Duration::from_millis(500));

    let out = ctrl.lock().unwrap();
    let saw_exit = out.iter().any(|b| {
        matches!(decode_envelope(b).map(|e| e.kind),
            Ok(Some(envelope::Kind::Event(ev))) if ev.topic == "session.exit")
    });
    assert!(saw_exit, "expected a session.exit event");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p ht-core --test session`
Expected: FAIL，`Core::new_with_data` / `write_data` 不存在

- [ ] **Step 3: 实现 session.rs**

给 `crates/ht-core/Cargo.toml` 的 `[dependencies]` 加：
```toml
portable-pty = "0.8"
uuid = { version = "1", features = ["v4"] }
```

> **Windows 注意**：`portable-pty` 上游不传现代 ConPTY 创建标志。Task 8 会验证；
> 若验证不通过，在那一步换成打了 `PASSTHROUGH_MODE` / `WIN32_INPUT_MODE` / `RESIZE_QUIRK`
> 补丁的 fork，**只需改这里的依赖声明，不动其它代码**。

`crates/ht-core/src/session.rs`:
```rust
use portable_pty::{CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

pub type DataOut = Arc<dyn Fn(String, Vec<u8>) + Send + Sync>;

pub struct Session {
    pub id: String,
    pair: PtyPair,
    writer: Box<dyn Write + Send>,
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
    data_out: DataOut,
}

/// 默认 shell。Windows 用 PowerShell，macOS 用登录 shell。
fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

impl SessionManager {
    pub fn new(data_out: DataOut) -> Self {
        Self { sessions: Mutex::new(HashMap::new()), data_out }
    }

    pub fn open(
        &self,
        shell: &str,
        cols: u16,
        rows: u16,
        cwd: &str,
        on_exit: Arc<dyn Fn(String, i32) + Send + Sync>,
    ) -> std::io::Result<String> {
        let sys = NativePtySystem::default();
        let pair = sys
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let mut cmd = CommandBuilder::new(if shell.is_empty() { default_shell() } else { shell.to_string() });
        if !cwd.is_empty() {
            cmd.cwd(cwd);
        }
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let id = uuid::Uuid::new_v4().to_string();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        // 读线程：把字节推到数据通道。永远不阻塞控制面。
        let data_out = self.data_out.clone();
        let read_id = id.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => data_out(read_id.clone(), buf[..n].to_vec()),
                }
            }
        });

        // 等待线程：进程退出后发事件
        let exit_id = id.clone();
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            on_exit(exit_id, code);
        });

        self.sessions.lock().unwrap().insert(id.clone(), Session { id: id.clone(), pair, writer });
        Ok(id)
    }

    pub fn write(&self, id: &str, bytes: &[u8]) {
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            let _ = s.writer.write_all(bytes);
            let _ = s.writer.flush();
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if let Some(s) = self.sessions.lock().unwrap().get(id) {
            let _ = s.pair.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    /// 中断信号走这里，不排在输出数据队列后面。
    pub fn signal_int(&self, id: &str) {
        self.write(id, &[0x03]); // Ctrl+C
    }

    pub fn close(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
    }
}
```

- [ ] **Step 4: 把 session 接进 Core**

`crates/ht-core/src/lib.rs` 的改动 —— 在 `pub mod hello;` 下加 `pub mod session;`，
并把 `Core` 改成：

```rust
use session::{DataOut, SessionManager};
use std::sync::Arc;

pub struct Core {
    outbound: Outbound,
    sessions: Arc<SessionManager>,
}

impl Core {
    pub fn new(outbound: Outbound) -> Self {
        Self::new_with_data(outbound, Box::new(|_, _| {}))
    }

    pub fn new_with_data(
        outbound: Outbound,
        data_out: Box<dyn Fn(String, Vec<u8>) + Send + Sync>,
    ) -> Self {
        let data: DataOut = Arc::from(data_out);
        Self { outbound, sessions: Arc::new(SessionManager::new(data)) }
    }

    /// 渲染进程写入的键盘数据走这条，不经过 protobuf。
    pub fn write_data(&self, session_id: &str, bytes: &[u8]) {
        self.sessions.write(session_id, bytes);
    }
}
```

在 `route` 的 `match` 里，`"hello"` 分支之后加：

```rust
"session.open" => {
    use ht_proto::pb::{SessionOpenRequest, SessionOpenResponse};
    let r = SessionOpenRequest::decode(&req.payload[..]).map_err(|e| {
        dispatch::err(ht_proto::pb::ErrorCode::InvalidArgument,
                      "err.proto.bad_payload", e.to_string())
    })?;
    let out = self.outbound_clone_for_events();
    let on_exit = Arc::new(move |sid: String, code: i32| {
        let payload = ht_proto::pb::SessionExitEvent { session_id: sid, exit_code: code }
            .encode_to_vec();
        out("session.exit", payload);
    });
    let id = self
        .sessions
        .open(&r.shell, r.cols as u16, r.rows as u16, &r.cwd, on_exit)
        .map_err(|e| dispatch::err(ht_proto::pb::ErrorCode::ConnectFailed,
                                   "err.session.open_failed", e.to_string()))?;
    Ok(SessionOpenResponse { session_id: id }.encode_to_vec())
}
"session.resize" => {
    let r = ht_proto::pb::SessionResizeRequest::decode(&req.payload[..])
        .map_err(|e| dispatch::err(ht_proto::pb::ErrorCode::InvalidArgument,
                                   "err.proto.bad_payload", e.to_string()))?;
    self.sessions.resize(&r.session_id, r.cols as u16, r.rows as u16);
    Ok(ht_proto::pb::Empty {}.encode_to_vec())
}
"session.signal" => {
    let r = ht_proto::pb::SessionSignalRequest::decode(&req.payload[..])
        .map_err(|e| dispatch::err(ht_proto::pb::ErrorCode::InvalidArgument,
                                   "err.proto.bad_payload", e.to_string()))?;
    if r.signal == ht_proto::pb::Signal::Int as i32 {
        self.sessions.signal_int(&r.session_id);
    }
    Ok(ht_proto::pb::Empty {}.encode_to_vec())
}
"session.close" => {
    let r = ht_proto::pb::SessionCloseRequest::decode(&req.payload[..])
        .map_err(|e| dispatch::err(ht_proto::pb::ErrorCode::InvalidArgument,
                                   "err.proto.bad_payload", e.to_string()))?;
    self.sessions.close(&r.session_id);
    self.emit("session.exit",
        ht_proto::pb::SessionExitEvent { session_id: r.session_id, exit_code: 0 }.encode_to_vec());
    Ok(ht_proto::pb::Empty {}.encode_to_vec())
}
```

并加一个辅助方法（`emit` 需要在闭包里用，所以要能克隆出站）：

```rust
impl Core {
    fn outbound_clone_for_events(&self) -> Arc<dyn Fn(&str, Vec<u8>) + Send + Sync> {
        // Outbound 是 Box<dyn Fn>，为了在线程里用，改为在 Core 里持有 Arc
        unimplemented!("见下一步：把 Outbound 类型从 Box 改为 Arc")
    }
}
```

- [ ] **Step 5: 把 `Outbound` 从 `Box` 改为 `Arc`**

因为退出事件要在等待线程里发，出站通道必须能跨线程共享。修改 `lib.rs` 顶部：

```rust
pub type Outbound = Arc<dyn Fn(Vec<u8>) + Send + Sync>;
```

`Core::new_with_data` 签名相应改为接收 `Outbound`，并把测试里的 `Box::new(...)` 换成 `Arc::new(...)`。
`outbound_clone_for_events` 实现为：

```rust
fn outbound_clone_for_events(&self) -> Arc<dyn Fn(&str, Vec<u8>) + Send + Sync> {
    let out = self.outbound.clone();
    Arc::new(move |topic: &str, payload: Vec<u8>| {
        let env = Envelope {
            kind: Some(envelope::Kind::Event(ht_proto::pb::Event {
                topic: topic.to_string(),
                payload,
            })),
        };
        out(encode_envelope(&env));
    })
}
```

同步把 `crates/ht-core/tests/handshake.rs` 和 `session.rs` 里构造 sink 的 `Box::new` 改成 `Arc::new`。

- [ ] **Step 6: 运行确认通过**

Run: `cargo test -p ht-core`
Expected: PASS，握手 3 个 + 会话 3 个共 6 个测试全过

- [ ] **Step 7: napi 加数据面**

给 `crates/ht-node/src/lib.rs` 追加：

```rust
static DATA_OUT: OnceLock<ThreadsafeFunction<(String, Vec<u8>), ErrorStrategy::Fatal>> = OnceLock::new();

#[napi]
pub fn start_data(on_data: JsFunction) -> Result<()> {
    let tsfn: ThreadsafeFunction<(String, Vec<u8>), ErrorStrategy::Fatal> = on_data
        .create_threadsafe_function(0, |ctx| {
            let (sid, bytes) = ctx.value;
            Ok(vec![
                ctx.env.create_string(&sid)?.into_unknown(),
                Buffer::from(bytes).into_unknown(),
            ])
        })?;
    DATA_OUT.set(tsfn).map_err(|_| Error::from_reason("start_data() called twice"))?;
    Ok(())
}

#[napi]
pub fn send_data(session_id: String, buf: Buffer) -> Result<()> {
    CORE.get()
        .ok_or_else(|| Error::from_reason("start() not called"))?
        .write_data(&session_id, &buf);
    Ok(())
}
```

并把 `start` 里构造 `Core` 的部分改为 `Core::new_with_data`，数据回调转发到 `DATA_OUT`。
**注意 `start_data` 必须在 `start` 之前调用**，在 JS 侧保证顺序。

- [ ] **Step 8: 构建确认通过**

Run: `pnpm build:native && cargo test`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add crates/ht-core crates/ht-node
git commit -m "feat(core): PTY 会话与数据面通道"
```

---

## Task 5: Electron 骨架与 MessagePort 直连

**Files:**
- Create: `electron.vite.config.ts`, `eslint.config.js`
- Create: `src/main/index.ts`, `src/core-host/index.ts`, `src/preload/index.ts`
- Create: `src/ui/browser/index.html`, `src/ui/electron/bootstrap.ts`
- Create: `src/ui/common/protocol/client.ts`, `src/ui/common/protocol/client.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 生成的 TS 类型、Task 3/4 的方法
- Produces:
  - `src/ui/common/protocol/client.ts` 导出 `class ProtocolClient`，构造参数 `{ send: (bytes: Uint8Array) => void }`，
    方法 `request(method: string, payload: Uint8Array): Promise<Uint8Array>`、
    `on(topic: string, fn: (payload: Uint8Array) => void): void`、
    `handleInbound(bytes: Uint8Array): void`

- [ ] **Step 1: 写失败的协议客户端测试（纯逻辑，无 DOM）**

`src/ui/common/protocol/client.test.ts`:
```typescript
import { describe, expect, it, vi } from 'vitest'
import { Envelope } from './hackerterm'
import { ProtocolClient } from './client'

describe('ProtocolClient', () => {
  it('resolves a request when the matching response arrives', async () => {
    const sent: Uint8Array[] = []
    const client = new ProtocolClient({ send: (b) => sent.push(b) })

    const pending = client.request('hello', new Uint8Array([1]))

    const req = Envelope.decode(sent[0]).request!
    client.handleInbound(
      Envelope.encode({ response: { id: req.id, payload: new Uint8Array([9]) } }).finish(),
    )

    await expect(pending).resolves.toEqual(new Uint8Array([9]))
  })

  it('rejects with the structured error, not a rendered string', async () => {
    const client = new ProtocolClient({ send: () => {} })
    const pending = client.request('nope', new Uint8Array())
    const id = 1n

    client.handleInbound(
      Envelope.encode({
        response: {
          id,
          error: { code: 1, key: 'err.proto.unknown_method', params: {}, detail: 'x', retryable: false },
        },
      }).finish(),
    )

    await expect(pending).rejects.toMatchObject({ key: 'err.proto.unknown_method' })
  })

  it('ignores events with unknown topics instead of throwing', () => {
    const client = new ProtocolClient({ send: () => {} })
    expect(() =>
      client.handleInbound(
        Envelope.encode({ event: { topic: 'never.seen', payload: new Uint8Array() } }).finish(),
      ),
    ).not.toThrow()
  })

  it('delivers events to subscribers', () => {
    const client = new ProtocolClient({ send: () => {} })
    const fn = vi.fn()
    client.on('session.exit', fn)

    client.handleInbound(
      Envelope.encode({ event: { topic: 'session.exit', payload: new Uint8Array([5]) } }).finish(),
    )

    expect(fn).toHaveBeenCalledWith(new Uint8Array([5]))
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/ui/common`
Expected: FAIL，`./client` 不存在

- [ ] **Step 3: 实现 ProtocolClient**

`src/ui/common/protocol/client.ts`:
```typescript
import { Envelope } from './hackerterm'

export interface ProtocolError {
  code: number
  key: string
  params: Record<string, string>
  detail: string
  retryable: boolean
}

interface Transport {
  send(bytes: Uint8Array): void
}

export class ProtocolClient {
  private nextId = 1n
  private pending = new Map<string, { resolve: (b: Uint8Array) => void; reject: (e: ProtocolError) => void }>()
  private subscribers = new Map<string, Array<(payload: Uint8Array) => void>>()

  constructor(private transport: Transport) {}

  request(method: string, payload: Uint8Array): Promise<Uint8Array> {
    const id = this.nextId++
    const bytes = Envelope.encode({ request: { id, method, payload } }).finish()
    return new Promise((resolve, reject) => {
      this.pending.set(id.toString(), { resolve, reject })
      this.transport.send(bytes)
    })
  }

  on(topic: string, fn: (payload: Uint8Array) => void): void {
    const list = this.subscribers.get(topic) ?? []
    list.push(fn)
    this.subscribers.set(topic, list)
  }

  handleInbound(bytes: Uint8Array): void {
    const env = Envelope.decode(bytes)

    if (env.response) {
      const key = env.response.id.toString()
      const waiter = this.pending.get(key)
      if (!waiter) return // 迟到的响应，丢弃
      this.pending.delete(key)
      if (env.response.error) waiter.reject(env.response.error as ProtocolError)
      else waiter.resolve(env.response.payload ?? new Uint8Array())
      return
    }

    if (env.event) {
      // 未知 topic 静默丢弃，见协议 §7.4
      for (const fn of this.subscribers.get(env.event.topic) ?? []) {
        fn(env.event.payload ?? new Uint8Array())
      }
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run src/ui/common`
Expected: PASS，四个测试全过

- [ ] **Step 5: 加目录分层的 ESLint 强制**

`eslint.config.js`:
```javascript
export default [
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
```

给 `package.json` 加 `"lint": "eslint src"`，并加 devDependencies：`eslint`、`typescript-eslint`。

- [ ] **Step 6: 写主进程、core-host、preload**

`src/core-host/index.ts`（utility process，全局单实例）:
```typescript
import { start, startData, send, sendData } from 'ht-node'

// 顺序很重要：先注册数据回调，再注册控制回调
let controlPort: Electron.MessagePortMain | null = null
const dataPorts = new Map<string, Electron.MessagePortMain>()

startData((sessionId: string, buf: Buffer) => {
  const port = dataPorts.get(sessionId)
  // 转成 ArrayBuffer 后 transfer，避免结构化克隆再拷一次
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  port?.postMessage(ab, [ab])
})

start((buf: Buffer) => {
  controlPort?.postMessage(new Uint8Array(buf))
})

process.parentPort.on('message', (e) => {
  const [port] = e.ports
  if (e.data?.kind === 'control') {
    controlPort = port
    port.on('message', (m) => send(Buffer.from(m.data as Uint8Array)))
    port.start()
  } else if (e.data?.kind === 'data') {
    dataPorts.set(e.data.sessionId, port)
    port.on('message', (m) => sendData(e.data.sessionId, Buffer.from(m.data as ArrayBuffer)))
    port.start()
  }
})
```

`src/main/index.ts`:
```typescript
import { app, BrowserWindow, MessageChannelMain, utilityProcess } from 'electron'
import path from 'node:path'

let core: Electron.UtilityProcess

function spawnCore() {
  core = utilityProcess.fork(path.join(__dirname, '../core-host/index.js'))
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,            // 全局约束：不得关闭
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.webContents.on('did-finish-load', () => {
    // 控制通道：渲染进程 ↔ core，主进程只牵线
    const ctrl = new MessageChannelMain()
    core.postMessage({ kind: 'control' }, [ctrl.port1])
    win.webContents.postMessage('port:control', null, [ctrl.port2])
  })

  win.loadFile(path.join(__dirname, '../ui/browser/index.html'))
  return win
}

// 渲染进程请求为某个会话建数据通道
import { ipcMain } from 'electron'
ipcMain.on('open-data-port', (event, sessionId: string) => {
  const ch = new MessageChannelMain()
  core.postMessage({ kind: 'data', sessionId }, [ch.port1])
  event.sender.postMessage('port:data', { sessionId }, [ch.port2])
})

app.whenReady().then(() => {
  spawnCore()
  createWindow()
})
```

`src/preload/index.ts`:
```typescript
import { contextBridge, ipcRenderer } from 'electron'

// 沙箱下 preload 只能做很薄的转发。端口通过 window.postMessage 交给页面。
ipcRenderer.on('port:control', (e) => {
  window.postMessage({ kind: 'port:control' }, '*', e.ports)
})
ipcRenderer.on('port:data', (e, payload) => {
  window.postMessage({ kind: 'port:data', sessionId: payload.sessionId }, '*', e.ports)
})

contextBridge.exposeInMainWorld('ht', {
  openDataPort: (sessionId: string) => ipcRenderer.send('open-data-port', sessionId),
})
```

- [ ] **Step 7: 写最小渲染页并手动验证握手**

`src/ui/browser/index.html`:
```html
<!doctype html>
<html><body><pre id="log">booting…</pre><script type="module" src="./boot.ts"></script></body></html>
```

`src/ui/browser/boot.ts`:
```typescript
import { ProtocolClient } from '../common/protocol/client'
import { Hello } from '../common/protocol/hackerterm'

const log = (s: string) => { document.getElementById('log')!.textContent += `\n${s}` }

window.addEventListener('message', (e) => {
  if (e.data?.kind !== 'port:control') return
  const port = e.ports[0]
  const client = new ProtocolClient({ send: (b) => port.postMessage(b) })
  port.onmessage = (m) => client.handleInbound(new Uint8Array(m.data))
  port.start()

  const payload = Hello.encode({
    protocolMajor: 1, protocolMinor: 0, minSupportedMajor: 1,
    implVersion: 'shell-m0', capabilities: [],
  }).finish()

  client.request('hello', payload)
    .then((p) => log(`core capabilities: ${Hello.decode(p).capabilities.join(', ')}`))
    .catch((err) => log(`handshake failed: ${err.key}`))
})
```

- [ ] **Step 8: 运行应用并确认握手成功**

Run: `pnpm dev`
Expected: 窗口里显示 `core capabilities: terminal`

- [ ] **Step 9: 运行 lint 确认分层规则生效**

Run: `pnpm lint`
Expected: PASS。再临时在 `src/ui/common/protocol/client.ts` 顶部加一行
`import { app } from 'electron'`，重跑 `pnpm lint`，**必须报错**，确认规则真的生效后删掉这行。

- [ ] **Step 10: 提交**

```bash
git add electron.vite.config.ts eslint.config.js src package.json
git commit -m "feat(shell): Electron 骨架、utility process 宿主与 MessagePort 直连"
```

---

## Task 6: 终端渲染与流控

**Files:**
- Create: `src/ui/browser/terminal/mount.ts`
- Create: `crates/ht-core/src/flow.rs`
- Create: `crates/ht-core/tests/flow.rs`
- Modify: `crates/ht-core/src/lib.rs`（`session.ack` 方法）、`src/ui/browser/boot.ts`

**Interfaces:**
- Consumes: Task 4 的 `session.*`、Task 5 的 `ProtocolClient`
- Produces:
  - Rust: `ht_core::flow::FlowWindow::new(high: u64, low: u64)`，方法 `on_sent(n: u64)`、`on_ack(n: u64)`、`should_pause() -> bool`、`should_resume() -> bool`
  - TS: `mountTerminal(el: HTMLElement, opts): { write(bytes: Uint8Array): void; dispose(): void }`

- [ ] **Step 1: 写失败的流控测试**

`crates/ht-core/tests/flow.rs`:
```rust
use ht_core::flow::FlowWindow;

#[test]
fn pauses_above_high_water_and_resumes_below_low_water() {
    let w = FlowWindow::new(1000, 200);

    w.on_sent(500);
    assert!(!w.should_pause(), "500 未过高水位，不该暂停");

    w.on_sent(600); // 累计 1100
    assert!(w.should_pause(), "1100 超过高水位 1000，必须暂停");

    w.on_ack(800); // 未确认降到 300
    assert!(!w.should_resume(), "300 仍高于低水位 200，还不能恢复");

    w.on_ack(150); // 未确认降到 150
    assert!(w.should_resume(), "150 低于低水位 200，应当恢复");
}

#[test]
fn ack_larger_than_outstanding_does_not_underflow() {
    let w = FlowWindow::new(1000, 200);
    w.on_sent(100);
    w.on_ack(999_999); // 渲染层报了个离谱的数
    assert!(w.should_resume());
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p ht-core --test flow`
Expected: FAIL，`flow` 模块不存在

- [ ] **Step 3: 实现 flow.rs**

`crates/ht-core/src/flow.rs`:
```rust
use std::sync::atomic::{AtomicU64, Ordering};

/// 未确认字节数的滑动窗口。超过高水位就暂停读 PTY，降到低水位再恢复。
pub struct FlowWindow {
    outstanding: AtomicU64,
    high: u64,
    low: u64,
}

impl FlowWindow {
    pub fn new(high: u64, low: u64) -> Self {
        assert!(low < high, "low water mark must be below high");
        Self { outstanding: AtomicU64::new(0), high, low }
    }

    pub fn on_sent(&self, n: u64) {
        self.outstanding.fetch_add(n, Ordering::SeqCst);
    }

    pub fn on_ack(&self, n: u64) {
        // saturating：渲染层报多了也不能下溢
        let _ = self.outstanding.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |cur| {
            Some(cur.saturating_sub(n))
        });
    }

    pub fn outstanding(&self) -> u64 {
        self.outstanding.load(Ordering::SeqCst)
    }

    pub fn should_pause(&self) -> bool {
        self.outstanding() >= self.high
    }

    pub fn should_resume(&self) -> bool {
        self.outstanding() < self.low
    }
}
```

在 `crates/ht-core/src/lib.rs` 加 `pub mod flow;`。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p ht-core --test flow`
Expected: PASS

- [ ] **Step 5: 把流控接进会话读线程**

给 `SessionManager::open` 里的读线程加窗口检查 —— 在 `Session` 结构里加
`flow: Arc<FlowWindow>`，读线程每次 `data_out` 之后 `flow.on_sent(n as u64)`；
循环开头若 `flow.should_pause()` 则自旋等待到 `should_resume()`：

```rust
loop {
    while flow.should_pause() {
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    match reader.read(&mut buf) {
        Ok(0) | Err(_) => break,
        Ok(n) => {
            data_out(read_id.clone(), buf[..n].to_vec());
            flow.on_sent(n as u64);
        }
    }
}
```

并在 `route` 里加 `session.ack`：
```rust
"session.ack" => {
    let r = ht_proto::pb::SessionAckRequest::decode(&req.payload[..])
        .map_err(|e| dispatch::err(ht_proto::pb::ErrorCode::InvalidArgument,
                                   "err.proto.bad_payload", e.to_string()))?;
    self.sessions.ack(&r.session_id, r.bytes_consumed);
    Ok(ht_proto::pb::Empty {}.encode_to_vec())
}
```

`SessionManager::ack` 实现为查表后调 `flow.on_ack(n)`。

> **水位初值先用 `high = 1_048_576`（1MB）、`low = 262_144`（256KB）。
> 这两个数在 Task 9 由压测结果替换。**

- [ ] **Step 6: 写终端挂载**

`src/ui/browser/terminal/mount.ts`:
```typescript
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { FitAddon } from '@xterm/addon-fit'

export interface TerminalHandle {
  write(bytes: Uint8Array): void
  dispose(): void
}

export interface MountOptions {
  onInput(bytes: Uint8Array): void
  onResize(cols: number, rows: number): void
  /** 渲染层消费了多少字节，用于流控 */
  onConsumed(bytes: number): void
}

export function mountTerminal(el: HTMLElement, opts: MountOptions): TerminalHandle {
  const term = new Terminal({
    fontFamily: 'Menlo, Consolas, monospace',
    fontSize: 13,
    allowProposedApi: true,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el)

  // WebGL 失败要降级而不是白屏（产品文档 §17 承诺③）
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
  } catch {
    console.warn('WebGL renderer unavailable, falling back to DOM renderer')
  }

  fit.fit()
  opts.onResize(term.cols, term.rows)

  const enc = new TextEncoder()
  term.onData((s) => opts.onInput(enc.encode(s)))
  term.onResize(({ cols, rows }) => opts.onResize(cols, rows))

  return {
    write(bytes) {
      // xterm 写完后回调，这时才算真正消费，用于流控
      term.write(bytes, () => opts.onConsumed(bytes.byteLength))
    },
    dispose() {
      term.dispose()
    },
  }
}
```

- [ ] **Step 7: 在 boot.ts 里接起来并手动验证**

改 `src/ui/browser/boot.ts`：握手成功后调 `session.open`，
拿到 `sessionId` 后调 `window.ht.openDataPort(sessionId)`，
收到 `port:data` 后把数据接到 `mountTerminal`，
`onInput` 通过数据端口 `postMessage` 回去，`onConsumed` 通过控制端口发 `session.ack`。

- [ ] **Step 8: 运行并确认能交互**

Run: `pnpm dev`
Expected: 窗口里出现 shell 提示符；敲 `ls` 回车有输出；敲 `echo 中文测试` 能正确显示中文且宽度对齐

- [ ] **Step 9: 提交**

```bash
git add crates/ht-core src/ui/browser package.json
git commit -m "feat(terminal): xterm.js + WebGL 渲染与 XOFF/XON 流控"
```

---

## Task 7: 压测工具与三个数值实测

**Files:**
- Create: `bench/scenarios.ts`, `bench/run.ts`
- Create: `bench/results/.gitkeep`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 6 的完整链路
- Produces: `bench/results/<timestamp>.json`，字段 `{ scenario, p50InputLatencyMs, p99InputLatencyMs, throughputMBps, droppedFrames, highWater, lowWater, batchWindowMs }`

- [ ] **Step 1: 定义场景**

`bench/scenarios.ts`:
```typescript
export interface Scenario {
  name: string
  /** 并发会话数 */
  sessions: number
  /** 其中多少个疯狂刷屏 */
  flooders: number
  /** 刷屏用的命令 */
  floodCommand: string
  /** 持续秒数 */
  durationSec: number
}

export const scenarios: Scenario[] = [
  { name: 'single-idle',      sessions: 1,  flooders: 0, floodCommand: '',                     durationSec: 10 },
  { name: 'single-cat-binary', sessions: 1, flooders: 1, floodCommand: 'cat /dev/urandom | head -c 50000000', durationSec: 20 },
  { name: 'single-tail-log',  sessions: 1,  flooders: 1, floodCommand: 'yes hackerterm',        durationSec: 20 },
  { name: 'ten-mixed',        sessions: 10, flooders: 6, floodCommand: 'yes hackerterm',        durationSec: 30 },
]

/** 待扫描的候选参数组合 —— 这三个数值就是靠跑遍它们定下来的 */
export const paramGrid = {
  highWater:   [262_144, 1_048_576, 4_194_304],
  lowWaterRatio: [0.25],
  batchWindowMs: [0, 4, 8, 16],
}
```

- [ ] **Step 2: 写压测编排**

`bench/run.ts` 要做的事（用 Electron 的 `--headless` 不可行，因此走真实窗口）：

```typescript
import { writeFileSync, mkdirSync } from 'node:fs'
import { scenarios, paramGrid } from './scenarios'

/**
 * 用法：pnpm bench
 * 依次启动应用（通过环境变量注入参数），跑完每个场景后收集渲染层上报的指标。
 * 渲染层在 boot.ts 里监听 window.__htBenchCollect，把每次按键的往返延迟推进数组。
 */
interface Result {
  scenario: string
  highWater: number
  lowWater: number
  batchWindowMs: number
  p50InputLatencyMs: number
  p99InputLatencyMs: number
  throughputMBps: number
}

async function main() {
  const results: Result[] = []
  for (const s of scenarios) {
    for (const highWater of paramGrid.highWater) {
      for (const batchWindowMs of paramGrid.batchWindowMs) {
        const lowWater = Math.floor(highWater * paramGrid.lowWaterRatio[0])
        results.push(await runOnce(s, highWater, lowWater, batchWindowMs))
      }
    }
  }
  mkdirSync('bench/results', { recursive: true })
  const file = `bench/results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(file, JSON.stringify(results, null, 2))
  console.log(`wrote ${file}`)

  const best = results
    .filter((r) => r.scenario === 'ten-mixed')
    .sort((a, b) => a.p99InputLatencyMs - b.p99InputLatencyMs)[0]
  console.log('\n推荐参数（按最苛刻场景的 p99 输入延迟排序）:')
  console.log(`  highWater     = ${best.highWater}`)
  console.log(`  lowWater      = ${best.lowWater}`)
  console.log(`  batchWindowMs = ${best.batchWindowMs}`)
}

main()
```

`runOnce` 的实现：用 `child_process.spawn` 启动 `electron .`，透过环境变量
`HT_HIGH_WATER` / `HT_LOW_WATER` / `HT_BATCH_MS` 注入参数，
渲染层跑完把结果 JSON 打到 stdout，父进程解析。

- [ ] **Step 3: 让参数可由环境变量注入**

`crates/ht-core/src/session.rs` 里读环境变量作为水位默认值：
```rust
fn water_marks() -> (u64, u64) {
    let high = std::env::var("HT_HIGH_WATER").ok()
        .and_then(|s| s.parse().ok()).unwrap_or(1_048_576);
    let low = std::env::var("HT_LOW_WATER").ok()
        .and_then(|s| s.parse().ok()).unwrap_or(262_144);
    (high, low)
}
```

- [ ] **Step 4: 跑一次压测**

Run: `pnpm bench`
Expected: 生成 `bench/results/<ts>.json`，并在终端打印推荐的三个参数值

- [ ] **Step 5: 把实测值写回代码与协议文档**

把 `water_marks()` 的默认值改成实测推荐值；
把批处理窗口写进 `core-host/index.ts`；
在 `docs/superpowers/specs/2026-08-10-hackerterm-protocol.md` 的 §9 把
第 2、3 条从「待定」改为实测结论，附上 `bench/results/` 里的文件名作依据。

- [ ] **Step 6: 提交**

```bash
git add bench package.json crates/ht-core/src/session.rs src/core-host docs/superpowers/specs
git commit -m "test(bench): 压测工具与流控/批处理参数实测定值"
```

---

## Task 8: Windows ConPTY 验证

**Files:**
- Create: `docs/superpowers/verification/conpty.md`
- 可能 Modify: `crates/ht-core/Cargo.toml`（换 portable-pty fork）

**Interfaces:**
- Consumes: Task 6 的完整链路
- Produces: 验证记录文档；若不通过则产出依赖替换

- [ ] **Step 1: 在 Windows 机器上执行验证清单**

逐项在真实 Windows 10/11 上跑，把结果记进 `docs/superpowers/verification/conpty.md`：

| # | 验证项 | 通过标准 |
|---|---|---|
| 1 | PowerShell 能起 | 出现提示符，可交互 |
| 2 | CMD 能起 | 同上 |
| 3 | WSL 能起 | 同上 |
| 4 | Git Bash 能起 | 同上 |
| 5 | `type` 一个 50MB 二进制文件 | 不卡死、不假死 |
| 6 | 上一项过程中按 `Ctrl+C` | **立刻中断**，不是等输出跑完 |
| 7 | 拖动窗口改大小 | 内容重排，**无画面残留** |
| 8 | 输入 `Ctrl+A` / `Ctrl+E` / 方向键 / `Home` / `End` | 组合键正确传递，不丢 |
| 9 | 彩色输出（如 `ls --color`） | 颜色正确 |
| 10 | 中文路径与中文输出 | 不乱码，宽度对齐 |

- [ ] **Step 2: 若第 5-8 项任一不通过，换打了补丁的 fork**

把 `crates/ht-core/Cargo.toml` 的 `portable-pty = "0.8"` 换成带
`PASSTHROUGH_MODE` / `WIN32_INPUT_MODE` / `RESIZE_QUIRK` 三个补丁的 fork，
重跑清单。**只改依赖声明，不改 `session.rs` 的代码。**

- [ ] **Step 3: 若换 fork 后仍不通过，启用退路**

按技术方案 §1b 的备选：把 PTY 换成 `node-pty`，即
`SessionManager` 的 PTY 部分改由 core-host 侧的 node-pty 承担，
Rust 侧只保留流控与会话记账。**这是全项目唯一允许用 JS 的地方**，
须在 `conpty.md` 里写明触发了退路以及具体是哪几项不通过。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/verification/conpty.md crates/ht-core/Cargo.toml
git commit -m "test(conpty): Windows ConPTY 验证记录"
```

---

## Task 9: 中文输入法、字体连字与崩溃隔离验证

**Files:**
- Create: `docs/superpowers/verification/ime.md`, `font.md`, `crash-isolation.md`
- Modify: `src/ui/browser/terminal/mount.ts`（若字体验证需要调整配置）

**Interfaces:**
- Consumes: Task 6 的完整链路
- Produces: 三份验证记录

- [ ] **Step 1: 中文输入法验证**

在 Windows（微软拼音 + 搜狗）和 macOS（系统拼音）上各跑一遍，记进 `ime.md`：

| # | 验证项 | 通过标准 |
|---|---|---|
| 1 | 在终端里输入中文 | 候选框出现在**光标位置**，不是窗口左上角 |
| 2 | 输入过程中的拼音串 | 正确显示，不闪烁 |
| 3 | 选词上屏 | 文字正确进入终端 |
| 4 | 上屏后按退格 | 一次删一个汉字，不是删半个 |
| 5 | 输入法激活时按 `Ctrl+C` | 不误触发中断 |
| 6 | 切换 Tab 后再输入 | 输入法状态正确重置 |

- [ ] **Step 2: 字体与连字验证**

记进 `font.md`：

| # | 验证项 | 通过标准 |
|---|---|---|
| 1 | 亮色主题 vs 暗色主题 | **字重观感一致**，暗色下不发虚发胖 |
| 2 | 中英文混排 | 中文清晰，不比英文糊 |
| 3 | 中文等宽对齐 | 一个汉字正好两个英文字符宽 |
| 4 | 100% / 125% / 150% / 200% 缩放 | 各级都清晰不发虚 |
| 5 | **连字字体 + WebGL 渲染器** | 连字正确显示（xterm.js 有已知 issue #3303） |
| 6 | Emoji | 正确显示不错位 |

第 5 项若不通过：记录现象，并在 `mount.ts` 里加开关让用户可关闭连字，
把「WebGL + 连字」列为已知限制写进 `font.md`。

- [ ] **Step 3: 崩溃隔离验证**

记进 `crash-isolation.md`：

| # | 操作 | 通过标准 |
|---|---|---|
| 1 | 开 3 个 Tab，用任务管理器杀掉其中一个的渲染进程 | **其余 2 个照常工作** |
| 2 | 同上，被杀的 Tab | 显示「已崩溃，点击重开」，不是白屏 |
| 3 | 被杀 Tab 对应的 SSH/shell 会话 | **仍然存活**（Rust 核心里没死） |
| 4 | 点「重开」 | 重新接上原会话，滚动内容还在 |
| 5 | 杀掉 core utility process | 所有 Tab 显示核心断开，主进程不崩，能自动重启核心 |

第 4 项是 M0 的加分项，若未实现则记录为待办并在此说明。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/verification
git commit -m "test(verify): 中文输入法、字体连字、崩溃隔离验证记录"
```

---

## Task 10: Arrow 数据面骨架与分帧格式实测

**Files:**
- Create: `crates/ht-core/src/arrow_frame.rs`
- Create: `crates/ht-core/tests/arrow_frame.rs`
- Create: `bench/arrow.ts`
- Modify: `crates/ht-core/Cargo.toml`

**Interfaces:**
- Consumes: Task 5 的数据通道机制
- Produces:
  - Rust: `ht_core::arrow_frame::encode_batch(batch: &RecordBatch) -> Vec<u8>`、`frame_header_len() -> usize`
  - 结论：协议 §9 第 1 条「Arrow 数据块分帧格式」定稿

- [ ] **Step 1: 写失败的分帧往返测试**

`crates/ht-core/tests/arrow_frame.rs`:
```rust
use arrow::array::{Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use ht_core::arrow_frame::{decode_batch, encode_batch};
use std::sync::Arc;

fn sample() -> RecordBatch {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("name", DataType::Utf8, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(StringArray::from(vec![Some("a"), None, Some("c")])),
        ],
    )
    .unwrap()
}

#[test]
fn batch_survives_frame_roundtrip() {
    let batch = sample();
    let bytes = encode_batch(&batch).unwrap();
    let back = decode_batch(&bytes).unwrap();
    assert_eq!(back.num_rows(), 3);
    assert_eq!(back.num_columns(), 2);
    assert_eq!(back.schema().field(1).name(), "name");
}

#[test]
fn truncated_frame_errors_instead_of_panicking() {
    let batch = sample();
    let bytes = encode_batch(&batch).unwrap();
    let half = &bytes[..bytes.len() / 2];
    assert!(decode_batch(half).is_err());
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p ht-core --test arrow_frame`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现分帧**

给 `crates/ht-core/Cargo.toml` 加：
```toml
arrow = { version = "53", default-features = false, features = ["ipc"] }
```

`crates/ht-core/src/arrow_frame.rs`:
```rust
use arrow::ipc::reader::StreamReader;
use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;
use std::io::Cursor;

/// 用 Arrow 的 IPC Stream 格式做帧体。
/// Stream 格式自带 schema 和消息边界，不需要我们再套一层长度前缀。
pub fn encode_batch(batch: &RecordBatch) -> Result<Vec<u8>, arrow::error::ArrowError> {
    let mut buf = Vec::new();
    {
        let mut w = StreamWriter::try_new(&mut buf, &batch.schema())?;
        w.write(batch)?;
        w.finish()?;
    }
    Ok(buf)
}

pub fn decode_batch(bytes: &[u8]) -> Result<RecordBatch, arrow::error::ArrowError> {
    let mut r = StreamReader::try_new(Cursor::new(bytes), None)?;
    r.next()
        .ok_or_else(|| arrow::error::ArrowError::IpcError("empty stream".into()))?
}
```

在 `crates/ht-core/src/lib.rs` 加 `pub mod arrow_frame;`。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p ht-core --test arrow_frame`
Expected: PASS

- [ ] **Step 5: 实测大结果集的传输与解码耗时**

`bench/arrow.ts`：在渲染层用 `apache-arrow` 的 `tableFromIPC` 解码，
测 10 万行 × 10 列的往返耗时，分别记录：
Rust 侧编码耗时 · IPC 传输耗时 · JS 侧解码耗时 · 总计。

Run: `pnpm bench:arrow`
Expected: 输出三段耗时；**总计应在百毫秒量级，若超过 1 秒说明分帧方式有问题**

- [ ] **Step 6: 把结论写回协议文档**

在协议文档 §9 把第 1 条「Arrow 数据块分帧格式」改为定稿：
**采用 Arrow IPC Stream 格式，不额外套长度前缀**，附实测数据。

- [ ] **Step 7: 提交**

```bash
git add crates/ht-core bench docs/superpowers/specs
git commit -m "feat(arrow): 数据面分帧采用 Arrow IPC Stream，附实测依据"
```

---

## Self-Review

**1. 规格覆盖**

| M0 目标 | 对应任务 |
|---|---|
| Electron + Rust 链路打通 | Task 1、3、5 |
| 协议 Protobuf 双端生成 | Task 2 |
| PTY 会话 | Task 4 |
| 流控 | Task 6 |
| IPC 延迟实测 | Task 7 |
| ConPTY 验证 | Task 8 |
| 中文输入法验证 | Task 9 |
| 字体连字验证 | Task 9 |
| Tab 崩溃隔离验证 | Task 9 |
| 三个数值定稿 | Task 7（水位、批处理窗口）+ Task 10（Arrow 分帧） |
| UI 分层 lint 强制 | Task 5 Step 5、Step 9 |
| napi 表面极薄 | Task 1 Interfaces + Task 4 Step 7（共 4 个函数，均为通道级） |

**2. 占位符扫描**：Task 4 Step 4 出现过一个 `unimplemented!()`，已由 Step 5 明确要求替换为真实实现，不是留给实现者猜。其余无 TBD。

**3. 类型一致性**：`Core::new_with_data` 在 Task 4 Step 4 引入、Step 5 改签名（`Box` → `Arc`），Task 4 的测试文件在 Step 5 同步更新；`FlowWindow` 的四个方法名在 Task 6 的测试与实现中一致；`ProtocolClient` 的三个方法名在 Task 5 测试与实现中一致。

**已知缺口（有意留给后续里程碑）**：连接树、数据库、文件管理、服务器信息、补全、操作日志、主题、快捷键、i18n、授权检查均不在 M0 范围。
