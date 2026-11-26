use bwg_core::pool_offer::{PoolOfferError, PoolSelection};
use serde::Deserialize;

const VECTORS: &str = include_str!("../conformance/bwg-0.1/payout-commitment-vectors.json");

#[derive(Deserialize)]
struct CommitmentVectors {
    profile: String,
    domain: String,
    commitments: Vec<CommitmentVector>,
    refused_selections: Vec<RefusedSelection>,
}

#[derive(Deserialize)]
struct CommitmentVector {
    id: String,
    challenge_id: String,
    pool_offer_id: String,
    payout_destination_type: String,
    payout_destination: String,
    commitment_sha256_hex: String,
}

#[derive(Deserialize)]
struct RefusedSelection {
    id: String,
    pool_offer_id: String,
    payout_destination_type: String,
    payout_destination: String,
    expected_error: RefusalCode,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RefusalCode {
    InvalidPayoutSelection,
    InvalidPoolOffer,
}

fn refusal(error: &PoolOfferError) -> Option<RefusalCode> {
    match error {
        PoolOfferError::InvalidPayoutSelection => Some(RefusalCode::InvalidPayoutSelection),
        PoolOfferError::InvalidPoolOffer => Some(RefusalCode::InvalidPoolOffer),
        _ => None,
    }
}

fn selection(
    pool_offer_id: &str,
    destination_type: &str,
    destination: &str,
) -> Result<PoolSelection, Box<dyn std::error::Error>> {
    match destination_type {
        "bitcoin_mainnet_address" => Ok(PoolSelection::bitcoin_address(
            pool_offer_id.to_owned(),
            destination.to_owned(),
        )?),
        "approved_beneficiary" => Ok(PoolSelection::approved_beneficiary(
            pool_offer_id.to_owned(),
            destination.to_owned(),
        )?),
        other => Err(format!("unknown destination type {other}").into()),
    }
}

#[test]
fn payout_commitment_vectors_name_the_bwg_0_1_profile_and_domain() -> Result<(), serde_json::Error>
{
    // Act
    let vectors: CommitmentVectors = serde_json::from_str(VECTORS)?;

    // Assert
    assert_eq!(vectors.profile, "BWG/0.1");
    assert_eq!(vectors.domain, "BWG/0.1 pool selection commitment");
    Ok(())
}

#[test]
fn payout_commitments_follow_the_vectors() -> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let vectors: CommitmentVectors = serde_json::from_str(VECTORS)?;

    for vector in vectors.commitments {
        let selection = selection(
            &vector.pool_offer_id,
            &vector.payout_destination_type,
            &vector.payout_destination,
        )?;

        // Act
        let commitment = selection.commitment(&vector.challenge_id);

        // Assert
        assert_eq!(commitment, vector.commitment_sha256_hex, "{}", vector.id);
        assert!(
            !commitment.contains(&vector.payout_destination),
            "{}",
            vector.id
        );
    }
    Ok(())
}

#[test]
fn refused_selections_follow_the_vectors() -> Result<(), serde_json::Error> {
    // Arrange
    let vectors: CommitmentVectors = serde_json::from_str(VECTORS)?;

    for vector in vectors.refused_selections {
        // Act
        let result = match vector.payout_destination_type.as_str() {
            "bitcoin_mainnet_address" => PoolSelection::bitcoin_address(
                vector.pool_offer_id.clone(),
                vector.payout_destination.clone(),
            ),
            _ => PoolSelection::approved_beneficiary(
                vector.pool_offer_id.clone(),
                vector.payout_destination.clone(),
            ),
        };

        // Assert
        assert_eq!(
            result.as_ref().err().and_then(refusal),
            Some(vector.expected_error),
            "{}",
            vector.id
        );
    }
    Ok(())
}
