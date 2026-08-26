use super::*;

fn offer() -> Result<PoolOffer, PoolOfferError> {
    default_pool_offer(
        "https://authority.example/privacy",
        "https://authority.example/terms",
    )
}

#[test]
fn reward_policy_rejects_every_unsafe_economic_shape() -> Result<(), PoolOfferError> {
    // Arrange
    let valid = offer()?.reward_policy;
    let mut wrong_mode = valid.clone();
    wrong_mode.mode = "pplns".to_owned();
    let mut wrong_network_result = valid.clone();
    wrong_network_result.network_valid_result = "custodial_credit".to_owned();
    let mut revenue_claim = valid.clone();
    revenue_claim.accepted_work_creates_revenue_claim = true;
    let mut custodial = valid.clone();
    custodial.creates_custodial_balance = true;
    let mut allocation_drift = valid.clone();
    allocation_drift.pool_fee_basis_points = 1;

    // Act
    let results = [
        wrong_mode,
        wrong_network_result,
        revenue_claim,
        custodial,
        allocation_drift,
    ]
    .map(|policy| policy.validate());

    // Assert
    assert!(
        results
            .into_iter()
            .all(|result| { matches!(result, Err(PoolOfferError::InvalidRewardPolicy)) })
    );
    Ok(())
}

#[test]
fn payout_requirements_reject_hidden_or_persistent_choices() -> Result<(), PoolOfferError> {
    // Arrange
    let valid = offer()?.payout_requirements;
    let mut optional = valid.clone();
    optional.selection_required = false;
    let mut persistent = valid.clone();
    persistent.ephemeral_by_default = false;
    let mut hidden_type = valid.clone();
    hidden_type.accepted_destination_types = vec!["internal_balance".to_owned()];
    let mut invalid_beneficiary = valid;
    invalid_beneficiary
        .approved_beneficiaries
        .push(ApprovedBeneficiary {
            beneficiary_id: "beneficiary with spaces".to_owned(),
            display_name: "Beneficiary".to_owned(),
            terms_url: HttpsUrl::try_from(
                "https://authority.example/beneficiary-terms".to_owned(),
            )?,
        });

    // Act
    let results = [optional, persistent, hidden_type, invalid_beneficiary]
        .map(|requirements| requirements.validate());

    // Assert
    assert!(results.into_iter().all(|result| result.is_err()));
    Ok(())
}

#[test]
fn pool_offer_rejects_invalid_component_identity() -> Result<(), PoolOfferError> {
    // Arrange
    let mut invalid_identity = offer()?;
    invalid_identity.pool_adapter.component_id = "adapter with spaces".to_owned();

    // Act / Assert
    assert!(invalid_identity.validate().is_err());
    Ok(())
}

#[test]
fn pool_offer_rejects_non_stratum_endpoint() -> Result<(), PoolOfferError> {
    // Arrange
    let mut invalid_endpoint = offer()?;
    invalid_endpoint.endpoint = "https://pool.example".to_owned();

    // Act / Assert
    assert!(invalid_endpoint.validate().is_err());
    Ok(())
}

#[test]
fn pool_offer_set_rejects_empty_list() {
    // Arrange / Act / Assert
    assert!(matches!(
        validate_offers(&[]),
        Err(PoolOfferError::EmptyPoolOfferSet)
    ));
}

#[test]
fn pool_offer_set_rejects_duplicate_identity() -> Result<(), PoolOfferError> {
    // Arrange
    let offer = offer()?;
    let duplicate = vec![offer.clone(), offer];

    // Act / Assert
    assert!(matches!(
        validate_offers(&duplicate),
        Err(PoolOfferError::DuplicatePoolOffer)
    ));
    Ok(())
}

#[test]
fn elevated_signed_offer_requires_trusted_confirmation() -> Result<(), PoolOfferError> {
    // Arrange
    let signed = test_signed_default_pool_offers(ActionPolicy::AccountCreationElevatedV1);
    let keys = crate::crypto_profile::AuthorityKeySet::try_from(
        crate::crypto_profile::test_support::authority_key_wires()
            .expect("embedded Authority keys should be valid JSON"),
    )
    .expect("embedded Authority keys should match the profile");

    // Act
    let verified = verify_pool_offer_set(
        &signed,
        "https://authority.example",
        "challenge_123abc",
        ActionPolicy::AccountCreationElevatedV1,
        keys.keys(),
    )?;

    // Assert
    assert!(verified.trusted_confirmation_required());
    Ok(())
}

#[test]
fn signed_claims_reject_wrong_issuer_challenge_policy_and_version() -> Result<(), PoolOfferError> {
    // Arrange
    let valid = PoolOfferSetClaims {
        iss: "https://authority.example".to_owned(),
        challenge_id: "challenge_claims_01".to_owned(),
        action_policy: ActionPolicy::ACCOUNT_CREATION_LIGHT_V1.to_owned(),
        offers: vec![offer()?],
        trusted_confirmation_required: false,
        bwg_version: PROTOCOL_VERSION.to_owned(),
    };
    let mut issuer = valid.clone();
    issuer.iss = "http://authority.example".to_owned();
    let mut challenge = valid.clone();
    challenge.challenge_id = "not-a-challenge".to_owned();
    let mut policy = valid.clone();
    policy.action_policy = "account-creation.unknown.v1".to_owned();
    let mut version = valid;
    version.bwg_version = "BWG/9".to_owned();

    // Act
    let results = [issuer, challenge, policy, version].map(|claims| validate_claims(&claims));

    // Assert
    assert!(
        results
            .into_iter()
            .all(|result| { matches!(result, Err(PoolOfferError::InvalidPoolOfferClaims)) })
    );
    Ok(())
}

#[test]
fn approved_beneficiary_must_be_present_in_the_signed_offer() -> Result<(), PoolOfferError> {
    // Arrange
    let mut offer = offer()?;
    offer
        .payout_requirements
        .approved_beneficiaries
        .push(ApprovedBeneficiary {
            beneficiary_id: "approved_beneficiary".to_owned(),
            display_name: "Approved beneficiary".to_owned(),
            terms_url: HttpsUrl::try_from(
                "https://authority.example/beneficiary-terms".to_owned(),
            )?,
        });
    let approved = PoolSelection::approved_beneficiary(
        offer.offer_id.clone(),
        "approved_beneficiary".to_owned(),
    )?;
    let unknown = PoolSelection::approved_beneficiary(
        offer.offer_id.clone(),
        "unknown_beneficiary".to_owned(),
    )?;

    // Act / Assert
    assert!(offer.accepts_selection(&approved));
    assert!(!offer.accepts_selection(&unknown));
    Ok(())
}

#[test]
fn signed_offer_shape_rejects_a_non_compact_signature() -> Result<(), PoolOfferError> {
    // Arrange
    let signed = SignedPoolOfferSet {
        offers: vec![offer()?],
        signature: "not-a-jws".to_owned(),
    };

    // Act / Assert
    assert!(matches!(
        signed.validate_shape(),
        Err(PoolOfferError::InvalidPoolOfferSignature)
    ));
    Ok(())
}
