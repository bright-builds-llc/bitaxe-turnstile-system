//! Claimant Work Session control that issues signed Worker Leases (ADR-0106).

use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::digest;
use thiserror::Error;

use super::{AuthorityApplication, AuthorityApplicationError, claimant_key};
use crate::{
    challenge::ChallengeId,
    crypto_profile::{p256_jwk_thumbprint, verify_work_session_proof},
    lifecycle::{WORK_LEASE_MAX_DURATION_SECONDS, WorkLease, WorkerClock, WorkerInterruption},
    progress::WorkSessionId,
    work_lease_authorization::{
        AuthorizationSequence, ControlSessionBinding, WorkLeaseAuthoritySigner,
        WorkLeaseAuthorizationError, WorkerLeaseGrant, WorkerLeaseRenewal, WorkerStratumV1,
    },
};

const WORK_SESSION_PROOF_FRESHNESS_SECONDS: u64 = 60;
const CLAIMANT_SESSION_DOMAIN: &[u8] = b"BWG/0.1 claimant Work Session\0";

/// One claimant-controlled Work Session operation and its URL path segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkSessionOperation {
    Start,
    Resume,
    Renew,
    Pause,
    Cancel,
}

impl WorkSessionOperation {
    pub(crate) fn path_segment(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Resume => "resume",
            Self::Renew => "renew",
            Self::Pause => "pause",
            Self::Cancel => "cancel",
        }
    }
}

/// Lease facts the Pool Adapter binds into one Worker's Stratum V1 credentials.
pub struct WorkerStratumRequest {
    pub session_id: WorkSessionId,
    pub lease: WorkLease,
    pub clock: WorkerClock,
    /// Authority wall-clock reading at which `clock` was taken, ordering credential generations.
    pub now_unix_milliseconds: u64,
    pub lease_expires_at_unix_seconds: u64,
    pub challenge_expires_at_unix_seconds: u64,
}

/// The Pool Adapter could not issue or register Worker credentials.
#[derive(Debug, Error)]
#[error("Pool Adapter could not issue Worker Stratum credentials")]
pub struct WorkerStratumUnavailable;

/// Port through which the Authority asks the Pool Adapter for lease-scoped credentials.
#[async_trait]
pub trait WorkerStratumCredentialPort: Send + Sync {
    /// Issues and registers credentials for one started lease.
    async fn issue(
        &self,
        request: WorkerStratumRequest,
    ) -> Result<WorkerStratumV1, WorkerStratumUnavailable>;

    /// Extends the registered and live credentials of one renewed lease, keeping the password.
    async fn renew(&self, request: WorkerStratumRequest) -> Result<(), WorkerStratumUnavailable>;
}

/// Work Lease Authority signer and Pool Adapter port that enable claimant routes.
#[derive(Clone)]
pub struct WorkerLeaseIssuance {
    signer: WorkLeaseAuthoritySigner,
    stratum: Arc<dyn WorkerStratumCredentialPort>,
}

impl WorkerLeaseIssuance {
    /// Pairs one Work Lease Authority signer with the Pool Adapter credential port.
    pub fn new(
        signer: WorkLeaseAuthoritySigner,
        stratum: Arc<dyn WorkerStratumCredentialPort>,
    ) -> Self {
        Self { signer, stratum }
    }
}

/// Verified request facts every claimant Work Session route needs.
pub(crate) struct ClaimantWorkSessionRequest<'a> {
    pub challenge_id: &'a ChallengeId,
    pub operation: WorkSessionOperation,
    pub compact_proof: &'a str,
    pub body: &'a [u8],
    pub now: u64,
}

impl AuthorityApplication {
    /// Enables claimant Start, Resume and Renew with a role-separated Work Lease key.
    pub fn with_worker_lease_issuance(
        mut self,
        issuance: WorkerLeaseIssuance,
    ) -> Result<Self, AuthorityApplicationError> {
        if self
            .config
            .verification_keys()
            .iter()
            .any(|key| key.public_key() == issuance.signer.public_key())
        {
            return Err(AuthorityApplicationError::WorkLeaseKeyReused);
        }
        self.maybe_worker_leases = Some(issuance);
        Ok(self)
    }

