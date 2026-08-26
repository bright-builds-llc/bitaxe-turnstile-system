use std::{collections::BTreeMap, time::Duration};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;
use uuid::Uuid;
use webauthn_rs::prelude::{
    AttestationCaList, AttestationCaListBuilder, AttestedPasskeyRegistration,
    RegisterPublicKeyCredential, Webauthn, WebauthnBuilder,
};

const MAXIMUM_IDENTIFIER_LENGTH: usize = 128;
const SHA256_BASE64URL_LENGTH: usize = 43;
const WEBAUTHN_TIMEOUT: Duration = Duration::from_secs(120);

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TrustedConsentReason {
    ElevatedWork,
    MaterialPoolTerms,
}

impl TrustedConsentReason {
    pub fn parse(value: &str) -> Result<Self, TrustedConsentError> {
        match value {
            "elevated_work" => Ok(Self::ElevatedWork),
            "material_pool_terms" => Ok(Self::MaterialPoolTerms),
            _ => Err(TrustedConsentError::InvalidReason),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ElevatedWork => "elevated_work",
            Self::MaterialPoolTerms => "material_pool_terms",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct TrustedConsentCeremonyId(String);

impl TryFrom<String> for TrustedConsentCeremonyId {
    type Error = TrustedConsentError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.strip_prefix("ceremony_").is_none_or(str::is_empty)
            || value.len() > MAXIMUM_IDENTIFIER_LENGTH
            || !value
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            return Err(TrustedConsentError::InvalidCeremonyId);
        }
        Ok(Self(value))
    }
}

impl TrustedConsentCeremonyId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TrustedConsentOperationOwner(Uuid);

impl TrustedConsentOperationOwner {
    pub(crate) fn random() -> Self {
        Self(Uuid::new_v4())
    }

    pub(crate) fn as_uuid(self) -> Uuid {
        self.0
    }
}

#[derive(Debug, Clone)]
pub(crate) struct TrustedConsentBindingInput {
    pub(crate) challenge_id: String,
    pub(crate) disclosure_digest_sha256: String,
    pub(crate) pool_offer_set_signature_sha256: String,
    pub(crate) reason: String,
    pub(crate) authority_origin: String,
    pub(crate) challenge_expires_at_unix_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TrustedConsentBinding {
    challenge_id: String,
    disclosure_digest_sha256: String,
    pool_offer_set_signature_sha256: String,
    reason: TrustedConsentReason,
    authority_origin: String,
    challenge_expires_at_unix_seconds: u64,
}

impl TryFrom<TrustedConsentBindingInput> for TrustedConsentBinding {
    type Error = TrustedConsentError;

    fn try_from(input: TrustedConsentBindingInput) -> Result<Self, Self::Error> {
        if !valid_digest(&input.disclosure_digest_sha256)
            || !valid_digest(&input.pool_offer_set_signature_sha256)
        {
            return Err(TrustedConsentError::InvalidDigest);
        }
        if !input.challenge_id.starts_with("challenge_")
            || input.challenge_id.len() > MAXIMUM_IDENTIFIER_LENGTH
        {
            return Err(TrustedConsentError::InvalidChallengeId);
        }
        let origin = Url::parse(&input.authority_origin)
            .map_err(|_| TrustedConsentError::InvalidAuthorityOrigin)?;
        if origin.scheme() != "https"
            || origin.domain().is_none()
            || origin.username() != ""
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return Err(TrustedConsentError::InvalidAuthorityOrigin);
        }
        if input.challenge_expires_at_unix_seconds == 0 {
            return Err(TrustedConsentError::InvalidDeadline);
        }
        Ok(Self {
            challenge_id: input.challenge_id,
            disclosure_digest_sha256: input.disclosure_digest_sha256,
            pool_offer_set_signature_sha256: input.pool_offer_set_signature_sha256,
            reason: TrustedConsentReason::parse(&input.reason)?,
            authority_origin: input.authority_origin,
            challenge_expires_at_unix_seconds: input.challenge_expires_at_unix_seconds,
        })
    }
}

impl TrustedConsentBinding {
    pub fn challenge_id(&self) -> &str {
        &self.challenge_id
    }

    pub fn challenge_expires_at_unix_seconds(&self) -> u64 {
        self.challenge_expires_at_unix_seconds
    }

    pub(crate) fn disclosure_digest_sha256(&self) -> &str {
        &self.disclosure_digest_sha256
    }

