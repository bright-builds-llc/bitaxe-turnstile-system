//! The Stratum session registry, served by the Pool Adapter.

use std::sync::Arc;

use async_trait::async_trait;
use tonic::{Request, Response, Status, codegen::InterceptedService, transport::Channel};

use super::{
    ChannelToken, PoolAdapterGrpcError,
    channel_token::ChannelTokenBearer,
    lazy_loopback_channel,
    proto::{
        IssueWorkerCredentialsRequest, IssueWorkerCredentialsResponse, RecordPoolSelectionRequest,
        RecordPoolSelectionResponse, ReleasePoolSelectionRequest, ReleasePoolSelectionResponse,
        RenewWorkerSessionRequest, RenewWorkerSessionResponse,
        stratum_session_registry_client::StratumSessionRegistryClient,
        stratum_session_registry_server::{StratumSessionRegistry, StratumSessionRegistryServer},
    },
    server,
    wire::{
        challenge_id_from_wire, pool_selection_from_wire, pool_selection_to_wire,
        worker_lease_from_wire, worker_lease_to_wire,
    },
};
use crate::{
    authority::{
        PoolSelectionIntake, WorkerStratumCredentialPort, WorkerStratumRequest,
        WorkerStratumUnavailable,
    },
    challenge::ChallengeId,
    stratum_v1::{PoolAdapterWorkerStratum, StratumV1Error, WorkerStratumLease},
    work_lease_authorization::WorkerStratumV1,
};

/// The Pool Adapter's side, backed by its own credential issuer and database.
#[derive(Clone)]
pub struct StratumSessionRegistryService {
    stratum: Arc<PoolAdapterWorkerStratum>,
}

impl StratumSessionRegistryService {
    pub fn new(stratum: PoolAdapterWorkerStratum) -> Self {
        Self {
            stratum: Arc::new(stratum),
        }
    }
}

/// An outage is retryable; anything else is input the adapter refuses.
fn registry_status(error: StratumV1Error) -> Status {
    tracing::warn!(%error, "Stratum session registry call failed");
    match error {
        StratumV1Error::Database(_) | StratumV1Error::Migration(_) | StratumV1Error::Io(_) => {
            Status::unavailable("the Pool Adapter registry is unavailable")
        }
        _ => Status::invalid_argument("the Pool Adapter refused the lease"),
    }
}

#[async_trait]
impl StratumSessionRegistry for StratumSessionRegistryService {
    async fn issue_worker_credentials(
        &self,
        request: Request<IssueWorkerCredentialsRequest>,
    ) -> Result<Response<IssueWorkerCredentialsResponse>, Status> {
        let lease = worker_lease_from_wire(request.into_inner().lease)?;
        let stratum = self
            .stratum
            .issue_lease(lease)
            .await
            .map_err(registry_status)?;
        Ok(Response::new(IssueWorkerCredentialsResponse {
            endpoint: stratum.endpoint().to_owned(),
            username: stratum.username().to_owned(),
            password: stratum.password().to_owned(),
        }))
    }

    async fn renew_worker_session(
        &self,
        request: Request<RenewWorkerSessionRequest>,
    ) -> Result<Response<RenewWorkerSessionResponse>, Status> {
        let lease = worker_lease_from_wire(request.into_inner().lease)?;
        self.stratum
            .extend_lease(lease)
            .await
            .map_err(registry_status)?;
        Ok(Response::new(RenewWorkerSessionResponse {}))
    }

    async fn record_pool_selection(
        &self,
        request: Request<RecordPoolSelectionRequest>,
    ) -> Result<Response<RecordPoolSelectionResponse>, Status> {
        let intake = pool_selection_from_wire(request.into_inner())?;
        WorkerStratumCredentialPort::record_pool_selection(self.stratum.as_ref(), intake)
            .await
            .map_err(|_| Status::unavailable("the Pool Selection was not recorded"))?;
        Ok(Response::new(RecordPoolSelectionResponse {}))
    }

