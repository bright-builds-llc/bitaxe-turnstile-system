use super::*;

const TRUSTED_CONSENT_CEREMONY_SECONDS: u64 = 120;
const TRUSTED_CONSENT_VERIFICATION_LEASE_SECONDS: u64 = 30;

impl AuthorityApplication {
    pub(crate) async fn begin_trusted_consent(
        &self,
        challenge_id: &ChallengeId,
        request: TrustedConsentBeginRequest,
        now: u64,
    ) -> Result<TrustedConsentBeginResponse, AuthorityApplicationError> {
        self.repository
            .retire_expired_trusted_consent_ceremonies(now)
            .await?;
        let challenge = self.repository.challenge(challenge_id).await?;
        ensure_challenge_is_awaiting_consent(
            self.repository
                .challenge_lifecycle(challenge_id, now)
                .await?
                .state(),
        )?;
        let signed_offers = challenge
            .maybe_pool_offers()
            .ok_or(TrustedConsentError::ConfirmationNotRequired)?;
        let verified_offers = verify_pool_offer_set(
            signed_offers,
            self.config.issuer(),
            challenge.challenge_id(),
            challenge.action_policy(),
            self.config.verification_keys(),
        )?;
        if !verified_offers.trusted_confirmation_required() {
            return Err(TrustedConsentError::ConfirmationNotRequired.into());
        }
        let binding = binding_for_challenge(&challenge, self.config.issuer())?;
        if request.reason != binding.reason().as_str()
            || request.pool_offer_set_signature_sha256 != binding.pool_offer_set_signature_sha256()
            || request.authority_origin != binding.authority_origin()
            || now >= challenge.expires_at_unix_seconds()
        {
            return Err(TrustedConsentError::BindingMismatch.into());
        }
        if let Some(existing) = self
            .repository
            .maybe_trusted_consent_by_binding(&binding)
            .await?
        {
            return begin_response(existing);
        }
        let expires_at = now
            .checked_add(TRUSTED_CONSENT_CEREMONY_SECONDS)
            .ok_or(TrustedConsentError::InvalidDeadline)?
            .min(challenge.expires_at_unix_seconds());
        let ceremony = TrustedConsentCeremony::pending(
            TrustedConsentCeremonyId::try_from(format!(
                "ceremony_{}",
                uuid::Uuid::new_v4().simple()
            ))?,
            binding,
            now,
            expires_at,
        )?;
        let reservation_owner = TrustedConsentOperationOwner::random();
        let reservation_lease_expires_at = now
            .checked_add(TRUSTED_CONSENT_VERIFICATION_LEASE_SECONDS)
            .ok_or(TrustedConsentError::InvalidDeadline)?;
        match self
            .repository
            .reserve_trusted_consent_ceremony(ReserveTrustedConsentCeremony {
                ceremony: &ceremony,
                operation_owner: reservation_owner,
                lease_expires_at_unix_seconds: reservation_lease_expires_at,
            })
            .await?
        {
            TrustedConsentReservation::Claimed => {}
            TrustedConsentReservation::Existing(existing) => return begin_response(*existing),
            TrustedConsentReservation::InProgress => {
                return Err(TrustedConsentError::CeremonyInProgress.into());
            }
        }
        let verifier = Arc::clone(&self.trusted_consent_verifier);
        let challenge_id_for_verifier = challenge.challenge_id().to_owned();
        let start_task = tokio::task::spawn_blocking(move || {
            verifier.begin(uuid::Uuid::new_v4(), &challenge_id_for_verifier)
        })
        .await;
        let started = match start_task {
            Ok(Ok(started)) => started,
            Ok(Err(error)) => {
                self.repository
                    .abandon_trusted_consent_reservation(ceremony.ceremony_id(), reservation_owner)
                    .await?;
                return Err(error.into());
            }
            Err(_) => {
                self.repository
                    .abandon_trusted_consent_reservation(ceremony.ceremony_id(), reservation_owner)
                    .await?;
                return Err(TrustedConsentError::WebauthnUnavailable.into());
            }
        };
        let initialized_at = current_unix_seconds()?;
        begin_response(
            self.repository
                .initialize_trusted_consent_ceremony(
                    ceremony.ceremony_id(),
                    reservation_owner,
                    &started.creation_options,
                    &started.registration_state,
                    initialized_at,
                )
                .await?,
        )
    }

