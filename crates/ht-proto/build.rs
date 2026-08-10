fn main() {
    println!("cargo:rerun-if-changed=../../proto/hackerterm.proto");
    prost_build::compile_protos(
        &["../../proto/hackerterm.proto"],
        &["../../proto"],
    )
    .expect("failed to compile protos");
}
