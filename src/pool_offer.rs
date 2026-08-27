use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

use crate::{
    challenge::{ActionPolicy, ChallengeId},
    crypto_profile::{
        AuthorityJwk, AuthoritySigningKey, CryptoProfileError, verify_authority_payload,
    },
    web_url::HttpsUrl,
};

const POOL_OFFER_SET_TYPE: &str = "bwg-pool-offer-set+jws";
const PROTOCOL_VERSION: &str = "BWG/0.1";
const MAXIMUM_ID_LENGTH: usize = 128;
const MAXIMUM_LABEL_LENGTH: usize = 256;

mod classification;
mod replacement;
mod selection;
#[cfg(test)]
mod tests;

pub use classification::{
    MaterialPoolOfferChange, MaterialPoolOfferChanges, PoolOfferChange, classify_pool_offer_change,
};
pub use replacement::{
    MaterialPoolOfferConfirmation, PoolFailoverProjection, PoolFailoverRecoveryCategory,
    PoolFailoverSessionProjection, PoolFailoverSessionState, PoolOfferReplacementDecision,
    PoolOfferReplacementStatus,
};
pub(crate) use replacement::{
    PersistedPoolFailoverProjection, Sha256Base64Url, material_replacement_disclosure_digest,
    signed_default_pool_offers, signed_pool_offers,
};
use selection::PayoutChoice;
pub use selection::{PoolSelection, PoolSelectionCommitment};

/// A publicly disclosed implementation or operator participating in one Pool Offer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OfferComponentIdentity {
    component_id: String,
    display_name: String,
    version: String,
    source_url: HttpsUrl,
    license: String,
}

impl OfferComponentIdentity {
    /// Stable implementation or operator identifier.
    pub fn component_id(&self) -> &str {
        &self.component_id
    }

    /// Human-readable disclosed identity.
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    /// Disclosed source revision or release.
    pub fn version(&self) -> &str {
        &self.version
    }

    /// Public source repository.
    pub fn source_url(&self) -> &str {
        self.source_url.as_str()
    }

    /// SPDX-style license identifier.
    pub fn license(&self) -> &str {
        &self.license
    }

    fn validate(&self) -> Result<(), PoolOfferError> {
        validate_id(&self.component_id)?;
        validate_label(&self.display_name)?;
        validate_label(&self.version)?;
        validate_label(&self.license)?;
        Ok(())
    }
}

/// Immutable solo/direct-payout economics disclosed before Work Consent.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RewardPolicy {
    mode: String,
    selected_destination_basis_points: u16,
    pool_fee_basis_points: u16,
    service_fee_basis_points: u16,
    accepted_work_creates_revenue_claim: bool,
    creates_custodial_balance: bool,
    network_valid_result: String,
}

impl RewardPolicy {
    /// Stable allocation mode.
    pub fn mode(&self) -> &str {
        &self.mode
    }

    /// Mining Pool fee in basis points.
    pub fn pool_fee_basis_points(&self) -> u16 {
        self.pool_fee_basis_points
    }

    /// Direct payout allocation in basis points.
    pub fn selected_destination_basis_points(&self) -> u16 {
        self.selected_destination_basis_points
    }

    /// Gate service fee in basis points.
    pub fn service_fee_basis_points(&self) -> u16 {
        self.service_fee_basis_points
    }

    /// Whether lower-difficulty Accepted Work creates a claim on later revenue.
    pub fn accepted_work_creates_revenue_claim(&self) -> bool {
        self.accepted_work_creates_revenue_claim
    }

    /// Whether this profile creates a service-held reward balance.
    pub fn creates_custodial_balance(&self) -> bool {
        self.creates_custodial_balance
    }

    /// Outcome for a network-valid result.
    pub fn network_valid_result(&self) -> &str {
        &self.network_valid_result
    }

    fn validate(&self) -> Result<(), PoolOfferError> {
        let total = u32::from(self.selected_destination_basis_points)
            + u32::from(self.pool_fee_basis_points)
            + u32::from(self.service_fee_basis_points);
        if self.mode != "solo_direct_coinbase"
            || self.network_valid_result != "direct_coinbase_payout"
            || self.accepted_work_creates_revenue_claim
            || self.creates_custodial_balance
            || total != 10_000
        {
            return Err(PoolOfferError::InvalidRewardPolicy);
        }
        Ok(())
    }
}

/// One approved beneficiary that may be selected instead of a fresh address.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedBeneficiary {
    beneficiary_id: String,
    display_name: String,
    terms_url: HttpsUrl,
}

impl ApprovedBeneficiary {
    /// Stable beneficiary identity.
    pub fn beneficiary_id(&self) -> &str {
        &self.beneficiary_id
    }

