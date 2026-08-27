use std::error::Error;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bwg_core::{
    challenge::ChallengeId,
    pool_offer::{MaterialPoolOfferConfirmation, PoolFailoverProjection},
    progress::WorkSessionId,
};
use ring::digest;
use serde_json::{Value, json};

pub(crate) fn signature_digest(confirmation: &MaterialPoolOfferConfirmation) -> String {
    URL_SAFE_NO_PAD.encode(digest::digest(
        &digest::SHA256,
        confirmation.signed_pool_offers().signature().as_bytes(),
    ))
}

pub(crate) async fn fetch_lifecycle(
    authority_url: &str,
    challenge_id: &ChallengeId,
) -> Result<Value, Box<dyn Error>> {
    Ok(reqwest::get(format!(
        "{authority_url}/v0/challenges/{}/lifecycle",
        challenge_id.as_str(),
    ))
    .await?
    .error_for_status()?
    .json()
    .await?)
}

pub(crate) async fn complete_material_ceremony(
    authority_url: &str,
    challenge_id: &ChallengeId,
    signature_digest: &str,
) -> Result<String, Box<dyn Error>> {
    let begin_response = reqwest::Client::new()
        .post(format!(
            "{authority_url}/v0/challenges/{}/trusted-consent",
            challenge_id.as_str(),
        ))
        .json(&json!({
            "pool_offer_set_signature_sha256": signature_digest,
            "reason": "material_pool_terms",
            "authority_origin": "https://authority.example"
        }))
        .send()
        .await?;
    if !begin_response.status().is_success() {
        return Err(format!(
            "material ceremony begin failed with {}: {}",
            begin_response.status(),
            begin_response.text().await?,
        )
        .into());
    }
    let begin = begin_response.json::<Value>().await?;
    let ceremony_id = begin["ceremony_id"].as_str().ok_or("ceremony ID")?;
    let finish_response = reqwest::Client::new()
        .post(format!(
            "{authority_url}/v0/challenges/{}/trusted-consent/{ceremony_id}",
            challenge_id.as_str(),
        ))
        .json(&json!({ "credential": "valid" }))
        .send()
        .await?;
    if !finish_response.status().is_success() {
        return Err(format!(
            "material ceremony finish failed with {}: {}",
            finish_response.status(),
            finish_response.text().await?,
        )
        .into());
    }
    let finish = finish_response.json::<Value>().await?;
    Ok(finish["trusted_consent_receipt"]
        .as_str()
        .ok_or("trusted consent receipt")?
        .to_owned())
}

pub(crate) fn assert_public_lifecycle_is_identity_free<const N: usize>(
    lifecycle: &Value,
    sessions: [&WorkSessionId; N],
) -> Result<(), Box<dyn Error>> {
    let encoded = serde_json::to_string(lifecycle)?;
    for session in sessions {
        let serialized = serde_json::to_value(session)?;
        let session_id = serialized.as_str().ok_or("serialized session ID")?;
        assert!(!encoded.contains(session_id));
    }
    let lowercase = encoded.to_ascii_lowercase();
    for prohibited in [
        "worker",
        "device",
        "credential",
        "secret",
        "payout_destination",
    ] {
        assert!(!lowercase.contains(prohibited));
    }
    Ok(())
}

pub(crate) fn assert_failover_projection_is_metadata_only(
    projection: &PoolFailoverProjection,
) -> Result<(), Box<dyn Error>> {
    let encoded = serde_json::to_string(projection)?;
    for prohibited in [
        "worker",
        "device",
        "credential",
        "secret",
        "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
    ] {
        assert!(!encoded.contains(prohibited));
    }
    Ok(())
}