    pub(crate) async fn finish_trusted_consent(
        &self,
        challenge_id: &ChallengeId,
        ceremony_id: &TrustedConsentCeremonyId,
        credential: serde_json::Value,
        now: u64,
    ) -> Result<TrustedConsentFinishResponse, AuthorityApplicationError> {
        self.repository
            .retire_expired_trusted_consent_ceremonies(now)
            .await?;
        let record = self
            .repository
            .trusted_consent_ceremony(ceremony_id)
            .await?;
        if record.ceremony().binding().challenge_id() != challenge_id.as_str() {
            return Err(TrustedConsentError::BindingMismatch.into());
        }
        let ceremony = match record {
            TrustedConsentCeremonyRecord::Starting { .. } => {
                return Err(TrustedConsentError::CeremonyInProgress.into());
            }
            TrustedConsentCeremonyRecord::Pending { ceremony, .. }
            | TrustedConsentCeremonyRecord::Verifying { ceremony, .. } => ceremony,
            TrustedConsentCeremonyRecord::Verified { ceremony } => {
                return self.finish_response(&ceremony, now).await;
            }
            TrustedConsentCeremonyRecord::Failed { .. } => {
                return Err(TrustedConsentError::CeremonyFailed.into());
            }
        };
        ensure_challenge_is_awaiting_consent(
            self.repository
                .challenge_lifecycle(challenge_id, now)
                .await?
                .state(),
        )?;
        ceremony.clone().verify(now)?;
        let verification_owner = TrustedConsentOperationOwner::random();
        let lease_expires_at = now
            .checked_add(TRUSTED_CONSENT_VERIFICATION_LEASE_SECONDS)
            .ok_or(TrustedConsentError::InvalidDeadline)?;
        let claimed = self
            .repository
            .claim_trusted_consent_verification(
                ceremony_id,
                verification_owner,
                now,
                lease_expires_at,
            )
            .await?;
        let (claimed_ceremony, registration_state) = match claimed {
            TrustedConsentVerificationClaim::Claimed(TrustedConsentCeremonyRecord::Verifying {
                ceremony,
                registration_state,
                ..
            }) => (ceremony, registration_state),
            TrustedConsentVerificationClaim::Claimed(_) => {
                return Err(TrustedConsentError::InvalidWebauthnState.into());
            }
            TrustedConsentVerificationClaim::Verified(verified) => {
                return self
                    .finish_response(verified.ceremony(), current_unix_seconds()?)
                    .await;
            }
            TrustedConsentVerificationClaim::InProgress => {
                return Err(TrustedConsentError::CeremonyInProgress.into());
            }
            TrustedConsentVerificationClaim::Failed => {
                return Err(TrustedConsentError::CeremonyFailed.into());
            }
        };
        let verifier = Arc::clone(&self.trusted_consent_verifier);
        let verification_task =
            tokio::task::spawn_blocking(move || verifier.finish(credential, registration_state))
                .await;
        let verification = match verification_task {
            Ok(verification) => verification,
            Err(_) => {
                let failed_at = current_unix_seconds()?;
                self.repository
                    .fail_trusted_consent_ceremony(ceremony_id, verification_owner, failed_at)
                    .await?;
                return Err(TrustedConsentError::WebauthnUnavailable.into());
            }
        };
        let verified = match verification {
            Ok(verified) => verified,
            Err(error) => {
                let failed_at = current_unix_seconds()?;
                self.repository
                    .fail_trusted_consent_ceremony(ceremony_id, verification_owner, failed_at)
                    .await?;
                return Err(error.into());
            }
        };
        if !verified.user_present
            || !verified.user_verified
            || verified.attestation != "trusted_non_self"
        {
            let failed_at = current_unix_seconds()?;
            self.repository
                .fail_trusted_consent_ceremony(ceremony_id, verification_owner, failed_at)
                .await?;
            return Err(TrustedConsentError::WebauthnRejected.into());
        }
        let completed_at = current_unix_seconds()?;
        if completed_at >= lease_expires_at {
            self.repository
                .fail_trusted_consent_ceremony(ceremony_id, verification_owner, completed_at)
                .await?;
            return Err(TrustedConsentError::CeremonyFailed.into());
        }
        if let Err(error) = claimed_ceremony.verify(completed_at) {
            self.repository
                .fail_trusted_consent_ceremony(ceremony_id, verification_owner, completed_at)
                .await?;
            return Err(error.into());
        }
        if ensure_challenge_is_awaiting_consent(
            self.repository
                .challenge_lifecycle(challenge_id, completed_at)
                .await?
                .state(),
        )
        .is_err()
        {
            self.repository
                .fail_trusted_consent_ceremony(ceremony_id, verification_owner, completed_at)
                .await?;
            return Err(TrustedConsentError::CeremonyFailed.into());
        }
        let completed = self
            .repository
            .complete_trusted_consent_ceremony(ceremony_id, verification_owner, completed_at)
            .await?;
        self.finish_response(completed.ceremony(), completed_at)
            .await
    }

