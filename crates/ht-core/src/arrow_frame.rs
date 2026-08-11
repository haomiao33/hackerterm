//! Arrow 数据面分帧：数据库查询结果从 Rust 传到渲染进程表格的编解码。
//!
//! 选定方案：Arrow 的 IPC Stream 格式（`arrow::ipc::writer::StreamWriter` /
//! `arrow::ipc::reader::StreamReader`）。Stream 格式自带 schema 和消息边界，
//! 不需要我们再套一层长度前缀。
//!
//! 本文件目前只是骨架（Task 10 阶段一：接口与骨架），两个函数体留 `todo!()`，
//! 由后续阶段补齐实现并配测试往返验证。

use arrow::error::ArrowError;
use arrow::record_batch::RecordBatch;

// 骨架阶段（Task 10 阶段一）函数体是 `todo!()`，尚未真正调用下面两个类型；
// 保留导入是为了让后续阶段直接实现，不用回头补 `use`。
#[allow(unused_imports)]
use arrow::ipc::reader::StreamReader;
#[allow(unused_imports)]
use arrow::ipc::writer::StreamWriter;
#[allow(unused_imports)]
use std::io::Cursor;

/// 把一个 `RecordBatch` 编码成 Arrow IPC Stream 格式的字节序列。
pub fn encode_batch(batch: &RecordBatch) -> Result<Vec<u8>, ArrowError> {
    todo!("Task 10 后续阶段实现：用 StreamWriter 把 {batch:?} 编码为 IPC Stream 字节")
}

/// 从 Arrow IPC Stream 格式的字节序列解出一个 `RecordBatch`。
pub fn decode_batch(bytes: &[u8]) -> Result<RecordBatch, ArrowError> {
    todo!("Task 10 后续阶段实现：用 StreamReader 从 {} 字节的 IPC Stream 解出 RecordBatch", bytes.len())
}
