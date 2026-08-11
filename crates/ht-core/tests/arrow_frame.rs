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
