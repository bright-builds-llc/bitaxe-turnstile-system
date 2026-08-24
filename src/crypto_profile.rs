use std::{collections::HashSet, sync::Arc};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{digest, signature};
use serde::{Deserialize, Serialize};
use thiserror::Error;

mod claimant_proof;
mod signing;
#[cfg(test)]
pub(crate) mod test_support;
pub use claimant_proof::{
    VerifiedDpop, VerifiedIssuanceProof, VerifiedOutcomeProof, verify_dpop, verify_issuance_proof,
    verify_outcome_proof,
};
pub use signing::{AuthoritySigningKey, GatePassClaimsInput, GatePassConfirmationInput};
pub(crate) use signing::{GatePassClaimsSeed, GatePassClaimsTemplate};

/// Mandatory fully specified JOSE algorithm for BWG Gate Passes.
pub const GATE_PASS_JWS_ALGORITHM: &str = "Ed25519";
/// Mandatory browser DPoP JOSE algorithm for BWG Redemption.
pub const DPOP_JWS_ALGORITHM: &str = "ES256";

const GATE_PASS_TYPE: &str = "bwg-gate-pass+jwt";

/// Untrusted Authority JWK fields received at a JSON boundary.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AuthorityJwkWire {
    kid: String,
    kty: String,
    crv: String,
    x: String,
    alg: String,
    #[serde(rename = "use")]
    public_key_use: String,
    key_ops: Vec<String>,
}

impl AuthorityJwkWire {
    /// Returns the unvalidated key identifier for fixture and boundary routing.
    pub fn kid(&self) -> &str {
        &self.kid
    }
}

/// A validated trusted Authority verification key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorityJwk {
    kid: String,
    public_key: [u8; signature::ED25519_PUBLIC_KEY_LEN],
}

impl AuthorityJwk {
    /// Returns the case-sensitive key identifier used during rotation.
    pub fn kid(&self) -> &str {
        &self.kid
    }

    fn to_wire(&self) -> AuthorityJwkWire {
        AuthorityJwkWire {
            kid: self.kid.to_owned(),
            kty: "OKP".to_owned(),
            crv: "Ed25519".to_owned(),
            x: URL_SAFE_NO_PAD.encode(self.public_key),
            alg: GATE_PASS_JWS_ALGORITHM.to_owned(),
            public_key_use: "sig".to_owned(),
            key_ops: vec!["verify".to_owned()],
        }
    }
}

impl TryFrom<AuthorityJwkWire> for AuthorityJwk {
    type Error = CryptoProfileError;

    fn try_from(wire: AuthorityJwkWire) -> Result<Self, Self::Error> {
        if wire.alg != GATE_PASS_JWS_ALGORITHM {
            return Err(CryptoProfileError::AlgorithmKeyMismatch);
        }
        if wire.kid.is_empty()
            || wire.kty != "OKP"
            || wire.crv != "Ed25519"
            || wire.public_key_use != "sig"
            || wire.key_ops.as_slice() != ["verify"]
        {
            return Err(CryptoProfileError::InvalidAuthorityKey);
        }

        let public_key =
            decode_fixed_base64url(&wire.x).map_err(|_| CryptoProfileError::InvalidAuthorityKey)?;
        Ok(Self {
            kid: wire.kid,
            public_key,
        })
    }
}

/// A validated non-empty set of Authority keys with unique identifiers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorityKeySet(Arc<[AuthorityJwk]>);

impl AuthorityKeySet {
    /// Returns the validated keys.
    pub fn keys(&self) -> &[AuthorityJwk] {
        &self.0
    }

    /// Returns the trusted key identifiers.
    pub fn key_ids(&self) -> Vec<&str> {
        self.0.iter().map(AuthorityJwk::kid).collect()
    }

    /// Returns the canonical public JWKS wire values.
    pub fn to_wires(&self) -> Vec<AuthorityJwkWire> {
        self.0.iter().map(AuthorityJwk::to_wire).collect()
    }
}

impl TryFrom<Vec<AuthorityJwkWire>> for AuthorityKeySet {
    type Error = CryptoProfileError;

