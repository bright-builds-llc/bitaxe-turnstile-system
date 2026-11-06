//! The shared refusal vectors every Pool Adapter wire adapter reproduces (ADR-0108).

use std::error::Error;

use bwg_core::{
    progress::AcceptedWorkRefusal,
    stratum_v1::{MAX_DELIVERY_RETRY_SECONDS, retry_delay_seconds},
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vectors {
    refusals: Vec<RefusalVector>,
    outage: OutageVector,
}

#[derive(Deserialize)]
struct RefusalVector {
    reason: String,
    terminal: bool,
}

#[derive(Deserialize)]
struct OutageVector {
    terminal: bool,
    retry_delays_seconds: Vec<u64>,
    max_retry_delay_seconds: u64,
}

fn vectors() -> Result<Vectors, Box<dyn Error>> {
    Ok(serde_json::from_str(include_str!(
        "../conformance/bwg-0.1/accepted-work-refusal-vectors.json"
    ))?)
}

#[test]
fn every_refusal_reason_has_one_terminal_vector_in_order() -> Result<(), Box<dyn Error>> {
    // Arrange
    let vectors = vectors()?;

    // Act
    let codes: Vec<&str> = AcceptedWorkRefusal::ALL
        .iter()
        .map(|refusal| refusal.code())
        .collect();
    let vector_codes: Vec<&str> = vectors
        .refusals
        .iter()
        .map(|vector| vector.reason.as_str())
        .collect();

    // Assert
    assert_eq!(vector_codes, codes);
    assert!(vectors.refusals.iter().all(|vector| vector.terminal));
    Ok(())
}

#[test]
fn refusal_codes_round_trip_through_serde() -> Result<(), Box<dyn Error>> {
    // Arrange
    let vectors = vectors()?;

    // Act
    let parsed = vectors
        .refusals
        .iter()
        .map(|vector| serde_json::from_value(serde_json::Value::String(vector.reason.clone())))
        .collect::<Result<Vec<AcceptedWorkRefusal>, _>>()?;

    // Assert
    assert_eq!(parsed, AcceptedWorkRefusal::ALL.to_vec());
    for refusal in AcceptedWorkRefusal::ALL {
        assert_eq!(serde_json::to_value(refusal)?, refusal.code());
    }
    Ok(())
}

#[test]
fn outage_retries_follow_the_shared_backoff() -> Result<(), Box<dyn Error>> {
    // Arrange
    let vectors = vectors()?;

    // Act
    let delays: Vec<u64> = (1..=u32::try_from(vectors.outage.retry_delays_seconds.len())?)
        .map(retry_delay_seconds)
        .collect();

    // Assert
    assert!(!vectors.outage.terminal);
    assert_eq!(delays, vectors.outage.retry_delays_seconds);
    assert_eq!(
        vectors.outage.max_retry_delay_seconds,
        MAX_DELIVERY_RETRY_SECONDS
    );
    Ok(())
}
