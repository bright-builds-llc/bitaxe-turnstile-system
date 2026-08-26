use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

use crate::{
    challenge::ActionPolicy,
    crypto_profile::{
        AuthorityJwkWire, AuthorityKeySet, DPOP_JWS_ALGORITHM, GATE_PASS_JWS_ALGORITHM,
    },
    web_url::HttpsUrl,
};

const PROTOCOL_VERSION: &str = "BWG/0.1";
const SOURCE_REPOSITORY: &str = "https://github.com/bright-builds-llc/bitaxe-turnstile-system";

#[cfg(test)]
mod tests;

/// Validated public operator metadata used to publish Authority discovery.
#[derive(Clone)]
pub struct AuthorityPublicConfig {
    issuer: HttpsUrl,
    public_base_url: HttpsUrl,
    authority_keys: AuthorityKeySet,
    operator_policy_url: HttpsUrl,
    privacy_url: HttpsUrl,
    terms_url: HttpsUrl,
}

impl AuthorityPublicConfig {
    /// Validates the public URLs and Authority verification keys used by discovery.
    pub fn new(
        issuer: impl Into<String>,
        public_base_url: impl Into<String>,
        authority_keys: Vec<AuthorityJwkWire>,
        operator_policy_url: impl Into<String>,
        privacy_url: impl Into<String>,
        terms_url: impl Into<String>,
    ) -> Result<Self, AuthorityDescriptorError> {
        let config = Self {
            issuer: parse_https_config_url(issuer.into())?,
            public_base_url: parse_https_config_url(public_base_url.into())?,
            authority_keys: AuthorityKeySet::try_from(authority_keys)
                .map_err(|_| AuthorityDescriptorError::InvalidAuthorityKeys)?,
            operator_policy_url: parse_https_config_url(operator_policy_url.into())?,
            privacy_url: parse_https_config_url(privacy_url.into())?,
            terms_url: parse_https_config_url(terms_url.into())?,
        };
        Ok(config)
    }

    pub(crate) fn descriptor(&self) -> AuthorityDescriptor {
        let base_url = self.public_base_url.as_str().trim_end_matches('/');
        AuthorityDescriptor(AuthorityDescriptorFields {
            issuer: self.issuer.as_str().to_owned(),
            protocol_version: PROTOCOL_VERSION.to_owned(),
            endpoints: AuthorityEndpoints {
                challenge_creation: format!("{base_url}/v0/challenges"),
                challenge_progress: format!("{base_url}/v0/challenges/{{challenge_id}}/events"),
                gate_pass: format!("{base_url}/v0/challenges/{{challenge_id}}/gate-pass"),
                trusted_consent: format!(
                    "{base_url}/v0/challenges/{{challenge_id}}/trusted-consent"
                ),
                authority_descriptor: format!(
                    "{base_url}/.well-known/pow-gate-configuration"
                ),
                jwks: format!("{base_url}/.well-known/jwks.json"),
            },
            jwks: JwksDocument {
                keys: self.authority_keys.to_wires(),
            },
            algorithms: AuthorityAlgorithms {
                gate_pass_jws: vec![GATE_PASS_JWS_ALGORITHM.to_owned()],
                pool_offer_set_jws: vec![GATE_PASS_JWS_ALGORITHM.to_owned()],
                browser_dpop_jws: vec![DPOP_JWS_ALGORITHM.to_owned()],
                jwk_thumbprint: "SHA-256".to_owned(),
                access_token_hash: "SHA-256".to_owned(),
            },
            transports: AuthorityTransports {
                public_api: "https+json".to_owned(),
                progress: "sse".to_owned(),
                pool_adapter: "grpc+protobuf".to_owned(),
                worker: "stratum-v1".to_owned(),
            },
            capabilities: AuthorityCapabilities {
                challenge_issuance: true,
                authority_discovery: true,
                jwks_rotation: true,
                bounded_overrides: true,
                verified_progress_streaming: true,
                approved_pool_offers: true,
                attested_trusted_consent: true,
            },
            critical_capabilities: Vec::new(),
            limits: AuthorityLimits {
                max_action_reference_bytes: 256,
                max_claimant_key_bytes: 4096,
                challenge_ttl_seconds: 900,
                gate_pass_ttl_seconds: 120,
                dpop_clock_window_seconds: 60,
            },
            policies: ActionPolicy::ALL
                .into_iter()
                .map(ActionPolicyDescriptor::from)
                .collect(),
            source: SourceDescriptor {
                repository: SOURCE_REPOSITORY.to_owned(),
                version: env!("CARGO_PKG_VERSION").to_owned(),
                commit: option_env!("BWG_BUILD_COMMIT")
                    .unwrap_or("Unavailable")
                    .to_owned(),
                build_time: option_env!("BWG_BUILD_TIME")
                    .unwrap_or("Unavailable")
                    .to_owned(),
            },
            operator_policy_url: self.operator_policy_url.as_str().to_owned(),
            privacy: PrivacyDescriptor {
                url: self.privacy_url.as_str().to_owned(),
                summary: "Pairwise Claimant keys and opaque Action References; no account or device identity in challenge discovery.".to_owned(),
            },
            terms_url: self.terms_url.as_str().to_owned(),
            license: LicenseDescriptor {
                project: "MIT".to_owned(),
                url: format!("{SOURCE_REPOSITORY}/blob/main/LICENSE"),
            },
        })
    }