    /// Verifies the claimant proof for one exact Work Session request and consumes it.
    pub(crate) async fn verify_claimant_work_session_request(
        &self,
        request: ClaimantWorkSessionRequest<'_>,
    ) -> Result<(), AuthorityApplicationError> {
        let proof = verify_work_session_proof(request.compact_proof)
            .map_err(|_| AuthorityApplicationError::InvalidClaimantProof)?;
        let expected_uri = self
            .config
            .work_session_url(request.challenge_id, request.operation);
        if proof.challenge_id() != request.challenge_id.as_str()
            || proof.http_uri() != expected_uri
            || proof.request_sha256() != sha256_base64url(request.body)
        {
            return Err(AuthorityApplicationError::WrongIssuanceProofRequest);
        }
        if request.now.abs_diff(proof.issued_at()) > WORK_SESSION_PROOF_FRESHNESS_SECONDS {
            return Err(AuthorityApplicationError::StaleIssuanceProof);
        }
        let descriptor = self.repository.challenge(request.challenge_id).await?;
        if proof.claimant_jkt() != p256_jwk_thumbprint(&claimant_key(&descriptor)?) {
            return Err(AuthorityApplicationError::WrongClaimantKey);
        }
        let proof_expires_at = proof
            .issued_at()
            .checked_add(WORK_SESSION_PROOF_FRESHNESS_SECONDS)
            .ok_or(AuthorityApplicationError::TimeOverflow)?;
        self.repository
            .consume_issuance_proof(
                request.challenge_id,
                proof.proof_id(),
                proof_expires_at,
                request.now,
            )
            .await?;
        Ok(())
    }

    /// Starts the claimant's Work Session lease and returns its signed device grant.
    pub(crate) async fn claimant_start_work(
        &self,
        challenge_id: &ChallengeId,
        control_session: &ControlSessionBinding,
        maybe_trusted_consent_receipt: Option<&str>,
    ) -> Result<WorkerLeaseGrant, AuthorityApplicationError> {
        let issuance = self.worker_leases()?;
        let session_id = claimant_session_id(challenge_id)?;
        match self.insert_work_session(challenge_id, &session_id).await {
            Ok(()) | Err(AuthorityApplicationError::DuplicateWorkSession) => {}
            Err(error) => return Err(error),
        }
        let clock = authority_clock(control_session)?;
        let adapter = self.simulated_pool_adapter();
        let lease = match maybe_trusted_consent_receipt {
            Some(receipt) => {
                adapter
                    .start_lease_with_trusted_consent(&session_id, clock.clone(), receipt)
                    .await?
            }
            None => adapter.start_lease(&session_id, clock.clone()).await?,
        };
        self.grant_or_release(
            issuance,
            challenge_id,
            session_id,
            lease,
            clock,
            control_session,
        )
        .await
    }

    /// Confirms the paused session's restoration and starts a fresh lease.
    pub(crate) async fn claimant_resume_work(
        &self,
        challenge_id: &ChallengeId,
        control_session: &ControlSessionBinding,
    ) -> Result<WorkerLeaseGrant, AuthorityApplicationError> {
        let issuance = self.worker_leases()?;
        let session_id = claimant_session_id(challenge_id)?;
        let adapter = self.simulated_pool_adapter();
        adapter.confirm_restored(&session_id).await?;
        let clock = authority_clock(control_session)?;
        let lease = adapter.start_lease(&session_id, clock.clone()).await?;
        self.grant_or_release(
            issuance,
            challenge_id,
            session_id,
            lease,
            clock,
            control_session,
        )
        .await
    }

    /// Renews the exact active lease under the same control-session continuity.
    pub(crate) async fn claimant_renew_work(
        &self,
        challenge_id: &ChallengeId,
        control_session: &ControlSessionBinding,
        lease_id: String,
    ) -> Result<WorkerLeaseRenewal, AuthorityApplicationError> {
        let issuance = self.worker_leases()?;
        let session_id = claimant_session_id(challenge_id)?;
        let clock = authority_clock(control_session)?;
        let lease = self
            .simulated_pool_adapter()
            .renew_lease(&session_id, &lease_id, clock.clone())
            .await?;
        let request = self
            .worker_stratum_request(challenge_id, session_id, lease, clock)
            .await?;
        issuance
            .stratum
            .renew(request)
            .await
            .map_err(|_| AuthorityApplicationError::WorkerStratumUnavailable)?;
        let sequence = self.next_sequence(issuance).await?;
        Ok(issuance.signer.sign_renewal(
            lease_id,
            challenge_id.as_str(),
            control_session,
            sequence,
        )?)
    }

