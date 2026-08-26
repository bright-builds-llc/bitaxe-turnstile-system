#![allow(dead_code)]

use std::error::Error;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bwg_core::{
    authority::{
        AuthorityPublicConfig, CLIENT_ID_HEADER, Config, DeploymentEnvironment, ServiceCredential,
    },
    challenge::ActionPolicy,
};
use ring::digest;
use serde_json::{Value, json};

use crate::authority_key_support::{CLAIMANT_PUBLIC_JWK, authority_keys};

pub(crate) const CLIENT_ID: &str = "trusted-consent-service";
pub(crate) const SERVICE_SECRET: &str = "trusted-consent-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA5dH0sJ";
const SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

pub(crate) async fn issue_elevated_challenge(authority_url: &str) -> Result<Value, Box<dyn Error>> {
    issue_challenge(
        authority_url,
        ActionPolicy::ACCOUNT_CREATION_ELEVATED_V1,
        "action_trusted_consent_01",
    )
    .await
}

pub(crate) async fn issue_challenge(
    authority_url: &str,
    action_policy: &str,
    action_reference: &str,
) -> Result<Value, Box<dyn Error>> {
    Ok(reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({
            "action_policy": action_policy,
            "action_reference": action_reference,
            "claimant_key": CLAIMANT_PUBLIC_JWK
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

pub(crate) fn offer_digest(challenge: &Value) -> Result<String, Box<dyn Error>> {
    let signature = challenge["pool_offers"]["signature"]
        .as_str()
        .ok_or("Pool Offer signature is missing")?;
    Ok(URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, signature.as_bytes())))
}

pub(crate) fn authority_config() -> Result<Config, Box<dyn Error>> {
    Ok(authority_config_without_signer()?
        .with_signing_key_seed("authority-a".to_owned(), SIGNING_SEED)?)
}

pub(crate) fn authority_config_without_signer() -> Result<Config, Box<dyn Error>> {
    let credential = ServiceCredential::new(
        CLIENT_ID,
        SERVICE_SECRET,
        DeploymentEnvironment::Development,
        "https://relying.example".to_owned(),
        vec!["https://app.relying.example".to_owned()],
        vec![
            ActionPolicy::AccountCreationStandardV1,
            ActionPolicy::AccountCreationElevatedV1,
        ],
    )?;
    let public = AuthorityPublicConfig::new(
        "https://authority.example",
        "https://authority.example",
        authority_keys()?,
        "https://authority.example/policies/operator",
        "https://authority.example/privacy",
        "https://authority.example/terms",
    )?;
    Ok(Config::new(
        DeploymentEnvironment::Development,
        vec![credential],
        public,
    )?)
}