    fn try_from(wires: Vec<AuthorityJwkWire>) -> Result<Self, Self::Error> {
        let keys = wires
            .into_iter()
            .map(AuthorityJwk::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        let unique_ids = keys.iter().map(AuthorityJwk::kid).collect::<HashSet<_>>();
        if keys.is_empty() || unique_ids.len() != keys.len() {
            return Err(CryptoProfileError::InvalidAuthorityKeySet);
        }
        Ok(Self(keys.into()))
    }
}

/// Untrusted public P-256 JWK fields received at a JSON boundary.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct P256PublicJwkWire {
    kty: String,
    crv: String,
    x: String,
    y: String,
    #[serde(default, rename = "alg", skip_serializing_if = "Option::is_none")]
    maybe_alg: Option<String>,
    #[serde(default, rename = "d", skip_serializing_if = "Option::is_none")]
    maybe_private_key: Option<String>,
}

/// A validated public P-256 key used for DPoP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P256PublicJwk {
    x: [u8; 32],
    y: [u8; 32],
}

impl P256PublicJwk {
    fn sec1_public_key(&self) -> Vec<u8> {
        let mut public_key = Vec::with_capacity(65);
        public_key.push(0x04);
        public_key.extend(self.x);
        public_key.extend(self.y);
        public_key
    }
}

impl TryFrom<P256PublicJwkWire> for P256PublicJwk {
    type Error = CryptoProfileError;

    fn try_from(wire: P256PublicJwkWire) -> Result<Self, Self::Error> {
        if wire.kty != "EC" || wire.crv != "P-256" || wire.maybe_private_key.is_some() {
            return Err(CryptoProfileError::InvalidClaimantKey);
        }
        if wire
            .maybe_alg
            .as_deref()
            .is_some_and(|algorithm| algorithm != DPOP_JWS_ALGORITHM)
        {
            return Err(CryptoProfileError::AlgorithmKeyMismatch);
        }

        let x =
            decode_fixed_base64url(&wire.x).map_err(|_| CryptoProfileError::InvalidClaimantKey)?;
        let y =
            decode_fixed_base64url(&wire.y).map_err(|_| CryptoProfileError::InvalidClaimantKey)?;
        Ok(Self { x, y })
    }
}

/// Gate Pass claims established by a valid Authority signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedGatePass {
    authority_kid: String,
    claimant_jkt: String,
    issuer: String,
    audience: String,
    issued_at: u64,
    expires_at: u64,
    pass_id: String,
    challenge_id: String,
    protected_action_type: String,
    action_reference: String,
    action_policy: String,
}

impl VerifiedGatePass {
    /// Returns the trusted Authority key identifier that signed the pass.
    pub fn authority_kid(&self) -> &str {
        &self.authority_kid
    }

    /// Returns the RFC 7638 Claimant-key thumbprint bound into the pass.
    pub fn claimant_jkt(&self) -> &str {
        &self.claimant_jkt
    }

    /// Returns the verified Authority issuer.
    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    /// Returns the verified Relying Service audience.
    pub fn audience(&self) -> &str {
        &self.audience
    }

    /// Returns the verified issue time.
    pub fn issued_at(&self) -> u64 {
        self.issued_at
    }

    /// Returns the verified expiry time.
    pub fn expires_at(&self) -> u64 {
        self.expires_at
    }

    /// Returns the unique verified pass identity.
    pub fn pass_id(&self) -> &str {
        &self.pass_id
    }

    /// Returns the verified Work Challenge identity.
    pub fn challenge_id(&self) -> &str {
        &self.challenge_id
    }

    /// Returns the verified stable Protected Action Type.
    pub fn protected_action_type(&self) -> &str {
        &self.protected_action_type
    }

    /// Returns the verified opaque Action Reference.
    pub fn action_reference(&self) -> &str {
        &self.action_reference
    }

    /// Returns the verified immutable Action Policy revision.
    pub fn action_policy(&self) -> &str {
        &self.action_policy
    }
}

/// Verifies the cryptographic BWG/0.1 Gate Pass profile against trusted keys.
pub fn verify_gate_pass(
    compact_jws: &str,
    trusted_keys: &[AuthorityJwk],
) -> Result<VerifiedGatePass, CryptoProfileError> {
    let (authority_kid, claims) =
        verify_authority_payload::<GatePassClaims>(compact_jws, GATE_PASS_TYPE, trusted_keys)
            .map_err(|error| {
                if error == CryptoProfileError::InvalidAuthorityPayloadType {
                    return CryptoProfileError::InvalidGatePassType;
                }
                error
            })?;
    claims.validate()?;

    Ok(VerifiedGatePass {
        authority_kid,
        claimant_jkt: claims.cnf.jkt,
        issuer: claims.iss,
        audience: claims.aud,
        issued_at: claims.iat,
        expires_at: claims.exp,
        pass_id: claims.jti,
        challenge_id: claims.challenge_id,
        protected_action_type: claims.protected_action_type,
        action_reference: claims.action_reference,
        action_policy: claims.action_policy,
    })
}

