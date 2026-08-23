use serde_json::{Value, json};

use super::*;
use crate::governance::{GovernanceContext, GovernanceError};

const EXPORT_ID: &str = "00000000-0000-4000-8000-000000000123";

#[test]
fn export_start_rejects_zero_cutoff() {
    // Arrange
    let key = "ERERERERERERERERERERERERERERERERERERERERERE";

    // Act
    let result = ExportStartRequest::new(0, 1, key);

    // Assert
    assert!(matches!(
        result,
        Err(GovernanceError::InvalidPlanningInstant)
    ));
}

#[test]
fn export_start_rejects_page_size_outside_bounds() {
    // Arrange
    let key = "ERERERERERERERERERERERERERERERERERERERERERE";

    // Act
    let zero = ExportStartRequest::new(1, 0, key);
    let too_large = ExportStartRequest::new(1, 1_001, key);

    // Assert
    assert!(matches!(zero, Err(GovernanceError::InvalidExportPageSize)));
    assert!(matches!(
        too_large,
        Err(GovernanceError::InvalidExportPageSize)
    ));
}

#[test]
fn export_resume_rejects_invalid_identifier() {
    // Arrange
    let invalid = "not-an-export-id";

    // Act
    let result = ExportResumeRequest::new(invalid, 0, 1);

    // Assert
    assert!(matches!(result, Err(GovernanceError::InvalidExportId)));
}

#[test]
fn export_line_has_canonical_envelope_order_and_newline() -> Result<(), Box<dyn std::error::Error>>
{
    // Arrange
    let export_id = Uuid::parse_str(EXPORT_ID)?;

    // Act
    let line = export_line(
        GovernanceContext::GateAuthority,
        export_id,
        100,
        1,
        "challenge_summary",
        json!({ "x": 1 }),
    )?;

    // Assert
    assert_eq!(
        String::from_utf8(line)?,
        concat!(
            "{\"schema_version\":\"bwg-governance-v1\",",
            "\"context\":\"gate_authority\",",
            "\"export_id\":\"00000000-0000-4000-8000-000000000123\",",
            "\"snapshot_cutoff_unix_seconds\":100,",
            "\"sequence\":1,",
            "\"record_type\":\"challenge_summary\",",
            "\"payload\":{\"x\":1}}\n"
        )
    );

    Ok(())
}

#[test]
fn empty_export_uses_the_sha256_empty_vector_and_manifest_sequence_one()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let export_id = Uuid::parse_str(EXPORT_ID)?;
    let key = PseudonymizationKey([0x11; 32]);

    // Act
    let frozen = freeze_export(
        GovernanceContext::GateAuthority,
        export_id,
        100,
        &key,
        Vec::new(),
    )?;
    let manifest = manifest_line(
        GovernanceContext::GateAuthority,
        export_id,
        100,
        0,
        frozen.total_bytes,
        &frozen.content_sha256,
        frozen.counts,
    )?;
    let manifest = serde_json::from_slice::<Value>(&manifest)?;

    // Assert
    assert!(frozen.items.is_empty());
    assert_eq!(frozen.total_bytes, 0);
    assert_eq!(
        frozen.content_sha256,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(manifest["sequence"], 1);
    assert_eq!(manifest["payload"]["total_items"], 0);

    Ok(())
}
