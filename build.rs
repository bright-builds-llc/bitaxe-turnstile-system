//! Generates the Gate Authority to Pool Adapter gRPC code with a vendored `protoc`,
//! so a build needs no system Protobuf compiler.

const POOL_ADAPTER_PROTO: &str = "proto/bwg/pool_adapter/v1/pool_adapter.proto";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed={POOL_ADAPTER_PROTO}");
    let mut config = tonic_prost_build::Config::new();
    config.protoc_executable(protoc_bin_vendored::protoc_bin_path()?);
    tonic_prost_build::configure().compile_with_config(
        config,
        &[POOL_ADAPTER_PROTO],
        &["proto"],
    )?;
    Ok(())
}
