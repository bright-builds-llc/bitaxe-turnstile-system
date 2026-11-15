//! In-process Pool Adapter side of the Authority's Worker Stratum credential port.

use async_trait::async_trait;

use super::{
    PostgresStratumSessionRegistry, StratumCredentialIssuer, StratumLeaseContext,
    StratumSessionExtension, StratumV1Error,
};
use crate::{
    authority::{
        PoolSelectionIntake, WorkerStratumCredentialPort, WorkerStratumRequest,
        WorkerStratumUnavailable,
    },
    challenge::ChallengeId,
    progress::WorkSessionId,
    work_lease_authorization::{WorkerStratumV1, valid_stratum_endpoint},
};

/// Issues lease-scoped credentials and registers their verifier before the grant leaves.
pub struct PoolAdapterWorkerStratum {
    endpoint: String,
    issuer: StratumCredentialIssuer,
    registry: PostgresStratumSessionRegistry,
}

impl PoolAdapterWorkerStratum {
    /// Binds the Worker-facing proxy endpoint to its credential key and session registry.
    pub fn new(
        endpoint: String,
        issuer: StratumCredentialIssuer,
        registry: PostgresStratumSessionRegistry,
    ) -> Result<Self, StratumV1Error> {
        if !valid_stratum_endpoint(&endpoint) {
            return Err(StratumV1Error::InvalidSessionConfig);
        }
        Ok(Self {
            endpoint,
            issuer,
            registry,
        })
    }

    /// Issues and registers credentials for one started lease, before its grant leaves.
    pub async fn issue_lease(
        &self,
        lease: WorkerStratumLease,
    ) -> Result<WorkerStratumV1, StratumV1Error> {
        let credentials = self.issuer.issue_at_milliseconds(
            lease.session_id,
            lease.lease_context,
            lease.now_unix_milliseconds,
            lease.lease_expires_at_unix_seconds,
            lease.challenge_expires_at_unix_seconds,
        )?;
        self.registry.register(&credentials).await?;
        WorkerStratumV1::new(
            self.endpoint.clone(),
            credentials.username().to_owned(),
            credentials.secret().to_owned(),
        )
        .map_err(|_| StratumV1Error::InvalidSessionConfig)
    }

    /// Extends a renewed lease's registered and live credentials, keeping the password.
    pub async fn extend_lease(&self, lease: WorkerStratumLease) -> Result<(), StratumV1Error> {
        let extension = StratumSessionExtension::new(
            lease.session_id,
            lease.lease_context,
            lease.now_unix_milliseconds,
            lease.lease_expires_at_unix_seconds,
            lease.challenge_expires_at_unix_seconds,
        )?;
        self.registry
            .extend(&extension, lease.now_unix_milliseconds / 1_000)
            .await
    }
}

/// The lease facts one Worker's credentials bind, as the Pool Adapter receives them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerStratumLease {
    pub session_id: WorkSessionId,
    pub lease_context: StratumLeaseContext,
    /// Authority wall-clock reading at which the lease context was taken.
    pub now_unix_milliseconds: u64,
    pub lease_expires_at_unix_seconds: u64,
    pub challenge_expires_at_unix_seconds: u64,
}

impl TryFrom<&WorkerStratumRequest> for WorkerStratumLease {
    type Error = StratumV1Error;

    fn try_from(request: &WorkerStratumRequest) -> Result<Self, Self::Error> {
        Ok(Self {
            session_id: request.session_id.clone(),
            lease_context: StratumLeaseContext::new(
                request.lease.lease_id().to_owned(),
                request.clock.continuity_id().to_owned(),
                request.clock.monotonic_milliseconds(),
                request.lease.renew_at_monotonic_milliseconds(),
                request.lease.expires_at_monotonic_milliseconds(),
            )?,
            now_unix_milliseconds: request.now_unix_milliseconds,
            lease_expires_at_unix_seconds: request.lease_expires_at_unix_seconds,
            challenge_expires_at_unix_seconds: request.challenge_expires_at_unix_seconds,
        })
    }
}

#[async_trait]
impl WorkerStratumCredentialPort for PoolAdapterWorkerStratum {
    async fn issue(
        &self,
        request: WorkerStratumRequest,
    ) -> Result<WorkerStratumV1, WorkerStratumUnavailable> {
        let issued = match WorkerStratumLease::try_from(&request) {
            Ok(lease) => self.issue_lease(lease).await,
            Err(error) => Err(error),
        };
        issued.map_err(|error| {
            tracing::warn!(%error, "Worker Stratum credentials were not issued");
            WorkerStratumUnavailable
        })
    }

    async fn renew(&self, request: WorkerStratumRequest) -> Result<(), WorkerStratumUnavailable> {
        let extended = match WorkerStratumLease::try_from(&request) {
            Ok(lease) => self.extend_lease(lease).await,
            Err(error) => Err(error),
        };
        extended.map_err(|error| {
            tracing::warn!(%error, "Worker Stratum session was not extended");
            WorkerStratumUnavailable
        })
    }

    async fn record_pool_selection(
        &self,
        intake: PoolSelectionIntake,
    ) -> Result<(), WorkerStratumUnavailable> {
        self.registry
            .record_pool_selection(
                &intake.session_id,
                &intake.challenge_id,
                &intake.selection,
                intake.challenge_expires_at_unix_seconds,
                intake.now_unix_seconds,
            )
            .await
            .map_err(|error| {
                tracing::warn!(%error, "claimant Pool Selection was not recorded");
                WorkerStratumUnavailable
            })
    }

    async fn release_pool_selection(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<(), WorkerStratumUnavailable> {
        self.registry
            .delete_pool_selection(challenge_id)
            .await
            .map_err(|error| {
                tracing::warn!(%error, "claimant Pool Selection was not deleted");
                WorkerStratumUnavailable
            })
    }
}
