#![deny(clippy::all)]

use ht_core::Core;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi_derive::napi;
use std::sync::{Arc, OnceLock};

static CORE: OnceLock<Core> = OnceLock::new();
static DATA_OUT: OnceLock<ThreadsafeFunction<(String, Vec<u8>), ErrorStrategy::Fatal>> = OnceLock::new();

/// 注册出站回调并创建 Core。整个进程只调用一次。
#[napi]
pub fn start(env: Env, on_message: JsFunction) -> Result<()> {
    let mut tsfn: ThreadsafeFunction<Vec<u8>, ErrorStrategy::Fatal> = on_message
        .create_threadsafe_function(0, |ctx| Ok(vec![Buffer::from(ctx.value)]))?;
    // 不 unref 的话，这个 tsfn 会一直持有一个活跃句柄，Node 事件循环永远
    // 不会自然清空，进程（以及 `node --test`）会挂起不退出。
    tsfn.unref(&env)?;

    let core = Core::new_with_data(
        Arc::new(move |bytes| {
            tsfn.call(bytes, ThreadsafeFunctionCallMode::NonBlocking);
        }),
        Box::new(move |sid, bytes| {
            if let Some(data_tsfn) = DATA_OUT.get() {
                data_tsfn.call((sid, bytes), ThreadsafeFunctionCallMode::NonBlocking);
            }
        }),
    );

    CORE.set(core)
        .map_err(|_| Error::from_reason("start() called twice"))?;
    Ok(())
}

/// 入站字节，转发给 Core 分发处理。
#[napi]
pub fn send(buf: Buffer) -> Result<()> {
    CORE.get()
        .ok_or_else(|| Error::from_reason("start() not called"))?
        .handle_inbound(&buf);
    Ok(())
}

/// 注册数据面出站回调。**必须在 `start()` 之前调用**，由 JS 侧保证顺序。
#[napi]
pub fn start_data(on_data: JsFunction) -> Result<()> {
    let tsfn: ThreadsafeFunction<(String, Vec<u8>), ErrorStrategy::Fatal> = on_data
        .create_threadsafe_function(
            0,
            |ctx: ThreadSafeCallContext<(String, Vec<u8>)>| {
                let (sid, bytes) = ctx.value;
                Ok(vec![
                    ctx.env.create_string(&sid)?.into_unknown(),
                    ctx.env.create_buffer_with_data(bytes)?.into_unknown(),
                ])
            },
        )?;
    DATA_OUT.set(tsfn).map_err(|_| Error::from_reason("start_data() called twice"))?;
    Ok(())
}

/// 渲染进程键盘输入，直接写数据面，不经过 protobuf。
#[napi]
pub fn send_data(session_id: String, buf: Buffer) -> Result<()> {
    CORE.get()
        .ok_or_else(|| Error::from_reason("start() not called"))?
        .write_data(&session_id, &buf);
    Ok(())
}
