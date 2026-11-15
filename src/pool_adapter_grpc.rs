//! The Gate Authority to Pool Adapter gRPC boundary (ADR-0022, ADR-0055, ADR-0113).
//!
//! The Authority serves accepted-work delivery and Worker disconnects, which it
//! hands to its in-process port, so a delivery over the wire gets the same
//! credit or typed refusal it would get in process. The Pool Adapter serves its
//! session registry. Both sides authenticate every call with the deployment's
//! channel token and, until the channel has TLS, accept only loopback addresses.

mod channel_token;
mod ingest;
mod registry;
mod wire;

use std::{net::SocketAddr, time::Duration};

use thiserror::Error;
use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::transport::{Channel, Endpoint, Server, server::Router};
use url::Url;

pub use channel_token::ChannelToken;
pub use ingest::{AcceptedWorkIngestService, GrpcAuthorityPort, accepted_work_ingest_router};
pub use registry::{
    GrpcWorkerStratum, StratumSessionRegistryService, stratum_session_registry_router,
};
pub use wire::{refusal_from_wire, refusal_to_wire};

/// The generated Protobuf messages and services of `bwg.pool_adapter.v1`.
#[allow(clippy::all, clippy::pedantic, missing_docs)]
pub mod proto {
    tonic::include_proto!("bwg.pool_adapter.v1");
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Bounds one call, so a hung peer becomes an outage the caller retries.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// A gRPC boundary that cannot be configured or served.
#[derive(Debug, Error)]
pub enum PoolAdapterGrpcError {
    #[error("the gRPC address must be a loopback address until the channel has TLS")]
    NotLoopback,
    #[error("the gRPC URL must be http://LOOPBACK_IP:PORT")]
    InvalidUrl,
    #[error("the channel token must be a diverse 43-128 character base64url token")]
    InvalidChannelToken,
    #[error("the gRPC transport failed")]
    Transport(#[from] tonic::transport::Error),
    #[error("the gRPC listener failed")]
    Io(#[from] std::io::Error),
}

/// Parses a listen address, refusing anything but loopback.
pub fn loopback_listen_address(value: &str) -> Result<SocketAddr, PoolAdapterGrpcError> {
    let address = value
        .parse::<SocketAddr>()
        .map_err(|_| PoolAdapterGrpcError::NotLoopback)?;
    if !address.ip().is_loopback() {
        return Err(PoolAdapterGrpcError::NotLoopback);
    }
    Ok(address)
}

/// Serves one boundary router on `listener` until the transport fails.
pub async fn serve(router: Router, listener: TcpListener) -> Result<(), PoolAdapterGrpcError> {
    let address = listener.local_addr()?;
    if !address.ip().is_loopback() {
        return Err(PoolAdapterGrpcError::NotLoopback);
    }
    router
        .serve_with_incoming(TcpListenerStream::new(listener))
        .await?;
    Ok(())
}

fn server() -> Server {
    Server::builder().timeout(REQUEST_TIMEOUT)
}

/// A channel that connects on first use, so either process may start first.
fn lazy_loopback_channel(url: &str) -> Result<Channel, PoolAdapterGrpcError> {
    let parsed = Url::parse(url).map_err(|_| PoolAdapterGrpcError::InvalidUrl)?;
    let maybe_host = match parsed.host() {
        Some(url::Host::Ipv4(ip)) => Some(std::net::IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => Some(std::net::IpAddr::V6(ip)),
        _ => None,
    };
    let Some(host) = maybe_host else {
        return Err(PoolAdapterGrpcError::InvalidUrl);
    };
    if parsed.scheme() != "http"
        || parsed.port().is_none()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || !parsed.username().is_empty()
    {
        return Err(PoolAdapterGrpcError::InvalidUrl);
    }
    if !host.is_loopback() {
        return Err(PoolAdapterGrpcError::NotLoopback);
    }
    Ok(Endpoint::from_shared(url.to_owned())?
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .connect_lazy())
}

#[cfg(test)]
mod tests {
    use super::{PoolAdapterGrpcError, lazy_loopback_channel, loopback_listen_address};

    #[test]
    fn listen_address_accepts_loopback() {
        // Act
        let address = loopback_listen_address("127.0.0.1:50051");

        // Assert
        assert!(address.is_ok());
    }

    #[test]
    fn listen_address_refuses_a_lan_address() {
        // Act
        let refused = loopback_listen_address("192.0.2.10:50051");

        // Assert
        assert!(matches!(refused, Err(PoolAdapterGrpcError::NotLoopback)));
    }

    #[tokio::test]
    async fn client_url_accepts_loopback_http() {
        // Act
        let channel = lazy_loopback_channel("http://127.0.0.1:50051");

        // Assert
        assert!(channel.is_ok());
    }

    #[tokio::test]
    async fn client_url_refuses_a_lan_host() {
        // Act
        let refused = lazy_loopback_channel("http://192.0.2.10:50051");

        // Assert
        assert!(matches!(refused, Err(PoolAdapterGrpcError::NotLoopback)));
    }

    #[tokio::test]
    async fn client_url_refuses_a_host_name() {
        // Act
        let refused = lazy_loopback_channel("http://localhost:50051");

        // Assert
        assert!(matches!(refused, Err(PoolAdapterGrpcError::InvalidUrl)));
    }
}