    async fn release_pool_selection(
        &self,
        request: Request<ReleasePoolSelectionRequest>,
    ) -> Result<Response<ReleasePoolSelectionResponse>, Status> {
        let challenge_id = challenge_id_from_wire(request.into_inner().challenge_id)?;
        WorkerStratumCredentialPort::release_pool_selection(self.stratum.as_ref(), &challenge_id)
            .await
            .map_err(|_| Status::unavailable("the Pool Selection was not deleted"))?;
        Ok(Response::new(ReleasePoolSelectionResponse {}))
    }
}

/// Routes `service`, refusing any call without the channel token.
pub fn stratum_session_registry_router<S: StratumSessionRegistry>(
    service: S,
    token: &ChannelToken,
) -> tonic::transport::server::Router {
    server().add_service(InterceptedService::new(
        StratumSessionRegistryServer::new(service),
        token.verifier(),
    ))
}

type RegistryClient = StratumSessionRegistryClient<InterceptedService<Channel, ChannelTokenBearer>>;

/// The Authority's Worker Stratum port to the Pool Adapter process over gRPC.
#[derive(Clone)]
pub struct GrpcWorkerStratum {
    client: RegistryClient,
}

impl GrpcWorkerStratum {
    /// Connects on first use to the Pool Adapter at `url`, an `http://` loopback URL.
    pub fn connect_lazy(url: &str, token: &ChannelToken) -> Result<Self, PoolAdapterGrpcError> {
        Ok(Self {
            client: StratumSessionRegistryClient::with_interceptor(
                lazy_loopback_channel(url)?,
                token.bearer()?,
            ),
        })
    }
}

fn unavailable(operation: &'static str) -> impl FnOnce(Status) -> WorkerStratumUnavailable {
    move |status| {
        tracing::warn!(code = ?status.code(), operation, "Pool Adapter registry call failed");
        WorkerStratumUnavailable
    }
}

fn wire_lease(
    request: &WorkerStratumRequest,
) -> Result<super::proto::WorkerStratumLease, WorkerStratumUnavailable> {
    WorkerStratumLease::try_from(request)
        .map(|lease| worker_lease_to_wire(&lease))
        .map_err(|_| WorkerStratumUnavailable)
}

#[async_trait]
impl WorkerStratumCredentialPort for GrpcWorkerStratum {
    async fn issue(
        &self,
        request: WorkerStratumRequest,
    ) -> Result<WorkerStratumV1, WorkerStratumUnavailable> {
        let lease = wire_lease(&request)?;
        let issued = self
            .client
            .clone()
            .issue_worker_credentials(IssueWorkerCredentialsRequest { lease: Some(lease) })
            .await
            .map_err(unavailable("issue"))?
            .into_inner();
        WorkerStratumV1::new(issued.endpoint, issued.username, issued.password)
            .map_err(|_| WorkerStratumUnavailable)
    }

    async fn renew(&self, request: WorkerStratumRequest) -> Result<(), WorkerStratumUnavailable> {
        let lease = wire_lease(&request)?;
        self.client
            .clone()
            .renew_worker_session(RenewWorkerSessionRequest { lease: Some(lease) })
            .await
            .map_err(unavailable("renew"))?;
        Ok(())
    }

    async fn record_pool_selection(
        &self,
        intake: PoolSelectionIntake,
    ) -> Result<(), WorkerStratumUnavailable> {
        self.client
            .clone()
            .record_pool_selection(pool_selection_to_wire(&intake))
            .await
            .map_err(unavailable("record_pool_selection"))?;
        Ok(())
    }

    async fn release_pool_selection(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<(), WorkerStratumUnavailable> {
        self.client
            .clone()
            .release_pool_selection(ReleasePoolSelectionRequest {
                challenge_id: challenge_id.as_str().to_owned(),
            })
            .await
            .map_err(unavailable("release_pool_selection"))?;
        Ok(())
    }
}
