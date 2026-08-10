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
