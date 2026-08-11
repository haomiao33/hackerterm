//! Arrow 数据面分帧：数据库查询结果从 Rust 传到渲染进程表格的编解码。
//!
//! 选定方案：Arrow 的 IPC Stream 格式（`arrow::ipc::writer::StreamWriter` /
//! `arrow::ipc::reader::StreamReader`）。Stream 格式自带 schema 和消息边界，
//! 不需要我们再套一层长度前缀。

use arrow::error::ArrowError;
use arrow::ipc::reader::StreamReader;
use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;
use std::io::Cursor;

/// 把一个 `RecordBatch` 编码成 Arrow IPC Stream 格式的字节序列。
pub fn encode_batch(batch: &RecordBatch) -> Result<Vec<u8>, ArrowError> {
    let mut buf = Vec::new();
    {
        let mut w = StreamWriter::try_new(&mut buf, &batch.schema())?;
        w.write(batch)?;
        w.finish()?;
    }
    Ok(buf)
}

/// 从 Arrow IPC Stream 格式的字节序列解出一个 `RecordBatch`。
pub fn decode_batch(bytes: &[u8]) -> Result<RecordBatch, ArrowError> {
    let mut r = StreamReader::try_new(Cursor::new(bytes), None)?;
    r.next()
        .ok_or_else(|| ArrowError::IpcError("empty stream".into()))?
}