pub(crate) fn verify_authority_payload<T>(
    compact_jws: &str,
    expected_type: &str,
    trusted_keys: &[AuthorityJwk],
) -> Result<(String, T), CryptoProfileError>
where
    T: for<'de> Deserialize<'de>,
{
    let compact = CompactJws::parse(compact_jws)?;
    let header: GatePassHeaderWire = decode_json(compact.protected_header)?;
    validate_critical_headers(&header.critical_headers)?;
    if header.typ != expected_type {
        return Err(CryptoProfileError::InvalidAuthorityPayloadType);
    }
    validate_algorithm(&header.alg, GATE_PASS_JWS_ALGORITHM)?;
    let mut matching_keys = trusted_keys.iter().filter(|key| key.kid == header.kid);
    let Some(key) = matching_keys.next() else {
        return Err(CryptoProfileError::UnknownKeyId);
    };
    if matching_keys.next().is_some() {
        return Err(CryptoProfileError::AmbiguousKeyId);
    }
    let signature_bytes = decode_base64url(compact.signature)?;
    signature::UnparsedPublicKey::new(&signature::ED25519, key.public_key)
        .verify(compact.signing_input.as_bytes(), &signature_bytes)
        .map_err(|_| CryptoProfileError::InvalidSignature)?;
    Ok((header.kid, decode_json(compact.payload)?))
}

/// Computes the RFC 9449 SHA-256 hash of an ASCII access-token value.
pub fn access_token_hash(access_token: &str) -> String {
    let hash = digest::digest(&digest::SHA256, access_token.as_bytes());
    URL_SAFE_NO_PAD.encode(hash.as_ref())
}

/// Computes an RFC 7638 SHA-256 thumbprint for a validated P-256 JWK.
pub fn p256_jwk_thumbprint(jwk: &P256PublicJwk) -> String {
    let x = URL_SAFE_NO_PAD.encode(jwk.x);
    let y = URL_SAFE_NO_PAD.encode(jwk.y);
    let canonical = format!(r#"{{"crv":"P-256","kty":"EC","x":"{x}","y":"{y}"}}"#);
    let hash = digest::digest(&digest::SHA256, canonical.as_bytes());
    URL_SAFE_NO_PAD.encode(hash.as_ref())
}

struct CompactJws<'a> {
    protected_header: &'a str,
    payload: &'a str,
    signature: &'a str,
    signing_input: String,
}

impl<'a> CompactJws<'a> {
    fn parse(value: &'a str) -> Result<Self, CryptoProfileError> {
        let mut segments = value.split('.');
        let (Some(protected_header), Some(payload), Some(signature_segment)) =
            (segments.next(), segments.next(), segments.next())
        else {
            return Err(CryptoProfileError::MalformedJws);
        };
        if segments.next().is_some()
            || protected_header.is_empty()
            || payload.is_empty()
            || signature_segment.is_empty()
        {
            return Err(CryptoProfileError::MalformedJws);
        }

        Ok(Self {
            protected_header,
            payload,
            signature: signature_segment,
            signing_input: format!("{protected_header}.{payload}"),
        })
    }
}

#[derive(Deserialize)]
struct GatePassHeaderWire {
    typ: String,
    alg: String,
    kid: String,
    #[serde(
        default,
        rename = "crit",
        deserialize_with = "deserialize_critical_header_presence"
    )]
    critical_headers: CriticalHeaderPresence,
}

#[derive(Deserialize)]
struct DpopHeaderWire {
    typ: String,
    alg: String,
    jwk: P256PublicJwkWire,
    #[serde(
        default,
        rename = "crit",
        deserialize_with = "deserialize_critical_header_presence"
    )]
    critical_headers: CriticalHeaderPresence,
}

#[derive(Default)]
enum CriticalHeaderPresence {
    #[default]
    Absent,
    Present,
}

#[derive(Deserialize)]
struct GatePassClaims {
    iss: String,
    aud: String,
    iat: u64,
    exp: u64,
    jti: String,
    challenge_id: String,
    protected_action_type: String,
    action_reference: String,
    action_policy: String,
    cnf: ConfirmationClaim,
    bwg_version: String,
}