    pub(crate) fn authority_keys(&self) -> &AuthorityKeySet {
        &self.authority_keys
    }
}

/// A validated, versioned public Gate Authority discovery document.
#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct AuthorityDescriptor(AuthorityDescriptorFields);

impl AuthorityDescriptor {
    /// Returns the discovered issuer identity without granting it trust.
    pub fn issuer(&self) -> &str {
        &self.0.issuer
    }

    pub(crate) fn gate_pass_url(&self, challenge_id: &str) -> String {
        self.0
            .endpoints
            .gate_pass
            .replace("{challenge_id}", challenge_id)
    }

    pub(crate) fn jwks(&self) -> JwksDocument {
        self.0.jwks.clone()
    }

    pub(crate) fn privacy_url(&self) -> &str {
        &self.0.privacy.url
    }

    pub(crate) fn terms_url(&self) -> &str {
        &self.0.terms_url
    }
}

impl<'de> Deserialize<'de> for AuthorityDescriptor {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let fields = AuthorityDescriptorFields::deserialize(deserializer)?;
        fields.validate().map_err(serde::de::Error::custom)?;
        Ok(Self(fields))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AuthorityDescriptorFields {
    issuer: String,
    protocol_version: String,
    endpoints: AuthorityEndpoints,
    jwks: JwksDocument,
    algorithms: AuthorityAlgorithms,
    transports: AuthorityTransports,
    capabilities: AuthorityCapabilities,
    critical_capabilities: Vec<String>,
    limits: AuthorityLimits,
    policies: Vec<ActionPolicyDescriptor>,
    source: SourceDescriptor,
    operator_policy_url: String,
    privacy: PrivacyDescriptor,
    terms_url: String,
    license: LicenseDescriptor,
}

impl AuthorityDescriptorFields {
    fn validate(&self) -> Result<(), AuthorityDescriptorError> {
        if self.protocol_version != PROTOCOL_VERSION
            || [
                self.issuer.as_str(),
                self.endpoints.challenge_creation.as_str(),
                self.endpoints.challenge_progress.as_str(),
                self.endpoints.gate_pass.as_str(),
                self.endpoints.trusted_consent.as_str(),
                self.endpoints.authority_descriptor.as_str(),
                self.endpoints.jwks.as_str(),
                self.source.repository.as_str(),
                self.operator_policy_url.as_str(),
                self.privacy.url.as_str(),
                self.terms_url.as_str(),
                self.license.url.as_str(),
            ]
            .into_iter()
            .any(|value| HttpsUrl::try_from(value.to_owned()).is_err())
        {
            return Err(AuthorityDescriptorError::InvalidDescriptor);
        }
        AuthorityKeySet::try_from(self.jwks.keys.clone())
            .map_err(|_| AuthorityDescriptorError::InvalidAuthorityKeys)?;
        if self.algorithms.gate_pass_jws != [GATE_PASS_JWS_ALGORITHM]
            || self.algorithms.pool_offer_set_jws != [GATE_PASS_JWS_ALGORITHM]
            || self.algorithms.browser_dpop_jws != [DPOP_JWS_ALGORITHM]
            || self.algorithms.jwk_thumbprint != "SHA-256"
            || self.algorithms.access_token_hash != "SHA-256"
        {
            return Err(AuthorityDescriptorError::InvalidAlgorithms);
        }

        let known_capabilities = [
            "challenge_issuance",
            "authority_discovery",
            "jwks_rotation",
            "bounded_overrides",
            "verified_progress_streaming",
            "approved_pool_offers",
            "attested_trusted_consent",
        ];
        if self
            .critical_capabilities
            .iter()
            .any(|capability| !known_capabilities.contains(&capability.as_str()))
        {
            return Err(AuthorityDescriptorError::UnknownCriticalCapability);
        }
        if self.policies.is_empty() {
            return Err(AuthorityDescriptorError::InvalidPolicies);
        }
        for policy in &self.policies {
            policy.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AuthorityEndpoints {
    challenge_creation: String,
    challenge_progress: String,
    gate_pass: String,
    trusted_consent: String,
    authority_descriptor: String,
    jwks: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JwksDocument {
    keys: Vec<AuthorityJwkWire>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AuthorityAlgorithms {
    gate_pass_jws: Vec<String>,
    pool_offer_set_jws: Vec<String>,
    browser_dpop_jws: Vec<String>,
    jwk_thumbprint: String,
    access_token_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AuthorityTransports {
    public_api: String,
    progress: String,
    pool_adapter: String,
    worker: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AuthorityCapabilities {
    challenge_issuance: bool,
    authority_discovery: bool,
    jwks_rotation: bool,
    bounded_overrides: bool,
    verified_progress_streaming: bool,
    approved_pool_offers: bool,
    attested_trusted_consent: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AuthorityLimits {
    max_action_reference_bytes: usize,
    max_claimant_key_bytes: usize,
    challenge_ttl_seconds: u64,
    gate_pass_ttl_seconds: u64,
    dpop_clock_window_seconds: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ActionPolicyDescriptor {
    id: String,
    default_expected_hashes: String,
    #[serde(
        default,
        rename = "expected_hash_override",
        skip_serializing_if = "Option::is_none"
    )]
    maybe_expected_hash_override: Option<ExpectedHashBounds>,
    challenge_ttl_seconds: u64,
    critical_fields: Vec<String>,
}

impl From<ActionPolicy> for ActionPolicyDescriptor {
    fn from(policy: ActionPolicy) -> Self {
        Self {
            id: policy.id().to_owned(),
            default_expected_hashes: policy.default_expected_hashes().to_string(),
            maybe_expected_hash_override: policy.maybe_expected_hash_override_bounds().map(
                |(minimum, maximum)| ExpectedHashBounds {
                    minimum: minimum.to_string(),
                    maximum: maximum.to_string(),
                },
            ),
            challenge_ttl_seconds: policy.challenge_ttl_seconds(),
            critical_fields: Vec::new(),
        }
    }
}

impl ActionPolicyDescriptor {
    fn validate(&self) -> Result<(), AuthorityDescriptorError> {
        let policy =
            ActionPolicy::parse(&self.id).map_err(|_| AuthorityDescriptorError::InvalidPolicies)?;
        let known_fields = [
            "default_expected_hashes",
            "expected_hash_override",
            "challenge_ttl_seconds",
        ];
        if self
            .critical_fields
            .iter()
            .any(|field| !known_fields.contains(&field.as_str()))
        {
            return Err(AuthorityDescriptorError::UnknownCriticalPolicyField);
        }
        if self.default_expected_hashes != policy.default_expected_hashes().to_string()
            || self.challenge_ttl_seconds != policy.challenge_ttl_seconds()
        {
            return Err(AuthorityDescriptorError::InvalidPolicies);
        }
        let expected_bounds = policy
            .maybe_expected_hash_override_bounds()
            .map(|(minimum, maximum)| (minimum.to_string(), maximum.to_string()));
        let actual_bounds = self
            .maybe_expected_hash_override
            .as_ref()
            .map(|bounds| (bounds.minimum.to_owned(), bounds.maximum.to_owned()));
        if actual_bounds != expected_bounds {
            return Err(AuthorityDescriptorError::InvalidPolicies);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ExpectedHashBounds {
    minimum: String,
    maximum: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SourceDescriptor {
    repository: String,
    version: String,
    commit: String,
    build_time: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PrivacyDescriptor {
    url: String,
    summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct LicenseDescriptor {
    project: String,
    url: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AuthorityDescriptorError {
    #[error("public Authority URLs must use HTTPS")]
    InvalidPublicUrl,
    #[error("Authority discovery needs valid unique verification keys")]
    InvalidAuthorityKeys,
    #[error("Authority Descriptor fields are invalid")]
    InvalidDescriptor,
    #[error("Authority Descriptor algorithms are invalid")]
    InvalidAlgorithms,
    #[error("Authority Descriptor names an unknown critical capability")]
    UnknownCriticalCapability,
    #[error("Authority Descriptor policies are invalid")]
    InvalidPolicies,
    #[error("Authority Descriptor policy names an unknown critical field")]
    UnknownCriticalPolicyField,
}

fn parse_https_config_url(value: String) -> Result<HttpsUrl, AuthorityDescriptorError> {
    HttpsUrl::try_from(value).map_err(|_| AuthorityDescriptorError::InvalidPublicUrl)
}
