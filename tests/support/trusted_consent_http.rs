#![allow(dead_code)]

use std::error::Error;

use bwg_core::authority::CLIENT_ID_HEADER;
use serde_json::{Value, json};

pub(crate) async fn begin_ceremony(
    authority_url: &str,
    challenge_id: &str,
    offer_digest: &str,
) -> Result<Value, Box<dyn Error>> {
    Ok(begin_ceremony_response(
        authority_url,
        challenge_id,
        offer_digest,
        "https://authority.example",
    )
    .await?
    .error_for_status()?
    .json()
    .await?)
}

pub(crate) async fn begin_ceremony_response(
    authority_url: &str,
    challenge_id: &str,
    offer_digest: &str,
    authority_origin: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    reqwest::Client::new()
        .post(format!(
            "{authority_url}/v0/challenges/{challenge_id}/trusted-consent"
        ))
        .json(&json!({
            "pool_offer_set_signature_sha256": offer_digest,
            "reason": "elevated_work",
            "authority_origin": authority_origin
        }))
        .send()
        .await
}

pub(crate) async fn finish_ceremony(
    authority_url: &str,
    challenge_id: &str,
    ceremony_id: &str,
) -> Result<Value, Box<dyn Error>> {
    Ok(
        finish_ceremony_response(authority_url, challenge_id, ceremony_id)
            .await?
            .error_for_status()?
            .json()
            .await?,
    )
}

pub(crate) async fn finish_ceremony_response(
    authority_url: &str,
    challenge_id: &str,
    ceremony_id: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    reqwest::Client::new()
        .post(format!(
            "{authority_url}/v0/challenges/{challenge_id}/trusted-consent/{ceremony_id}"
        ))
        .json(&json!({ "credential": "valid" }))
        .send()
        .await
}

pub(crate) async fn cancel_challenge(
    authority_url: &str,
    challenge_id: &str,
    client_id: &str,
    service_secret: &str,
) -> Result<Value, Box<dyn Error>> {
    Ok(reqwest::Client::new()
        .post(format!(
            "{authority_url}/v0/challenges/{challenge_id}/cancel"
        ))
        .header(CLIENT_ID_HEADER, client_id)
        .bearer_auth(service_secret)
        .json(&json!({ "confirm_progress_loss": true }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}