impl GatePassClaims {
    fn validate(&self) -> Result<(), CryptoProfileError> {
        if self.iss.is_empty()
            || self.aud.is_empty()
            || self.jti.is_empty()
            || self.challenge_id.is_empty()
            || self.protected_action_type.is_empty()
            || self.action_reference.is_empty()
            || self.action_policy.is_empty()
            || self.cnf.jkt.is_empty()
            || self.bwg_version != "BWG/0.1"
            || self.iat >= self.exp
        {
            return Err(CryptoProfileError::InvalidGatePassClaims);
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct ConfirmationClaim {
    jkt: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CryptoProfileError {
    #[error("JWS compact serialization is malformed")]
    MalformedJws,
    #[error("JWS base64url encoding is invalid")]
    InvalidBase64Url,
    #[error("JWS JSON is invalid")]
    InvalidJson,
    #[error("unsupported critical JOSE header")]
    UnsupportedCriticalHeader,
    #[error("Gate Pass type is invalid")]
    InvalidGatePassType,
    #[error("Authority-signed payload type is invalid")]
    InvalidAuthorityPayloadType,
    #[error("Gate Pass claims are invalid")]
    InvalidGatePassClaims,
    #[error("DPoP type is invalid")]
    InvalidDpopType,
    #[error("DPoP claims are invalid")]
    InvalidDpopClaims,
    #[error("Claimant Issuance Proof type is invalid")]
    InvalidIssuanceProofType,
    #[error("Claimant Issuance Proof claims are invalid")]
    InvalidIssuanceProofClaims,
    #[error("Claimant Outcome Proof type is invalid")]
    InvalidOutcomeProofType,
    #[error("Claimant Outcome Proof claims are invalid")]
    InvalidOutcomeProofClaims,
    #[error("JWS algorithm is unknown")]
    UnknownAlgorithm,
    #[error("symmetric JWS algorithms are forbidden")]
    SymmetricAlgorithm,
    #[error("unsecured JWS is forbidden")]
    UnsecuredAlgorithm,
    #[error("deprecated JWS algorithms are forbidden")]
    DeprecatedAlgorithm,
    #[error("JWS algorithm does not match its JWK")]
    AlgorithmKeyMismatch,
    #[error("Authority key identifier is not trusted")]
    UnknownKeyId,
    #[error("Authority key identifier is ambiguous")]
    AmbiguousKeyId,
    #[error("Authority JWK does not match the BWG profile")]
    InvalidAuthorityKey,
    #[error("Authority key set must be non-empty with unique identifiers")]
    InvalidAuthorityKeySet,
    #[error("Authority signing key does not match configured JWKS")]
    InvalidSigningKey,
    #[error("JWS serialization failed")]
    SerializationFailed,
    #[error("Claimant JWK does not match the BWG profile")]
    InvalidClaimantKey,
    #[error("JWS signature is invalid")]
    InvalidSignature,
    #[error("DPoP access-token hash does not match")]
    AccessTokenHashMismatch,
}

fn validate_algorithm(algorithm: &str, required_algorithm: &str) -> Result<(), CryptoProfileError> {
    if algorithm == required_algorithm {
        return Ok(());
    }
    match algorithm {
        "none" => Err(CryptoProfileError::UnsecuredAlgorithm),
        "HS256" | "HS384" | "HS512" => Err(CryptoProfileError::SymmetricAlgorithm),
        "EdDSA" => Err(CryptoProfileError::DeprecatedAlgorithm),
        _ => Err(CryptoProfileError::UnknownAlgorithm),
    }
}

fn validate_critical_headers(
    critical_headers: &CriticalHeaderPresence,
) -> Result<(), CryptoProfileError> {
    if matches!(critical_headers, CriticalHeaderPresence::Present) {
        return Err(CryptoProfileError::UnsupportedCriticalHeader);
    }
    Ok(())
}

fn deserialize_critical_header_presence<'de, D>(
    deserializer: D,
) -> Result<CriticalHeaderPresence, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let _ = serde::de::IgnoredAny::deserialize(deserializer)?;
    Ok(CriticalHeaderPresence::Present)
}

fn decode_base64url(value: &str) -> Result<Vec<u8>, CryptoProfileError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| CryptoProfileError::InvalidBase64Url)
}

fn decode_fixed_base64url<const LENGTH: usize>(
    value: &str,
) -> Result<[u8; LENGTH], CryptoProfileError> {
    let bytes = decode_base64url(value)?;
    <[u8; LENGTH]>::try_from(bytes).map_err(|_| CryptoProfileError::InvalidBase64Url)
}

fn decode_json<T>(value: &str) -> Result<T, CryptoProfileError>
where
    T: for<'de> Deserialize<'de>,
{
    let bytes = decode_base64url(value)?;
    serde_json::from_slice(&bytes).map_err(|_| CryptoProfileError::InvalidJson)
}
