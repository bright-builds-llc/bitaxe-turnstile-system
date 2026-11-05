//! In-process Pool Adapter side of the Authority's Worker Stratum credential port.

use async_trait::async_trait;

use super::{
    PostgresStratumSessionRegistry, StratumCredentialIssuer, StratumLeaseContext, StratumV1Error,
};
use crate::{
    authority::{WorkerStratumCredentialPort, WorkerStratumRequest, WorkerStratumUnavailable},
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
        let lease_context = StratumLeaseContext::new(
            request.lease.lease_id().to_owned(),
            request.clock.continuity_id().to_owned(),
            request.clock.monotonic_milliseconds(),
            request.lease.renew_at_monotonic_milliseconds(),
            request.lease.expires_at_monotonic_milliseconds(),
        )?;
        let credentials = self.issuer.issue(
            request.session_id,
            lease_context,
            request.now_unix_seconds,
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
}
