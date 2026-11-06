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

    async fn issue_registered(
        &self,
        request: WorkerStratumRequest,
    ) -> Result<WorkerStratumV1, StratumV1Error> {
        let lease_context = lease_context(&request)?;
        let credentials = self.issuer.issue_at_milliseconds(
            request.session_id,
            lease_context,
            request.now_unix_milliseconds,
            request.lease_expires_at_unix_seconds,
            request.challenge_expires_at_unix_seconds,
        )?;
        self.registry.register(&credentials).await?;
        WorkerStratumV1::new(
            self.endpoint.clone(),
            credentials.username().to_owned(),
            credentials.secret().to_owned(),
        )
        .map_err(|_| StratumV1Error::InvalidSessionConfig)
    }

    async fn extend_registered(&self, request: WorkerStratumRequest) -> Result<(), StratumV1Error> {
        let extension = StratumSessionExtension::new(
            request.session_id.clone(),
            lease_context(&request)?,
            request.now_unix_milliseconds,
            request.lease_expires_at_unix_seconds,
            request.challenge_expires_at_unix_seconds,
        )?;
        self.registry
            .extend(&extension, request.now_unix_milliseconds / 1_000)
            .await
    }
}

fn lease_context(request: &WorkerStratumRequest) -> Result<StratumLeaseContext, StratumV1Error> {
    StratumLeaseContext::new(
        request.lease.lease_id().to_owned(),
        request.clock.continuity_id().to_owned(),
        request.clock.monotonic_milliseconds(),
        request.lease.renew_at_monotonic_milliseconds(),
        request.lease.expires_at_monotonic_milliseconds(),
    )
}

#[async_trait]
impl WorkerStratumCredentialPort for PoolAdapterWorkerStratum {
    async fn issue(
        &self,
        request: WorkerStratumRequest,
    ) -> Result<WorkerStratumV1, WorkerStratumUnavailable> {
        self.issue_registered(request).await.map_err(|error| {
            tracing::warn!(%error, "Worker Stratum credentials were not issued");
            WorkerStratumUnavailable
        })
    }

    async fn renew(&self, request: WorkerStratumRequest) -> Result<(), WorkerStratumUnavailable> {
        self.extend_registered(request).await.map_err(|error| {
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
