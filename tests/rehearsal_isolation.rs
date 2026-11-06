//! The rehearsal's synthetic hard-target share and miner control exist only in the
//! rehearsal composition (Ticket 06, ADR-0109). No library module, production binary
//! or production route may name them, so none can reach them.

use std::{
    fs,
    path::{Path, PathBuf},
};

const REHEARSAL_ONLY: [&str; 5] = [
    "rehearsal_synthetic_share",
    "/synthetic-share",
    "/miner/start",
    "/miner/stop",
    "production-path-rehearsal",
];

fn manifest_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn rust_sources(directory: &Path) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    let entries = fs::read_dir(directory).expect("source directory is readable");
    for entry in entries {
        let path = entry.expect("source entry is readable").path();
        if path.is_dir() {
            sources.extend(rust_sources(&path));
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            sources.push(path);
        }
    }
    sources
}

#[test]
fn rehearsal_composition_defines_the_synthetic_share_and_miner_control() {
    // Arrange
    let synthetic = manifest_path("examples/production-path-rehearsal/synthetic.rs");
    let control = manifest_path("examples/production-path-rehearsal/control.rs");

    // Act
    let synthetic_source = fs::read_to_string(synthetic).expect("synthetic share source exists");
    let control_source = fs::read_to_string(control).expect("control source exists");

    // Assert
    assert!(synthetic_source.contains("\"rehearsal_synthetic_share\""));
    assert!(control_source.contains("/synthetic-share"));
    assert!(control_source.contains("/miner/start"));
}

#[test]
fn no_library_or_production_binary_source_names_rehearsal_only_paths() {
    // Arrange
    let sources = rust_sources(&manifest_path("src"));

    // Act
    let leaks: Vec<String> = sources
        .iter()
        .flat_map(|path| {
            let text = fs::read_to_string(path).expect("source file is readable");
            REHEARSAL_ONLY
                .iter()
                .filter(move |needle| text.contains(**needle))
                .map(move |needle| format!("{} names {needle}", path.display()))
        })
        .collect();

    // Assert
    assert!(!sources.is_empty());
    assert!(leaks.is_empty(), "rehearsal-only paths leaked: {leaks:?}");
}

#[test]
fn production_reference_page_does_not_import_the_rehearsal_device() {
    // Arrange
    let production_page = [
        "web/reference-account-page.ts",
        "web/reference-account-page-entry.ts",
        "web/reference-claimant-transport.ts",
    ];

    // Act
    let leaks: Vec<&str> = production_page
        .into_iter()
        .filter(|relative| {
            fs::read_to_string(manifest_path(relative))
                .expect("reference page source exists")
                .contains("production-path-rehearsal")
        })
        .collect();

    // Assert
    assert!(
        leaks.is_empty(),
        "reference page imports rehearsal code: {leaks:?}"
    );
}