    /// Human-readable beneficiary disclosure.
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    /// Terms governing this beneficiary selection.
    pub fn terms_url(&self) -> &str {
        self.terms_url.as_str()
    }

    fn validate(&self) -> Result<(), PoolOfferError> {
        validate_id(&self.beneficiary_id)?;
        validate_label(&self.display_name)?;
        Ok(())
    }
}

/// Payout choices and privacy behavior required by one offer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PayoutRequirements {
    selection_required: bool,
    ephemeral_by_default: bool,
    accepted_destination_types: Vec<String>,
    approved_beneficiaries: Vec<ApprovedBeneficiary>,
}

impl PayoutRequirements {
    /// Whether work is forbidden until a destination or beneficiary is selected.
    pub fn selection_required(&self) -> bool {
        self.selection_required
    }

    /// Whether clients must avoid persisting payout identity by default.
    pub fn ephemeral_by_default(&self) -> bool {
        self.ephemeral_by_default
    }

    /// Destination classes accepted by this offer.
    pub fn accepted_destination_types(&self) -> &[String] {
        &self.accepted_destination_types
    }

    /// Explicit beneficiaries approved in the signed offer.
    pub fn approved_beneficiaries(&self) -> &[ApprovedBeneficiary] {
        &self.approved_beneficiaries
    }

    fn validate(&self) -> Result<(), PoolOfferError> {
        if !self.selection_required
            || !self.ephemeral_by_default
            || self.accepted_destination_types
                != ["bitcoin_mainnet_address", "approved_beneficiary"]
        {
            return Err(PoolOfferError::InvalidPayoutRequirements);
        }
        for beneficiary in &self.approved_beneficiaries {
            beneficiary.validate()?;
        }
        Ok(())
    }
}

/// One Authority-approved Pool Offer disclosed as immutable signed terms.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PoolOffer {
    offer_id: String,
    mining_pool: OfferComponentIdentity,
    pool_adapter: OfferComponentIdentity,
    mining_transport: String,
    endpoint: String,
    reward_policy: RewardPolicy,
    payout_requirements: PayoutRequirements,
    privacy_terms_url: HttpsUrl,
    operator_terms_url: HttpsUrl,
}

impl PoolOffer {
    /// Stable offer identity within an Action Policy revision.
    pub fn offer_id(&self) -> &str {
        &self.offer_id
    }

    /// Disclosed Mining Pool identity, source, version, and license.
    pub fn mining_pool(&self) -> &OfferComponentIdentity {
        &self.mining_pool
    }

    /// Disclosed Pool Adapter identity, source, version, and license.
    pub fn pool_adapter(&self) -> &OfferComponentIdentity {
        &self.pool_adapter
    }

    /// Standard Worker-to-pool transport profile.
    pub fn mining_transport(&self) -> &str {
        &self.mining_transport
    }

    /// Challenge-scoped Worker endpoint.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Immutable economic allocation.
    pub fn reward_policy(&self) -> &RewardPolicy {
        &self.reward_policy
    }

    /// Required ephemeral payout choice.
    pub fn payout_requirements(&self) -> &PayoutRequirements {
        &self.payout_requirements
    }

    /// Privacy terms applying to pool participation.
    pub fn privacy_terms_url(&self) -> &str {
        self.privacy_terms_url.as_str()
    }

    /// Operator terms applying to pool participation.
    pub fn operator_terms_url(&self) -> &str {
        self.operator_terms_url.as_str()
    }

    fn validate(&self) -> Result<(), PoolOfferError> {
        validate_id(&self.offer_id)?;
        self.mining_pool.validate()?;
        self.pool_adapter.validate()?;
        if self.mining_transport != "stratum_v1" || !valid_stratum_endpoint(&self.endpoint) {
            return Err(PoolOfferError::InvalidPoolOffer);
        }
        self.reward_policy.validate()?;
        self.payout_requirements.validate()?;
        Ok(())
    }

    pub(crate) fn accepts_selection(&self, selection: &PoolSelection) -> bool {
        if self.offer_id != selection.offer_id {
            return false;
        }
        match &selection.payout {
            PayoutChoice::BitcoinAddress { .. } => self
                .payout_requirements
                .accepted_destination_types
                .iter()
                .any(|kind| kind == "bitcoin_mainnet_address"),
            PayoutChoice::ApprovedBeneficiary { beneficiary_id } => self
                .payout_requirements
                .approved_beneficiaries
                .iter()
                .any(|beneficiary| beneficiary.beneficiary_id == *beneficiary_id),
        }
    }
}

/// Visible approved terms paired with their compact Authority signature.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SignedPoolOfferSet {
    offers: Vec<PoolOffer>,
    signature: String,
}

impl SignedPoolOfferSet {
    /// Visible offers whose exact bytes are authenticated by `signature`.
    pub fn offers(&self) -> &[PoolOffer] {
        &self.offers
    }

