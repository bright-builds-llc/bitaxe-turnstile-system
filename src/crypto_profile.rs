use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{digest, signature};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Mandatory fully specified JOSE algorithm for BWG Gate Passes.
pub const GATE_PASS_JWS_ALGORITHM: &str = "Ed25519";
/// Mandatory browser DPoP JOSE algorithm for BWG Redemption.
pub const DPOP_JWS_ALGORITHM: &str = "ES256";

const GATE_PASS_TYPE: &str = "bwg-gate-pass+jwt";
const DPOP_TYPE: &str = "dpop+jwt";

/// A trusted Authority verification key from a configured JWKS snapshot.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AuthorityJwk {
    kid: String,
    kty: String,
    crv: String,
    x: String,
    alg: String,
    #[serde(rename = "use")]
    public_key_use: String,
    key_ops: Vec<String>,
}

/// The public P-256 JWK shape used by browser-held DPoP keys.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct P256PublicJwk {
    kty: String,
    crv: String,
    x: String,
    y: String,
    #[serde(default, rename = "alg", skip_serializing_if = "Option::is_none")]
    maybe_alg: Option<String>,
    #[serde(default, rename = "d", skip_serializing_if = "Option::is_none")]
    maybe_private_key: Option<String>,
}

impl P256PublicJwk {
    fn sec1_public_key(&self) -> Result<Vec<u8>, CryptoProfileError> {
        if self.kty != "EC" || self.crv != "P-256" || self.maybe_private_key.is_some() {
            return Err(CryptoProfileError::InvalidClaimantKey);
        }
        if self
            .maybe_alg
            .as_deref()
            .is_some_and(|algorithm| algorithm != DPOP_JWS_ALGORITHM)
        {
            return Err(CryptoProfileError::AlgorithmKeyMismatch);
        }

        let x = decode_base64url(&self.x)?;
        let y = decode_base64url(&self.y)?;
        if x.len() != 32 || y.len() != 32 {
            return Err(CryptoProfileError::InvalidClaimantKey);
        }

        let mut public_key = Vec::with_capacity(65);
        public_key.push(0x04);
        public_key.extend(x);
        public_key.extend(y);
        Ok(public_key)
    }
}

impl AuthorityJwk {
    /// Returns the case-sensitive key identifier used during rotation.
    pub fn kid(&self) -> &str {
        &self.kid
    }

    fn public_key_bytes(&self) -> Result<Vec<u8>, CryptoProfileError> {
        if self.alg != GATE_PASS_JWS_ALGORITHM {
            return Err(CryptoProfileError::AlgorithmKeyMismatch);
        }
        if self.kty != "OKP"
            || self.crv != "Ed25519"
            || self.public_key_use != "sig"
            || self.key_ops.as_slice() != ["verify"]
        {
            return Err(CryptoProfileError::InvalidAuthorityKey);
        }

        let bytes = decode_base64url(&self.x)?;
        if bytes.len() != signature::ED25519_PUBLIC_KEY_LEN {
            return Err(CryptoProfileError::InvalidAuthorityKey);
        }

        Ok(bytes)
    }
}

/// Gate Pass claims established by a valid Authority signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedGatePass {
    authority_kid: String,
    claimant_jkt: String,
}

/// DPoP values established by a valid Claimant signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedDpop {
    claimant_jkt: String,
    access_token_hash: String,
}

impl VerifiedDpop {
    /// Returns the RFC 7638 thumbprint of the proof's public JWK.
    pub fn claimant_jkt(&self) -> &str {
        &self.claimant_jkt
    }

    /// Returns the verified RFC 9449 `ath` value.
    pub fn access_token_hash(&self) -> &str {
        &self.access_token_hash
    }
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
}

/// Verifies the cryptographic BWG/0.1 Gate Pass profile against trusted keys.
pub fn verify_gate_pass(
    compact_jws: &str,
    trusted_keys: &[AuthorityJwk],
) -> Result<VerifiedGatePass, CryptoProfileError> {
    let compact = CompactJws::parse(compact_jws)?;
    let header: GatePassHeader = decode_json(compact.protected_header)?;
    if header.typ != GATE_PASS_TYPE {
        return Err(CryptoProfileError::InvalidGatePassType);
    }
    validate_gate_pass_algorithm(&header.alg)?;

    let maybe_key = trusted_keys.iter().find(|key| key.kid == header.kid);
    let Some(key) = maybe_key else {
        return Err(CryptoProfileError::UnknownKeyId);
    };
    let public_key = key.public_key_bytes()?;
    let signature_bytes = decode_base64url(compact.signature)?;
    signature::UnparsedPublicKey::new(&signature::ED25519, public_key)
        .verify(compact.signing_input.as_bytes(), &signature_bytes)
        .map_err(|_| CryptoProfileError::InvalidSignature)?;

    let claims: GatePassClaims = decode_json(compact.payload)?;
    claims.validate()?;

    Ok(VerifiedGatePass {
        authority_kid: header.kid,
        claimant_jkt: claims.cnf.jkt,
    })
}

