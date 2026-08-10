#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::OnceLock;

static OUTBOUND: OnceLock<ThreadsafeFunction<Vec<u8>, ErrorStrategy::Fatal>> = OnceLock::new();

/// 注册出站回调。整个进程只调用一次。
#[napi]
pub fn start(env: Env, on_message: JsFunction) -> Result<()> {
    let mut tsfn: ThreadsafeFunction<Vec<u8>, ErrorStrategy::Fatal> = on_message
        .create_threadsafe_function(0, |ctx| {
            Ok(vec![Buffer::from(ctx.value)])
        })?;
    // 不 unref 的话，这个 tsfn 会一直持有一个活跃句柄，Node 事件循环永远
    // 不会自然清空，进程（以及 `node --test`）会挂起不退出。
    tsfn.unref(&env)?;
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
