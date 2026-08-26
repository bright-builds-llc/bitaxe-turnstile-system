use serde::{Deserialize, Serialize};

use super::{
    TrustedConsentBinding, TrustedConsentCeremony, TrustedConsentCeremonyId, TrustedConsentError,
};
use crate::{
    crypto_profile::{AuthorityJwk, AuthoritySigningKey, verify_authority_payload},
    lifecycle::signed_artifact_is_time_valid,
};

const TRUSTED_CONSENT_RECEIPT_TYPE: &str = "bwg-trusted-consent+jws";
const PROTOCOL_VERSION: &str = "BWG/0.1";

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TrustedConsentReceiptClaims {
    iss: String,
    jti: String,
    challenge_id: String,
    disclosure_digest_sha256: String,
    pool_offer_set_signature_sha256: String,
    reason: String,
    authority_origin: String,
    webauthn: TrustedConsentReceiptWebauthn,
    iat: u64,
    exp: u64,
    bwg_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TrustedConsentReceiptWebauthn {
    user_present: bool,
    user_verified: bool,
    attestation: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedTrustedConsentReceipt {
    claims: TrustedConsentReceiptClaims,
}

pub(crate) struct TrustedConsentLeaseAdmission<'a> {
    compact_receipt: &'a str,
    verified: VerifiedTrustedConsentReceipt,
}

impl<'a> TrustedConsentLeaseAdmission<'a> {
    pub(crate) fn new(compact_receipt: &'a str, verified: VerifiedTrustedConsentReceipt) -> Self {
        Self {
            compact_receipt,
            verified,
        }
    }

    pub(crate) fn compact_receipt(&self) -> &str {
        self.compact_receipt
    }

    pub(crate) fn ceremony_id(&self) -> &str {
        self.verified.ceremony_id()
    }

    pub(crate) fn challenge_id(&self) -> &str {
        self.verified.challenge_id()
    }

    pub(crate) fn expires_at_unix_seconds(&self) -> u64 {
        self.verified.expires_at_unix_seconds()
    }
}

impl VerifiedTrustedConsentReceipt {
    pub(crate) fn ceremony_id(&self) -> &str {
        &self.claims.jti
    }

    pub(crate) fn challenge_id(&self) -> &str {
        &self.claims.challenge_id
    }

    #[cfg(test)]
    pub(crate) fn issued_at_unix_seconds(&self) -> u64 {
        self.claims.iat
    }

    pub(crate) fn expires_at_unix_seconds(&self) -> u64 {
        self.claims.exp
    }
}

pub(crate) fn sign_trusted_consent_receipt(
    signer: &AuthoritySigningKey,
    issuer: &str,
    ceremony: &TrustedConsentCeremony,
) -> Result<String, TrustedConsentError> {
    let issued_at = ceremony
        .verified_at_unix_seconds()
        .ok_or(TrustedConsentError::ReceiptUnavailable)?;
    let binding = ceremony.binding();
    let claims = TrustedConsentReceiptClaims {
        iss: issuer.to_owned(),
        jti: ceremony.ceremony_id().as_str().to_owned(),
        challenge_id: binding.challenge_id().to_owned(),
        disclosure_digest_sha256: binding.disclosure_digest_sha256().to_owned(),
        pool_offer_set_signature_sha256: binding.pool_offer_set_signature_sha256().to_owned(),
        reason: binding.reason().as_str().to_owned(),
        authority_origin: binding.authority_origin().to_owned(),
        webauthn: TrustedConsentReceiptWebauthn {
            user_present: true,
            user_verified: true,
            attestation: "trusted_non_self".to_owned(),
        },
        iat: issued_at,
        exp: binding.challenge_expires_at_unix_seconds(),
        bwg_version: PROTOCOL_VERSION.to_owned(),
    };
    validate_receipt_claims(&claims, issuer, binding, issued_at)?;
    signer
        .sign_authority_payload(TRUSTED_CONSENT_RECEIPT_TYPE, &claims)
        .map_err(|_| TrustedConsentError::ReceiptUnavailable)
}

pub(crate) fn verify_trusted_consent_receipt(
    compact_receipt: &str,
    expected_issuer: &str,
    expected_binding: &TrustedConsentBinding,
    trusted_keys: &[AuthorityJwk],
    now_unix_seconds: u64,
) -> Result<VerifiedTrustedConsentReceipt, TrustedConsentError> {
    let (_, claims) = verify_authority_payload::<TrustedConsentReceiptClaims>(
        compact_receipt,
        TRUSTED_CONSENT_RECEIPT_TYPE,
        trusted_keys,
    )
    .map_err(|_| TrustedConsentError::InvalidReceipt)?;
    validate_receipt_claims(&claims, expected_issuer, expected_binding, now_unix_seconds)?;
    Ok(VerifiedTrustedConsentReceipt { claims })
}

fn validate_receipt_claims(
    claims: &TrustedConsentReceiptClaims,
    expected_issuer: &str,
    expected_binding: &TrustedConsentBinding,
    now_unix_seconds: u64,
) -> Result<(), TrustedConsentError> {
    TrustedConsentCeremonyId::try_from(claims.jti.clone())?;
    if claims.iss != expected_issuer
        || claims.challenge_id != expected_binding.challenge_id()
        || claims.disclosure_digest_sha256 != expected_binding.disclosure_digest_sha256()
        || claims.pool_offer_set_signature_sha256
            != expected_binding.pool_offer_set_signature_sha256()
        || claims.reason != expected_binding.reason().as_str()
        || claims.authority_origin != expected_binding.authority_origin()
        || !claims.webauthn.user_present
        || !claims.webauthn.user_verified
        || claims.webauthn.attestation != "trusted_non_self"
        || claims.bwg_version != PROTOCOL_VERSION
        || claims.exp != expected_binding.challenge_expires_at_unix_seconds()
        || claims.iat >= claims.exp
        || !signed_artifact_is_time_valid(now_unix_seconds, claims.iat, claims.exp)
    {
        return Err(TrustedConsentError::InvalidReceipt);
    }
    Ok(())
}
