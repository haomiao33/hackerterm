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