    /// Exact compact Authority signature authenticating the visible offer set.
    pub fn signature(&self) -> &str {
        &self.signature
    }

    pub(crate) fn validate_shape(&self) -> Result<(), PoolOfferError> {
        validate_offers(&self.offers)?;
        if self.signature.split('.').count() != 3 {
            return Err(PoolOfferError::InvalidPoolOfferSignature);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PoolOfferSetClaims {
    iss: String,
    challenge_id: String,
    action_policy: String,
    offers: Vec<PoolOffer>,
    #[serde(default, skip_serializing_if = "is_false")]
    trusted_confirmation_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    material_replacement_digest_sha256: Option<Sha256Base64Url>,
    bwg_version: String,
}

/// Trusted result of verifying the complete visible Pool Offer set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedPoolOfferSet {
    authority_kid: String,
    issuer: String,
    challenge_id: String,
    action_policy: String,
    offers: Vec<PoolOffer>,
    trusted_confirmation_required: bool,
    maybe_material_replacement_digest_sha256: Option<Sha256Base64Url>,
}

impl VerifiedPoolOfferSet {
    /// Authority key that authenticated the offer set.
    pub fn authority_kid(&self) -> &str {
        &self.authority_kid
    }

    /// Authority issuer bound into the signature.
    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    /// Exact Work Challenge whose offer set was authenticated.
    pub fn challenge_id(&self) -> &str {
        &self.challenge_id
    }

    /// Immutable Action Policy revision owning these offers.
    pub fn action_policy(&self) -> &str {
        &self.action_policy
    }

    /// Exact authenticated offer list.
    pub fn offers(&self) -> &[PoolOffer] {
        &self.offers
    }

    /// Whether the authenticated terms require Authority-origin confirmation before work starts.
    pub fn trusted_confirmation_required(&self) -> bool {
        self.trusted_confirmation_required
    }

    pub fn maybe_material_replacement_digest_sha256(&self) -> Option<&str> {
        self.maybe_material_replacement_digest_sha256
            .as_ref()
            .map(Sha256Base64Url::as_str)
    }
}

/// Verifies that the visible offers exactly match the Authority-signed claims.
pub fn verify_pool_offer_set(
    signed: &SignedPoolOfferSet,
    expected_issuer: &str,
    expected_challenge_id: &str,
    expected_action_policy: ActionPolicy,
    trusted_keys: &[AuthorityJwk],
) -> Result<VerifiedPoolOfferSet, PoolOfferError> {
    signed.validate_shape()?;
    let (authority_kid, claims) = verify_authority_payload::<PoolOfferSetClaims>(
        &signed.signature,
        POOL_OFFER_SET_TYPE,
        trusted_keys,
    )?;
    validate_claims(&claims)?;
    if claims.iss != expected_issuer
        || claims.challenge_id != expected_challenge_id
        || claims.action_policy != expected_action_policy.id()
    {
        return Err(PoolOfferError::SignedOfferContextMismatch);
    }
    if claims.offers != signed.offers {
        return Err(PoolOfferError::SignedOfferMismatch);
    }
    Ok(VerifiedPoolOfferSet {
        authority_kid,
        issuer: claims.iss,
        challenge_id: claims.challenge_id,
        action_policy: claims.action_policy,
        offers: claims.offers,
        trusted_confirmation_required: claims.trusted_confirmation_required,
        maybe_material_replacement_digest_sha256: claims.material_replacement_digest_sha256,
    })
}

fn is_false(value: &bool) -> bool {
    !value
}

fn default_pool_offer(
    privacy_terms_url: &str,
    operator_terms_url: &str,
) -> Result<PoolOffer, PoolOfferError> {
    let offer = PoolOffer {
        offer_id: "pool_offer_hydra_solo_v1".to_owned(),
        mining_pool: OfferComponentIdentity {
            component_id: "p2poolv2_hydra".to_owned(),
            display_name: "Hydra / P2Pool v2".to_owned(),
            version: "v0.12.0+8eca024bde6c2de74620dce2f9cc7fb9a544c5c0".to_owned(),
            source_url: HttpsUrl::try_from(
                "https://github.com/p2poolv2/p2poolv2/tree/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0"
                    .to_owned(),
            )?,
            license: "AGPL-3.0-or-later".to_owned(),
        },
        pool_adapter: OfferComponentIdentity {
            component_id: "bwg_reference_stratum_adapter".to_owned(),
            display_name: "BWG Reference Stratum V1 Adapter".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            source_url: HttpsUrl::try_from(
                "https://github.com/bright-builds-llc/bitaxe-turnstile-system".to_owned(),
            )?,
            license: "MIT".to_owned(),
        },
        mining_transport: "stratum_v1".to_owned(),
        endpoint: "stratum+tcp://pool.example:3333/".to_owned(),
        reward_policy: RewardPolicy {
            mode: "solo_direct_coinbase".to_owned(),
            selected_destination_basis_points: 10_000,
            pool_fee_basis_points: 0,
            service_fee_basis_points: 0,
            accepted_work_creates_revenue_claim: false,
            creates_custodial_balance: false,
            network_valid_result: "direct_coinbase_payout".to_owned(),
        },
        payout_requirements: PayoutRequirements {
            selection_required: true,
            ephemeral_by_default: true,
            accepted_destination_types: vec![
                "bitcoin_mainnet_address".to_owned(),
                "approved_beneficiary".to_owned(),
            ],
            approved_beneficiaries: Vec::new(),
        },
        privacy_terms_url: HttpsUrl::try_from(privacy_terms_url.to_owned())?,
        operator_terms_url: HttpsUrl::try_from(operator_terms_url.to_owned())?,
    };
    offer.validate()?;
    Ok(offer)
}

fn validate_claims(claims: &PoolOfferSetClaims) -> Result<(), PoolOfferError> {
    if HttpsUrl::try_from(claims.iss.clone()).is_err()
        || ChallengeId::try_from(claims.challenge_id.clone()).is_err()
        || ActionPolicy::parse(&claims.action_policy).is_err()
        || claims.bwg_version != PROTOCOL_VERSION
        || claims.material_replacement_digest_sha256.is_some()
            && !claims.trusted_confirmation_required
    {
        return Err(PoolOfferError::InvalidPoolOfferClaims);
    }
    validate_offers(&claims.offers)
}

fn validate_offers(offers: &[PoolOffer]) -> Result<(), PoolOfferError> {
    if offers.is_empty() {
        return Err(PoolOfferError::EmptyPoolOfferSet);
    }
    for offer in offers {
        offer.validate()?;
    }
    let unique = offers
        .iter()
        .map(PoolOffer::offer_id)
        .collect::<std::collections::HashSet<_>>();
    if unique.len() != offers.len() {
        return Err(PoolOfferError::DuplicatePoolOffer);
    }
    Ok(())
}

fn validate_id(value: &str) -> Result<(), PoolOfferError> {
    if value.is_empty()
        || value.len() > MAXIMUM_ID_LENGTH
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(PoolOfferError::InvalidPoolOffer);
    }
    Ok(())
}

fn validate_label(value: &str) -> Result<(), PoolOfferError> {
    if value.is_empty() || value.len() > MAXIMUM_LABEL_LENGTH {
        return Err(PoolOfferError::InvalidPoolOffer);
    }
    Ok(())
}

fn valid_stratum_endpoint(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    url.scheme() == "stratum+tcp"
        && url.host().is_some()
        && url.port().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
}

#[cfg(test)]
pub(crate) fn test_signed_default_pool_offers(action_policy: ActionPolicy) -> SignedPoolOfferSet {
    let keys = crate::crypto_profile::AuthorityKeySet::try_from(
        crate::crypto_profile::test_support::authority_key_wires()
            .expect("embedded Authority keys should be valid JSON"),
    )
    .expect("embedded Authority keys should match the profile");
    let signer = AuthoritySigningKey::from_seed_base64url(
        "authority-a".to_owned(),
        "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
        &keys,
    )
    .expect("embedded Authority signing seed should match its public key");
    signed_default_pool_offers(
        &signer,
        "https://authority.example",
        "challenge_123abc",
        action_policy,
        "https://authority.example/privacy",
        "https://authority.example/terms",
    )
    .expect("embedded default Pool Offer should be valid")
}

#[derive(Debug, Error)]
pub enum PoolOfferError {
    #[error("Authority signing key is unavailable for Pool Offer terms")]
    SigningUnavailable,
    #[error("Pool Offer is invalid")]
    InvalidPoolOffer,
    #[error("Reward Policy is invalid")]
    InvalidRewardPolicy,
    #[error("Payout requirements are invalid")]
    InvalidPayoutRequirements,
    #[error("Payout selection is invalid")]
    InvalidPayoutSelection,
    #[error("Pool Offer set must not be empty")]
    EmptyPoolOfferSet,
    #[error("Pool Offer identities must be unique")]
    DuplicatePoolOffer,
    #[error("Pool Offer set signature is malformed")]
    InvalidPoolOfferSignature,
    #[error("Pool Offer claims are invalid")]
    InvalidPoolOfferClaims,
    #[error("visible Pool Offers differ from signed claims")]
    SignedOfferMismatch,
    #[error("signed Pool Offers do not belong to the expected Authority and Action Policy")]
    SignedOfferContextMismatch,
    #[error(transparent)]
    Crypto(#[from] CryptoProfileError),
    #[error(transparent)]
    Url(#[from] crate::web_url::WebUrlError),
}