    async fn finish_response(
        &self,
        ceremony: &TrustedConsentCeremony,
        now_unix_seconds: u64,
    ) -> Result<TrustedConsentFinishResponse, AuthorityApplicationError> {
        if now_unix_seconds >= ceremony.binding().challenge_expires_at_unix_seconds() {
            return Err(TrustedConsentError::CeremonyExpired.into());
        }
        if let Some(compact_receipt) = self
            .repository
            .maybe_trusted_consent_receipt(ceremony.ceremony_id())
            .await?
        {
            return Ok(receipt_response(ceremony, compact_receipt));
        }
        let signer = self
            .config
            .maybe_signer()
            .ok_or(TrustedConsentError::ReceiptUnavailable)?;
        let compact_receipt =
            sign_trusted_consent_receipt(&signer, self.config.issuer(), ceremony)?;
        let issued_at = ceremony
            .verified_at_unix_seconds()
            .ok_or(TrustedConsentError::ReceiptUnavailable)?;
        let compact_receipt = self
            .repository
            .persist_trusted_consent_receipt(
                ceremony.ceremony_id(),
                &compact_receipt,
                issued_at,
                ceremony.binding().challenge_expires_at_unix_seconds(),
            )
            .await?;
        Ok(receipt_response(ceremony, compact_receipt))
    }
}

fn receipt_response(
    ceremony: &TrustedConsentCeremony,
    compact_receipt: String,
) -> TrustedConsentFinishResponse {
    TrustedConsentFinishResponse {
        ceremony_id: ceremony.ceremony_id().as_str().to_owned(),
        status: ceremony.status(),
        trusted_consent_receipt: compact_receipt,
    }
}

pub(super) fn authority_origin(issuer: &str) -> Result<String, TrustedConsentError> {
    let parsed =
        url::Url::parse(issuer).map_err(|_| TrustedConsentError::InvalidAuthorityOrigin)?;
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" {
        return Err(TrustedConsentError::InvalidAuthorityOrigin);
    }
    Ok(origin)
}

fn begin_response(
    record: TrustedConsentCeremonyRecord,
) -> Result<TrustedConsentBeginResponse, AuthorityApplicationError> {
    let (ceremony, public_key) = match record {
        TrustedConsentCeremonyRecord::Pending {
            ceremony,
            creation_options,
            registration_state,
        } => {
            // The browser receives only creation options; this loaded copy remains server-only.
            drop(registration_state);
            (ceremony, creation_options)
        }
        TrustedConsentCeremonyRecord::Verifying {
            ceremony,
            creation_options,
            ..
        } => (ceremony, creation_options),
        TrustedConsentCeremonyRecord::Starting { .. } => {
            return Err(TrustedConsentError::CeremonyInProgress.into());
        }
        TrustedConsentCeremonyRecord::Verified { .. }
        | TrustedConsentCeremonyRecord::Failed { .. } => {
            return Err(TrustedConsentError::CeremonyAlreadyTerminal.into());
        }
    };
    Ok(TrustedConsentBeginResponse {
        ceremony_id: ceremony.ceremony_id().as_str().to_owned(),
        authority_disclosure_digest_sha256: ceremony
            .binding()
            .disclosure_digest_sha256()
            .to_owned(),
        public_key,
        expires_at_unix_seconds: ceremony.expires_at_unix_seconds(),
    })
}

pub(super) fn authoritative_disclosure_digest(
    challenge: &crate::challenge::WorkChallengeDescriptor,
) -> Result<String, AuthorityApplicationError> {
    let bytes =
        serde_json::to_vec(challenge).map_err(|_| TrustedConsentError::InvalidWebauthnState)?;
    Ok(URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, &bytes)))
}

pub(super) fn binding_for_challenge(
    challenge: &crate::challenge::WorkChallengeDescriptor,
    issuer: &str,
) -> Result<TrustedConsentBinding, AuthorityApplicationError> {
    let signed_offers = challenge
        .maybe_pool_offers()
        .ok_or(TrustedConsentError::ConfirmationNotRequired)?;
    let reason = if challenge.action_policy().requires_trusted_confirmation() {
        TrustedConsentReason::ElevatedWork
    } else {
        TrustedConsentReason::MaterialPoolTerms
    };
    Ok(TrustedConsentBinding::try_from(
        TrustedConsentBindingInput {
            challenge_id: challenge.challenge_id().to_owned(),
            disclosure_digest_sha256: authoritative_disclosure_digest(challenge)?,
            pool_offer_set_signature_sha256: URL_SAFE_NO_PAD.encode(digest::digest(
                &digest::SHA256,
                signed_offers.signature().as_bytes(),
            )),
            reason: reason.as_str().to_owned(),
            authority_origin: authority_origin(issuer)?,
            challenge_expires_at_unix_seconds: challenge.expires_at_unix_seconds(),
        },
    )?)
}

fn ensure_challenge_is_awaiting_consent(
    state: ChallengeLifecycleState,
) -> Result<(), TrustedConsentError> {
    if state != ChallengeLifecycleState::Issued {
        return Err(TrustedConsentError::CeremonyFailed);
    }
    Ok(())
}