    /// Returns the signed grant, or releases a lease whose grant never left the Authority.
    ///
    /// Without a grant the Worker can't be mining under this lease, so the session is
    /// stopped and marked restored and a retried Start or Resume can lease again.
    async fn grant_or_release(
        &self,
        issuance: &WorkerLeaseIssuance,
        challenge_id: &ChallengeId,
        session_id: WorkSessionId,
        lease: WorkLease,
        clock: WorkerClock,
        control_session: &ControlSessionBinding,
    ) -> Result<WorkerLeaseGrant, AuthorityApplicationError> {
        let released_session_id = session_id.clone();
        let result = self
            .signed_grant(
                issuance,
                challenge_id,
                session_id,
                lease,
                clock,
                control_session,
            )
            .await;
        let Err(error) = result else {
            return result;
        };
        let adapter = self.simulated_pool_adapter();
        let released = match adapter
            .interrupt(
                &released_session_id,
                WorkerInterruption::TransportDisconnected,
            )
            .await
        {
            Ok(()) => adapter.confirm_restored(&released_session_id).await,
            Err(release_error) => Err(release_error),
        };
        if let Err(release_error) = released {
            tracing::error!(%release_error, %error, "ungranted Work Lease was not released");
        }
        Err(error)
    }

    async fn signed_grant(
        &self,
        issuance: &WorkerLeaseIssuance,
        challenge_id: &ChallengeId,
        session_id: WorkSessionId,
        lease: WorkLease,
        clock: WorkerClock,
        control_session: &ControlSessionBinding,
    ) -> Result<WorkerLeaseGrant, AuthorityApplicationError> {
        let lease_id = lease.lease_id().to_owned();
        let request = self
            .worker_stratum_request(challenge_id, session_id, lease, clock)
            .await?;
        let stratum = issuance
            .stratum
            .issue(request)
            .await
            .map_err(|_| AuthorityApplicationError::WorkerStratumUnavailable)?;
        let sequence = self.next_sequence(issuance).await?;
        Ok(issuance.signer.sign_grant(
            lease_id,
            challenge_id.as_str().to_owned(),
            stratum,
            control_session,
            sequence,
        )?)
    }

    /// Binds the Stratum window to the lease clock's own reading, so the Pool Adapter's
    /// wall-clock advance reproduces the Authority's lease clock without drift.
    async fn worker_stratum_request(
        &self,
        challenge_id: &ChallengeId,
        session_id: WorkSessionId,
        lease: WorkLease,
        clock: WorkerClock,
    ) -> Result<WorkerStratumRequest, AuthorityApplicationError> {
        let descriptor = self.repository.challenge(challenge_id).await?;
        let now_unix_milliseconds = clock.monotonic_milliseconds();
        Ok(WorkerStratumRequest {
            session_id,
            lease,
            clock,
            now_unix_milliseconds,
            lease_expires_at_unix_seconds: (now_unix_milliseconds / 1_000)
                .checked_add(WORK_LEASE_MAX_DURATION_SECONDS)
                .ok_or(AuthorityApplicationError::TimeOverflow)?,
            challenge_expires_at_unix_seconds: descriptor.expires_at_unix_seconds(),
        })
    }

    async fn next_sequence(
        &self,
        issuance: &WorkerLeaseIssuance,
    ) -> Result<AuthorizationSequence, AuthorityApplicationError> {
        let sequence = self
            .repository
            .allocate_work_lease_authorization_sequence(issuance.signer.kid())
            .await?;
        Ok(AuthorizationSequence::try_from(sequence)?)
    }

    fn worker_leases(&self) -> Result<&WorkerLeaseIssuance, AuthorityApplicationError> {
        self.maybe_worker_leases
            .as_ref()
            .ok_or(AuthorityApplicationError::WorkLeaseUnavailable)
    }
}

/// Derives the one claimant Work Session of a challenge.
fn claimant_session_id(
    challenge_id: &ChallengeId,
) -> Result<WorkSessionId, AuthorityApplicationError> {
    let mut input = CLAIMANT_SESSION_DOMAIN.to_vec();
    input.extend_from_slice(challenge_id.as_str().as_bytes());
    Ok(WorkSessionId::try_from(format!(
        "session_{}",
        sha256_base64url(&input)
    ))?)
}

/// Reads the lease clock from the Authority's clock under the possession continuity.
fn authority_clock(
    control_session: &ControlSessionBinding,
) -> Result<WorkerClock, AuthorityApplicationError> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AuthorityApplicationError::ClockUnavailable)?
        .as_millis();
    let milliseconds =
        u64::try_from(milliseconds).map_err(|_| AuthorityApplicationError::ClockUnavailable)?;
    Ok(WorkerClock::new(control_session.as_str(), milliseconds)?)
}

fn sha256_base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, bytes).as_ref())
}

impl From<WorkLeaseAuthorizationError> for AuthorityApplicationError {
    fn from(error: WorkLeaseAuthorizationError) -> Self {
        Self::WorkLeaseAuthorization(error)
    }
}
