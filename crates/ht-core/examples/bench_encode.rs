//! Task 10 Step 5: 实测 `encode_batch` 对大结果集的编码耗时与体积。
//!
//! 构造一个模拟数据库查询结果的 `RecordBatch`（`BENCH_ROWS` 行 × `BENCH_COLS` 列，
//! 整数列与字符串列各半，贴近真实查询结果的列类型分布），编码为 Arrow IPC Stream
//! 字节，把耗时和字节数打印成一行 JSON 到 stdout，并把字节写到命令行指定的路径，
//! 供 `bench/arrow.ts` 读取后在 Node 里用 `apache-arrow` 计时解码。
//!
//! Run: `cargo run --release -p ht-core --example bench_encode -- <output-path>`

use arrow::array::{Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use ht_core::arrow_frame::encode_batch;
use std::io::Write;
use std::sync::Arc;
use std::time::Instant;

/// 行数：贴近 brief 要求的“数据库查询可能返回几十万行”场景，取 10 万行做代表性实测。
const BENCH_ROWS: usize = 100_000;
/// 整数列数（另有等量字符串列，合计 `BENCH_COLS` 列）。
const BENCH_INT_COLS: usize = 5;
/// 字符串列数。
const BENCH_STRING_COLS: usize = 5;

fn sample_batch() -> RecordBatch {
    let mut fields = Vec::new();
    let mut columns: Vec<Arc<dyn arrow::array::Array>> = Vec::new();

    for c in 0..BENCH_INT_COLS {
        fields.push(Field::new(format!("int_col_{c}"), DataType::Int64, false));
        let values: Vec<i64> = (0..BENCH_ROWS).map(|r| r as i64).collect();
        columns.push(Arc::new(Int64Array::from(values)));
    }
    for c in 0..BENCH_STRING_COLS {
        fields.push(Field::new(format!("str_col_{c}"), DataType::Utf8, true));
        let values: Vec<Option<String>> =
            (0..BENCH_ROWS).map(|r| Some(format!("row-{r}-value"))).collect();
        columns.push(Arc::new(StringArray::from(values)));
    }

    let schema = Arc::new(Schema::new(fields));
    RecordBatch::try_new(schema, columns).expect("well-formed bench batch")
}

fn main() {
    let out_path = std::env::args().nth(1).expect("usage: bench_encode <output-path>");

    let batch = sample_batch();

    let start = Instant::now();
    let bytes = encode_batch(&batch).expect("encode_batch should succeed on a well-formed batch");
    let encode_ms = start.elapsed().as_secs_f64() * 1000.0;

    let mut file = std::fs::File::create(&out_path).expect("create bench output file");
    file.write_all(&bytes).expect("write bench frame bytes");

    println!(
        "{{\"rows\":{},\"cols\":{},\"bytes\":{},\"encode_ms\":{encode_ms:.3}}}",
        batch.num_rows(),
        batch.num_columns(),
        bytes.len(),
    );
}
