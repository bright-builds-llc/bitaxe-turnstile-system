//! Accepted-work delivery and Worker disconnects, served by the Authority.

use async_trait::async_trait;
use tonic::{Request, Response, Status, codegen::InterceptedService, transport::Channel};

use super::{
    ChannelToken, PoolAdapterGrpcError,
    channel_token::ChannelTokenBearer,
    lazy_loopback_channel,
    proto::{
        self, AcceptedWorkCredited, AcceptedWorkRefused, DeliverAcceptedWorkRequest,
        DeliverAcceptedWorkResponse, ReportWorkerDisconnectRequest, ReportWorkerDisconnectResponse,
        accepted_work_ingest_client::AcceptedWorkIngestClient,
        accepted_work_ingest_server::{AcceptedWorkIngest, AcceptedWorkIngestServer},
        deliver_accepted_work_response::Outcome,
    },
    server,
    wire::{
        event_from_wire, event_to_wire, lease_context_from_wire, lease_context_to_wire,
        refusal_from_wire, refusal_to_wire, session_id_from_wire,
    },
};
use crate::{
    authority::SimulatedPoolAdapter,
    progress::{AcceptedWorkEvent, WorkSessionId},
    stratum_v1::{
        AcceptedWorkSink, AcceptedWorkSinkError, StratumLeaseContext, WorkSessionDisconnectSink,
        WorkSessionDisconnectSinkError,
    },
};

/// The Authority's side: each call goes through the in-process port, so the wire
/// gives the credit or typed refusal that port gives.
#[derive(Clone)]
pub struct AcceptedWorkIngestService {
    port: SimulatedPoolAdapter,
}

impl AcceptedWorkIngestService {
    pub fn new(port: SimulatedPoolAdapter) -> Self {
        Self { port }
    }
}

#[async_trait]
impl AcceptedWorkIngest for AcceptedWorkIngestService {
    async fn deliver_accepted_work(
        &self,
        request: Request<DeliverAcceptedWorkRequest>,
    ) -> Result<Response<DeliverAcceptedWorkResponse>, Status> {
        let request = request.into_inner();
        let event = event_from_wire(request.event)?;
        let lease_context = lease_context_from_wire(request.lease_context)?;
        let outcome = match AcceptedWorkSink::deliver(&self.port, event, lease_context).await {
            Ok(()) => Outcome::Credited(AcceptedWorkCredited {}),
            Err(AcceptedWorkSinkError::Refused(refusal)) => Outcome::Refused(AcceptedWorkRefused {
                reason: refusal_to_wire(refusal).into(),
            }),
            Err(AcceptedWorkSinkError::Unavailable) => {
                return Err(Status::unavailable(
                    "the Authority could not take the event",
                ));
            }
        };
        Ok(Response::new(DeliverAcceptedWorkResponse {
            outcome: Some(outcome),
        }))
    }

    async fn report_worker_disconnect(
        &self,
        request: Request<ReportWorkerDisconnectRequest>,
    ) -> Result<Response<ReportWorkerDisconnectResponse>, Status> {
        let session_id = session_id_from_wire(request.into_inner().work_session_id)?;
        self.port
            .disconnected(&session_id)
            .await
            .map_err(|_| Status::unavailable("the Authority could not record the disconnect"))?;
        Ok(Response::new(ReportWorkerDisconnectResponse {}))
    }
}

/// Routes `service`, refusing any call without the channel token.
pub fn accepted_work_ingest_router<S: AcceptedWorkIngest>(
    service: S,
    token: &ChannelToken,
) -> tonic::transport::server::Router {
    server().add_service(InterceptedService::new(
        AcceptedWorkIngestServer::new(service),
        token.verifier(),
    ))
}

type IngestClient = AcceptedWorkIngestClient<InterceptedService<Channel, ChannelTokenBearer>>;

/// The Pool Adapter's port to the Authority over gRPC.
///
/// A typed refusal is terminal; every other failure, including a refusal reason
/// this build does not know, is an outage the delivery loop retries.
#[derive(Clone)]
pub struct GrpcAuthorityPort {
    client: IngestClient,
}

impl GrpcAuthorityPort {
    /// Connects on first use to the Authority at `url`, an `http://` loopback URL.
    pub fn connect_lazy(url: &str, token: &ChannelToken) -> Result<Self, PoolAdapterGrpcError> {
        Ok(Self {
            client: AcceptedWorkIngestClient::with_interceptor(
                lazy_loopback_channel(url)?,
                token.bearer()?,
            ),
        })
    }
}

#[async_trait]
impl AcceptedWorkSink for GrpcAuthorityPort {
    async fn deliver(
        &self,
        event: AcceptedWorkEvent,
        lease_context: StratumLeaseContext,
    ) -> Result<(), AcceptedWorkSinkError> {
        let request = DeliverAcceptedWorkRequest {
            event: Some(event_to_wire(&event)),
            lease_context: Some(lease_context_to_wire(&lease_context)),
        };
        let response = self
            .client
            .clone()
            .deliver_accepted_work(request)
            .await
            .map_err(|status| {
                tracing::warn!(code = ?status.code(), "accepted work delivery will retry");
                AcceptedWorkSinkError::Unavailable
            })?
            .into_inner();
        match response.outcome {
            Some(Outcome::Credited(_)) => Ok(()),
            Some(Outcome::Refused(refused)) => refused_outcome(refused.reason),
            None => {
                tracing::warn!("the Authority answered delivery without an outcome");
                Err(AcceptedWorkSinkError::Unavailable)
            }
        }
    }
}

fn refused_outcome(reason: i32) -> Result<(), AcceptedWorkSinkError> {
    let Some(refusal) = refusal_from_wire(reason) else {
        tracing::warn!(
            reason,
            "the Authority refused with an unknown reason; retrying"
        );
        return Err(AcceptedWorkSinkError::Unavailable);
    };
    Err(AcceptedWorkSinkError::Refused(refusal))
}

#[async_trait]
impl WorkSessionDisconnectSink for GrpcAuthorityPort {
    async fn disconnected(
        &self,
        session_id: &WorkSessionId,
    ) -> Result<(), WorkSessionDisconnectSinkError> {
        let request = proto::ReportWorkerDisconnectRequest {
            work_session_id: session_id.as_str().to_owned(),
        };
        self.client
            .clone()
            .report_worker_disconnect(request)
            .await
            .map_err(|status| {
                tracing::warn!(code = ?status.code(), "Worker disconnect was not reported");
                WorkSessionDisconnectSinkError::Unavailable
            })?;
        Ok(())
    }
}
