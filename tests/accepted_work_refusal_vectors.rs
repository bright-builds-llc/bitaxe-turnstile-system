//! The shared refusal vectors every Pool Adapter wire adapter reproduces (ADR-0108).

use std::error::Error;

use bwg_core::{
    progress::AcceptedWorkRefusal,
    stratum_v1::{MAX_DELIVERY_RETRY_SECONDS, retry_delay_seconds},
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vectors {
    refusals: Vec<RefusalVector>,
    outage: OutageVector,
}

#[derive(Deserialize)]
struct RefusalVector {
    reason: String,
    terminal: bool,
}

#[derive(Deserialize)]
struct OutageVector {
    terminal: bool,
    retry_delays_seconds: Vec<u64>,
    max_retry_delay_seconds: u64,
}

fn vectors() -> Result<Vectors, Box<dyn Error>> {
    Ok(serde_json::from_str(include_str!(
        "../conformance/bwg-0.1/accepted-work-refusal-vectors.json"
    ))?)
}

#[test]
fn every_refusal_reason_has_one_terminal_vector_in_order() -> Result<(), Box<dyn Error>> {
    // Arrange
    let vectors = vectors()?;

    // Act
    let codes: Vec<&str> = AcceptedWorkRefusal::ALL
        .iter()
        .map(|refusal| refusal.code())
        .collect();
    let vector_codes: Vec<&str> = vectors
        .refusals
        .iter()
        .map(|vector| vector.reason.as_str())
        .collect();

    // Assert
    assert_eq!(vector_codes, codes);
    assert!(vectors.refusals.iter().all(|vector| vector.terminal));
    Ok(())
}

#[test]
fn refusal_codes_round_trip_through_serde() -> Result<(), Box<dyn Error>> {
    // Arrange
    let vectors = vectors()?;

    // Act
    let parsed = vectors
        .refusals
        .iter()
        .map(|vector| serde_json::from_value(serde_json::Value::String(vector.reason.clone())))
        .collect::<Result<Vec<AcceptedWorkRefusal>, _>>()?;

    // Assert
    assert_eq!(parsed, AcceptedWorkRefusal::ALL.to_vec());
    for refusal in AcceptedWorkRefusal::ALL {
        assert_eq!(serde_json::to_value(refusal)?, refusal.code());
    }
    Ok(())
}

#[test]
fn outage_retries_follow_the_shared_backoff() -> Result<(), Box<dyn Error>> {
    // Arrange
    let vectors = vectors()?;

    // Act
    let delays: Vec<u64> = (1..=u32::try_from(vectors.outage.retry_delays_seconds.len())?)
        .map(retry_delay_seconds)
        .collect();

    // Assert
    assert!(!vectors.outage.terminal);
    assert_eq!(delays, vectors.outage.retry_delays_seconds);
    assert_eq!(
        vectors.outage.max_retry_delay_seconds,
        MAX_DELIVERY_RETRY_SECONDS
    );
    Ok(())
}

mod grpc {
    //! The gRPC adapter reproduces the vectors over the wire (ADR-0113).

    use std::{error::Error, net::SocketAddr};

    use async_trait::async_trait;
    use bwg_core::{
        pool_adapter_grpc::{
            self, ChannelToken, GrpcAuthorityPort, accepted_work_ingest_router, proto,
            refusal_from_wire,
        },
        progress::{
            AcceptedWorkEvent, AcceptedWorkEventId, AcceptedWorkEventInput, AcceptedWorkRefusal,
            NetworkTargetOutcome, ReceiptTime, ShareFingerprint, WorkSessionId,
        },
        stratum_v1::{AcceptedWorkSink as _, AcceptedWorkSinkError, StratumLeaseContext},
    };
    use tokio::net::TcpListener;
    use tonic::{Request, Response, Status};

    use super::vectors;

    /// An Authority that answers every delivery with one fixed reply.
    #[derive(Clone)]
    struct FixedAuthority {
        reply: Result<proto::DeliverAcceptedWorkResponse, Status>,
    }

    #[async_trait]
    impl proto::accepted_work_ingest_server::AcceptedWorkIngest for FixedAuthority {
        async fn deliver_accepted_work(
            &self,
            _request: Request<proto::DeliverAcceptedWorkRequest>,
        ) -> Result<Response<proto::DeliverAcceptedWorkResponse>, Status> {
            self.reply.clone().map(Response::new)
        }

        async fn report_worker_disconnect(
            &self,
            _request: Request<proto::ReportWorkerDisconnectRequest>,
        ) -> Result<Response<proto::ReportWorkerDisconnectResponse>, Status> {
            Ok(Response::new(proto::ReportWorkerDisconnectResponse {}))
        }
    }

    fn refused(reason: i32) -> FixedAuthority {
        FixedAuthority {
            reply: Ok(proto::DeliverAcceptedWorkResponse {
                outcome: Some(proto::deliver_accepted_work_response::Outcome::Refused(
                    proto::AcceptedWorkRefused { reason },
                )),
            }),
        }
    }

    async fn serve(
        authority: FixedAuthority,
        token: &ChannelToken,
    ) -> Result<SocketAddr, Box<dyn Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let router = accepted_work_ingest_router(authority, token);
        tokio::spawn(pool_adapter_grpc::serve(router, listener));
        Ok(address)
    }

    async fn deliver_to(
        address: SocketAddr,
        token: &ChannelToken,
    ) -> Result<Result<(), AcceptedWorkSinkError>, Box<dyn Error>> {
        let port = GrpcAuthorityPort::connect_lazy(&format!("http://{address}"), token)?;
        Ok(port.deliver(event()?, lease_context()?).await)
    }

    fn event() -> Result<AcceptedWorkEvent, Box<dyn Error>> {
        let mut assigned_target = [0_u8; 32];
        assigned_target[4] = 0xff;
        Ok(AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
            event_id: AcceptedWorkEventId::try_from("event_vector_grpc_01".to_owned())?,
            work_session_id: WorkSessionId::try_from("session_vector_grpc_01".to_owned())?,
            assigned_target,
            received_at: ReceiptTime::try_from(1_000)?,
            share_fingerprint: ShareFingerprint::try_from("share_vector_grpc_01".to_owned())?,
            network_target_outcome: NetworkTargetOutcome::BelowNetworkTarget,
            maybe_worker_report: None,
        })?)
    }

    fn lease_context() -> Result<StratumLeaseContext, Box<dyn Error>> {
        Ok(StratumLeaseContext::new(
            "6f1c2d4e-8a9b-4c3d-9e2f-0a1b2c3d4e5f".to_owned(),
            "boot_vector_grpc_01".to_owned(),
            0,
            30_000,
            60_000,
        )?)
    }

    #[test]
    fn wire_reasons_follow_the_vectors_in_order() -> Result<(), Box<dyn Error>> {
        // Arrange
        let vectors = vectors()?;

        // Act
        let wire: Vec<(String, Option<&str>)> = (1..=i32::try_from(vectors.refusals.len())?)
            .map(|reason| {
                let name = proto::AcceptedWorkRefusalReason::try_from(reason)
                    .map(|known| known.as_str_name().to_owned())
                    .unwrap_or_default();
                (
                    name,
                    refusal_from_wire(reason).map(AcceptedWorkRefusal::code),
                )
            })
            .collect();

        // Assert
        let expected: Vec<(String, Option<&str>)> = vectors
            .refusals
            .iter()
            .map(|vector| {
                (
                    format!(
                        "ACCEPTED_WORK_REFUSAL_REASON_{}",
                        vector.reason.to_uppercase()
                    ),
                    Some(vector.reason.as_str()),
                )
            })
            .collect();
        assert_eq!(wire, expected);
        Ok(())
    }

    #[tokio::test]
    async fn every_wire_refusal_is_terminal_at_the_adapter() -> Result<(), Box<dyn Error>> {
        // Arrange
        let token = ChannelToken::generate()?;
        let vectors = vectors()?;
        let mut outcomes = Vec::new();

        // Act
        for reason in 1..=i32::try_from(vectors.refusals.len())? {
            let address = serve(refused(reason), &token).await?;
            outcomes.push(match deliver_to(address, &token).await? {
                Err(AcceptedWorkSinkError::Refused(refusal)) => refusal.code().to_owned(),
                other => format!("{other:?}"),
            });
        }

        // Assert
        let expected: Vec<String> = vectors
            .refusals
            .iter()
            .map(|vector| vector.reason.clone())
            .collect();
        assert_eq!(outcomes, expected);
        Ok(())
    }

    #[tokio::test]
    async fn an_unknown_wire_reason_is_retried() -> Result<(), Box<dyn Error>> {
        // Arrange
        let token = ChannelToken::generate()?;
        let address = serve(refused(99), &token).await?;

        // Act
        let outcome = deliver_to(address, &token).await?;

        // Assert
        assert!(matches!(outcome, Err(AcceptedWorkSinkError::Unavailable)));
        Ok(())
    }

    #[tokio::test]
    async fn an_authority_outage_is_retried() -> Result<(), Box<dyn Error>> {
        // Arrange
        let token = ChannelToken::generate()?;
        let outage = FixedAuthority {
            reply: Err(Status::unavailable("database down")),
        };
        let address = serve(outage, &token).await?;

        // Act
        let outcome = deliver_to(address, &token).await?;

        // Assert
        assert!(matches!(outcome, Err(AcceptedWorkSinkError::Unavailable)));
        Ok(())
    }

    #[tokio::test]
    async fn an_unreachable_authority_is_retried() -> Result<(), Box<dyn Error>> {
        // Arrange
        let token = ChannelToken::generate()?;
        let address = TcpListener::bind("127.0.0.1:0").await?.local_addr()?;

        // Act
        let outcome = deliver_to(address, &token).await?;

        // Assert
        assert!(matches!(outcome, Err(AcceptedWorkSinkError::Unavailable)));
        Ok(())
    }

    #[tokio::test]
    async fn a_delivery_with_another_token_is_refused_and_retried() -> Result<(), Box<dyn Error>> {
        // Arrange
        let address = serve(refused(1), &ChannelToken::generate()?).await?;

        // Act
        let outcome = deliver_to(address, &ChannelToken::generate()?).await?;

        // Assert
        assert!(matches!(outcome, Err(AcceptedWorkSinkError::Unavailable)));
        Ok(())
    }
}