/// Verifies the BWG browser DPoP signature and access-token binding.
pub fn verify_dpop(
    compact_jws: &str,
    access_token: &str,
) -> Result<VerifiedDpop, CryptoProfileError> {
    let compact = CompactJws::parse(compact_jws)?;
    let header: DpopHeader = decode_json(compact.protected_header)?;
    if header.typ != DPOP_TYPE {
        return Err(CryptoProfileError::InvalidDpopType);
    }
    validate_dpop_algorithm(&header.alg)?;

    let public_key = header.jwk.sec1_public_key()?;
    let signature_bytes = decode_base64url(compact.signature)?;
    signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, public_key)
        .verify(compact.signing_input.as_bytes(), &signature_bytes)
        .map_err(|_| CryptoProfileError::InvalidSignature)?;

    let claims: DpopClaims = decode_json(compact.payload)?;
    claims.validate()?;
    let expected_access_token_hash = access_token_hash(access_token);
    if claims.ath != expected_access_token_hash {
        return Err(CryptoProfileError::AccessTokenHashMismatch);
    }

    Ok(VerifiedDpop {
        claimant_jkt: p256_jwk_thumbprint(&header.jwk)?,
        access_token_hash: claims.ath,
    })
}

/// Computes the RFC 9449 SHA-256 hash of an ASCII access-token value.
pub fn access_token_hash(access_token: &str) -> String {
    let hash = digest::digest(&digest::SHA256, access_token.as_bytes());
    URL_SAFE_NO_PAD.encode(hash.as_ref())
}

/// Computes an RFC 7638 SHA-256 thumbprint for a public P-256 JWK.
pub fn p256_jwk_thumbprint(jwk: &P256PublicJwk) -> Result<String, CryptoProfileError> {
    jwk.sec1_public_key()?;
    let canonical = format!(
        r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#,
        jwk.x, jwk.y
    );
    let hash = digest::digest(&digest::SHA256, canonical.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(hash.as_ref()))
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
struct GatePassHeader {
    typ: String,
    alg: String,
    kid: String,
}

#[derive(Deserialize)]
struct DpopHeader {
    typ: String,
    alg: String,
    jwk: P256PublicJwk,
}

#[derive(Deserialize)]
struct GatePassClaims {
    iss: String,
    aud: String,
    iat: u64,
    exp: u64,
    jti: String,
    challenge_id: String,
    action_reference: String,
    cnf: ConfirmationClaim,
    bwg_version: String,
}

impl GatePassClaims {
    fn validate(&self) -> Result<(), CryptoProfileError> {
        if self.iss.is_empty()
            || self.aud.is_empty()
            || self.jti.is_empty()
            || self.challenge_id.is_empty()
            || self.action_reference.is_empty()
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

#[derive(Deserialize)]
struct DpopClaims {
    jti: String,
    htm: String,
    htu: String,
    iat: u64,
    ath: String,
}

impl DpopClaims {
    fn validate(&self) -> Result<(), CryptoProfileError> {
        if self.jti.is_empty()
            || self.htm.is_empty()
            || self.htu.is_empty()
            || self.iat == 0
            || self.ath.is_empty()
        {
            return Err(CryptoProfileError::InvalidDpopClaims);
        }

        Ok(())
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CryptoProfileError {
    #[error("JWS compact serialization is malformed")]
    MalformedJws,
    #[error("JWS base64url encoding is invalid")]
    InvalidBase64Url,
    #[error("JWS JSON is invalid")]
    InvalidJson,
    #[error("Gate Pass type is invalid")]
    InvalidGatePassType,
    #[error("Gate Pass claims are invalid")]
    InvalidGatePassClaims,
    #[error("DPoP type is invalid")]
    InvalidDpopType,
    #[error("DPoP claims are invalid")]
    InvalidDpopClaims,
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
    #[error("Authority JWK does not match the BWG profile")]
    InvalidAuthorityKey,
    #[error("Claimant JWK does not match the BWG profile")]
    InvalidClaimantKey,
    #[error("JWS signature is invalid")]
    InvalidSignature,
    #[error("DPoP access-token hash does not match")]
    AccessTokenHashMismatch,
}

fn decode_base64url(value: &str) -> Result<Vec<u8>, CryptoProfileError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| CryptoProfileError::InvalidBase64Url)
}

fn validate_gate_pass_algorithm(algorithm: &str) -> Result<(), CryptoProfileError> {
    match algorithm {
        GATE_PASS_JWS_ALGORITHM => Ok(()),
        "none" => Err(CryptoProfileError::UnsecuredAlgorithm),
        "HS256" | "HS384" | "HS512" => Err(CryptoProfileError::SymmetricAlgorithm),
        "EdDSA" => Err(CryptoProfileError::DeprecatedAlgorithm),
        _ => Err(CryptoProfileError::UnknownAlgorithm),
    }
}

fn validate_dpop_algorithm(algorithm: &str) -> Result<(), CryptoProfileError> {
    match algorithm {
        DPOP_JWS_ALGORITHM => Ok(()),
        "none" => Err(CryptoProfileError::UnsecuredAlgorithm),
        "HS256" | "HS384" | "HS512" => Err(CryptoProfileError::SymmetricAlgorithm),
        "EdDSA" => Err(CryptoProfileError::DeprecatedAlgorithm),
        _ => Err(CryptoProfileError::UnknownAlgorithm),
    }
}

fn decode_json<T>(value: &str) -> Result<T, CryptoProfileError>
where
    T: for<'de> Deserialize<'de>,
{
    let bytes = decode_base64url(value)?;
    serde_json::from_slice(&bytes).map_err(|_| CryptoProfileError::InvalidJson)
}