    pub(crate) fn pool_offer_set_signature_sha256(&self) -> &str {
        &self.pool_offer_set_signature_sha256
    }

    pub(crate) fn reason(&self) -> &TrustedConsentReason {
        &self.reason
    }

    pub(crate) fn authority_origin(&self) -> &str {
        &self.authority_origin
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TrustedConsentCeremonyStatus {
    Pending,
    Verified,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TrustedConsentCeremony {
    ceremony_id: TrustedConsentCeremonyId,
    binding: TrustedConsentBinding,
    status: TrustedConsentCeremonyStatus,
    created_at_unix_seconds: u64,
    expires_at_unix_seconds: u64,
    maybe_verified_at_unix_seconds: Option<u64>,
}

impl TrustedConsentCeremony {
    pub fn pending(
        ceremony_id: TrustedConsentCeremonyId,
        binding: TrustedConsentBinding,
        created_at_unix_seconds: u64,
        expires_at_unix_seconds: u64,
    ) -> Result<Self, TrustedConsentError> {
        if created_at_unix_seconds == 0
            || expires_at_unix_seconds <= created_at_unix_seconds
            || expires_at_unix_seconds > binding.challenge_expires_at_unix_seconds()
        {
            return Err(TrustedConsentError::InvalidDeadline);
        }
        Ok(Self {
            ceremony_id,
            binding,
            status: TrustedConsentCeremonyStatus::Pending,
            created_at_unix_seconds,
            expires_at_unix_seconds,
            maybe_verified_at_unix_seconds: None,
        })
    }

    pub fn verify(mut self, now_unix_seconds: u64) -> Result<Self, TrustedConsentError> {
        if self.status != TrustedConsentCeremonyStatus::Pending {
            return Err(TrustedConsentError::CeremonyAlreadyTerminal);
        }
        if now_unix_seconds < self.created_at_unix_seconds
            || now_unix_seconds >= self.expires_at_unix_seconds
        {
            return Err(TrustedConsentError::CeremonyExpired);
        }
        self.status = TrustedConsentCeremonyStatus::Verified;
        self.maybe_verified_at_unix_seconds = Some(now_unix_seconds);
        Ok(self)
    }

    pub fn fail(mut self, now_unix_seconds: u64) -> Result<Self, TrustedConsentError> {
        if self.status != TrustedConsentCeremonyStatus::Pending {
            return Err(TrustedConsentError::CeremonyAlreadyTerminal);
        }
        if now_unix_seconds < self.created_at_unix_seconds {
            return Err(TrustedConsentError::InvalidDeadline);
        }
        self.status = TrustedConsentCeremonyStatus::Failed;
        Ok(self)
    }

    pub fn status(&self) -> TrustedConsentCeremonyStatus {
        self.status
    }

    pub(crate) fn ceremony_id(&self) -> &TrustedConsentCeremonyId {
        &self.ceremony_id
    }

    pub(crate) fn binding(&self) -> &TrustedConsentBinding {
        &self.binding
    }

    pub(crate) fn created_at_unix_seconds(&self) -> u64 {
        self.created_at_unix_seconds
    }

    pub(crate) fn expires_at_unix_seconds(&self) -> u64 {
        self.expires_at_unix_seconds
    }
}

/// Output of starting one registration ceremony.
///
/// `registration_state` is opaque server-only state and must never be returned to a browser.
pub struct WebauthnCeremonyStart {
    /// Browser-facing `PublicKeyCredentialCreationOptions` JSON.
    pub creation_options: serde_json::Value,
    /// Opaque, single-use server state required to verify the response.
    pub registration_state: serde_json::Value,
}

/// Security facts established by a trusted WebAuthn verifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedWebauthn {
    /// Whether the authenticator proved user presence.
    pub user_present: bool,
    /// Whether the authenticator proved local user verification.
    pub user_verified: bool,
    /// Stable attestation classification; production acceptance requires `trusted_non_self`.
    pub attestation: &'static str,
}

/// Server-side WebAuthn seam for Trusted Consent.
///
/// Implementations must keep registration state server-side, enforce RP ID and exact origin,
/// verify the ceremony challenge, UP, UV, credential signature, and operator-trusted non-self
/// attestation, and fail closed on every malformed or unsupported response.
pub trait TrustedConsentWebauthnVerifier: Send + Sync {
    /// Returns the exact RP origin enforced by this verifier, when configured.
    fn maybe_rp_origin(&self) -> Option<&str>;

    /// Creates unpredictable browser options plus opaque server-only verification state.
    fn begin(
        &self,
        user_id: Uuid,
        challenge_id: &str,
    ) -> Result<WebauthnCeremonyStart, TrustedConsentError>;

    /// Consumes one browser response and its matching server-only state.
    fn finish(
        &self,
        response: serde_json::Value,
        registration_state: serde_json::Value,
    ) -> Result<VerifiedWebauthn, TrustedConsentError>;
}

pub(crate) struct UnavailableTrustedConsentVerifier;

impl TrustedConsentWebauthnVerifier for UnavailableTrustedConsentVerifier {
    fn maybe_rp_origin(&self) -> Option<&str> {
        None
    }

    fn begin(
        &self,
        _user_id: Uuid,
        _challenge_id: &str,
    ) -> Result<WebauthnCeremonyStart, TrustedConsentError> {
        Err(TrustedConsentError::WebauthnUnavailable)
    }

    fn finish(
        &self,
        _response: serde_json::Value,
        _registration_state: serde_json::Value,
    ) -> Result<VerifiedWebauthn, TrustedConsentError> {
        Err(TrustedConsentError::WebauthnUnavailable)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TrustedConsentBeginRequest {
    pub(crate) pool_offer_set_signature_sha256: String,
    pub(crate) reason: String,
    pub(crate) authority_origin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct TrustedConsentBeginResponse {
    pub(crate) ceremony_id: String,
    pub(crate) authority_disclosure_digest_sha256: String,
    pub(crate) public_key: serde_json::Value,
    pub(crate) expires_at_unix_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct TrustedConsentFinishResponse {
    pub(crate) ceremony_id: String,
    pub(crate) status: TrustedConsentCeremonyStatus,
}

/// Operator-configured trust for one approved authenticator model.
pub struct TrustedAttestationAnchorInput {
    /// PEM-encoded attestation root CA certificate.
    pub ca_pem: String,
    /// Exact authenticator model AAGUID approved beneath the root.
    pub aaguid: Uuid,
    /// Non-empty operator description retained only in local trust policy.
    pub description: String,
}

/// Production verifier requiring UV and operator-trusted direct attestation.
pub struct AttestedWebauthnVerifier {
    webauthn: Webauthn,
    attestation_ca_list: AttestationCaList,
    rp_origin: String,
}

impl AttestedWebauthnVerifier {
    /// Builds a strict verifier from one RP and a non-empty authenticator trust policy.
    pub fn new(
        rp_id: &str,
        rp_origin: &str,
        anchors: Vec<TrustedAttestationAnchorInput>,
    ) -> Result<Self, TrustedConsentError> {
        if anchors.is_empty() {
            return Err(TrustedConsentError::MissingAttestationTrust);
        }
        let origin =
            Url::parse(rp_origin).map_err(|_| TrustedConsentError::InvalidWebauthnConfig)?;
        let webauthn = WebauthnBuilder::new(rp_id, &origin)
            .map_err(|_| TrustedConsentError::InvalidWebauthnConfig)?
            .rp_name("Bitcoin Work Gate trusted consent")
            .timeout(WEBAUTHN_TIMEOUT)
            .build()
            .map_err(|_| TrustedConsentError::InvalidWebauthnConfig)?;
        let mut ca_builder = AttestationCaListBuilder::new();
        for anchor in anchors {
            if anchor.description.is_empty() {
                return Err(TrustedConsentError::InvalidAttestationTrust);
            }
            ca_builder
                .insert_device_pem(
                    anchor.ca_pem.as_bytes(),
                    anchor.aaguid,
                    anchor.description,
                    BTreeMap::new(),
                )
                .map_err(|_| TrustedConsentError::InvalidAttestationTrust)?;
        }
        Ok(Self {
            webauthn,
            attestation_ca_list: ca_builder.build(),
            rp_origin: origin.origin().ascii_serialization(),
        })
    }
}

impl TrustedConsentWebauthnVerifier for AttestedWebauthnVerifier {
    fn maybe_rp_origin(&self) -> Option<&str> {
        Some(&self.rp_origin)
    }

    fn begin(
        &self,
        user_id: Uuid,
        challenge_id: &str,
    ) -> Result<WebauthnCeremonyStart, TrustedConsentError> {
        let (creation_options, registration_state) = self
            .webauthn
            .start_attested_passkey_registration(
                user_id,
                challenge_id,
                "BWG Claimant",
                None,
                self.attestation_ca_list.clone(),
                None,
            )
            .map_err(|_| TrustedConsentError::WebauthnUnavailable)?;
        Ok(WebauthnCeremonyStart {
            creation_options: serde_json::to_value(creation_options)
                .map_err(|_| TrustedConsentError::InvalidWebauthnState)?,
            registration_state: serde_json::to_value(registration_state)
                .map_err(|_| TrustedConsentError::InvalidWebauthnState)?,
        })
    }

    fn finish(
        &self,
        response: serde_json::Value,
        registration_state: serde_json::Value,
    ) -> Result<VerifiedWebauthn, TrustedConsentError> {
        let response = serde_json::from_value::<RegisterPublicKeyCredential>(response)
            .map_err(|_| TrustedConsentError::InvalidWebauthnResponse)?;
        let registration_state =
            serde_json::from_value::<AttestedPasskeyRegistration>(registration_state)
                .map_err(|_| TrustedConsentError::InvalidWebauthnState)?;
        let passkey = self
            .webauthn
            .finish_attested_passkey_registration(&response, &registration_state)
            .map_err(|_| TrustedConsentError::WebauthnRejected)?;
        passkey
            .verify_attestation(&self.attestation_ca_list)
            .map_err(|_| TrustedConsentError::WebauthnRejected)?;
        Ok(VerifiedWebauthn {
            user_present: true,
            user_verified: true,
            attestation: "trusted_non_self",
        })
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == SHA256_BASE64URL_LENGTH
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
}

/// Fail-closed Trusted Consent validation and verification errors.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TrustedConsentError {
    /// Ceremony identifier does not match the durable `ceremony_...` grammar.
    #[error("trusted consent ceremony identifier is invalid")]
    InvalidCeremonyId,
    /// Challenge identifier does not match the expected Authority namespace.
    #[error("Work Challenge identifier is invalid")]
    InvalidChallengeId,
    /// A binding digest is not canonical base64url SHA-256.
    #[error("trusted consent digest is invalid")]
    InvalidDigest,
    /// The requested confirmation reason is unsupported.
    #[error("trusted consent reason is invalid")]
    InvalidReason,
    /// The Authority origin is not an exact secure origin.
    #[error("Authority origin is invalid")]
    InvalidAuthorityOrigin,
    /// Ceremony or challenge deadlines are invalid.
    #[error("trusted consent deadline is invalid")]
    InvalidDeadline,
    /// The ceremony reached its exclusive deadline before completion.
    #[error("trusted consent ceremony has expired")]
    CeremonyExpired,
    /// The requested transition targets an already terminal ceremony.
    #[error("trusted consent ceremony is already terminal")]
    CeremonyAlreadyTerminal,
    /// Another bounded ceremony operation currently owns the row.
    #[error("trusted consent ceremony verification is already in progress")]
    CeremonyInProgress,
    /// An interrupted or invalid operation was terminalized without trusting its outcome.
    #[error("trusted consent ceremony verification outcome is uncertain")]
    CeremonyFailed,
    /// The caller no longer owns the fenced verification lease.
    #[error("trusted consent verification lease was lost")]
    LostVerificationLease,
    /// The signed Work Challenge does not require trusted confirmation.
    #[error("Work Challenge does not require trusted confirmation")]
    ConfirmationNotRequired,
    /// Presented browser binding differs from Authority-derived terms.
    #[error("trusted consent binding does not match the Work Challenge")]
    BindingMismatch,
    /// No ceremony exists for the opaque identifier.
    #[error("Trusted Consent ceremony was not found")]
    UnknownCeremony,
    /// Operator attestation trust policy is empty.
    #[error("trusted authenticator policy is empty")]
    MissingAttestationTrust,
    /// Operator attestation trust policy cannot be parsed or validated.
    #[error("trusted authenticator policy is invalid")]
    InvalidAttestationTrust,
    /// RP ID or origin configuration is invalid.
    #[error("WebAuthn RP configuration is invalid")]
    InvalidWebauthnConfig,
    /// The configured WebAuthn verifier cannot start or run a ceremony.
    #[error("WebAuthn ceremony is unavailable")]
    WebauthnUnavailable,
    /// Persisted server-only ceremony state is invalid.
    #[error("persisted WebAuthn state is invalid")]
    InvalidWebauthnState,
    /// Browser credential JSON is malformed.
    #[error("WebAuthn response is invalid")]
    InvalidWebauthnResponse,
    /// Cryptographic, ceremony, UV, or attestation checks rejected the response.
    #[error("WebAuthn attestation was rejected")]
    WebauthnRejected,
}
