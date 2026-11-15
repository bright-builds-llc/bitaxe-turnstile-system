//! The shared secret both processes present on every boundary call.

use ring::hmac;
use tonic::{
    Request, Status,
    metadata::{AsciiMetadataValue, MetadataValue},
    service::Interceptor,
};

use super::PoolAdapterGrpcError;
use crate::service_auth::ServiceSecret;

const CHANNEL_TOKEN_VERIFIER_DOMAIN: &[u8] = b"BWG/0.1 Pool Adapter channel token verifier";
const AUTHORIZATION: &str = "authorization";
const BEARER_PREFIX: &str = "Bearer ";

/// The deployment's channel token: a high-entropy base64url secret.
#[derive(Clone)]
pub struct ChannelToken(ServiceSecret);

impl TryFrom<String> for ChannelToken {
    type Error = PoolAdapterGrpcError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        ServiceSecret::try_from(value)
            .map(Self)
            .map_err(|_| PoolAdapterGrpcError::InvalidChannelToken)
    }
}

impl ChannelToken {
    /// Generates a fresh 256-bit token.
    pub fn generate() -> Result<Self, PoolAdapterGrpcError> {
        ServiceSecret::generate()
            .map(Self)
            .map_err(|_| PoolAdapterGrpcError::InvalidChannelToken)
    }

    pub(super) fn bearer(&self) -> Result<ChannelTokenBearer, PoolAdapterGrpcError> {
        MetadataValue::try_from(format!("{BEARER_PREFIX}{}", self.0.expose_secret()))
            .map(ChannelTokenBearer)
            .map_err(|_| PoolAdapterGrpcError::InvalidChannelToken)
    }

    pub(super) fn verifier(&self) -> ChannelTokenVerifier {
        let tag = hmac::sign(&verifier_key(), self.0.expose_secret().as_bytes());
        ChannelTokenVerifier(tag.as_ref().to_vec())
    }
}

fn verifier_key() -> hmac::Key {
    hmac::Key::new(hmac::HMAC_SHA256, CHANNEL_TOKEN_VERIFIER_DOMAIN)
}

/// Client interceptor that presents the token.
#[derive(Clone)]
pub(super) struct ChannelTokenBearer(AsciiMetadataValue);

impl Interceptor for ChannelTokenBearer {
    fn call(&mut self, mut request: Request<()>) -> Result<Request<()>, Status> {
        request.metadata_mut().insert(AUTHORIZATION, self.0.clone());
        Ok(request)
    }
}

/// Server interceptor that refuses any call without the token, in constant time.
#[derive(Clone)]
pub(super) struct ChannelTokenVerifier(Vec<u8>);

impl Interceptor for ChannelTokenVerifier {
    fn call(&mut self, request: Request<()>) -> Result<Request<()>, Status> {
        let maybe_presented = request
            .metadata()
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix(BEARER_PREFIX));
        let Some(presented) = maybe_presented else {
            return Err(Status::unauthenticated("channel token required"));
        };
        hmac::verify(&verifier_key(), presented.as_bytes(), &self.0)
            .map_err(|_| Status::unauthenticated("channel token refused"))?;
        Ok(request)
    }
}

#[cfg(test)]
mod tests {
    use tonic::{Code, Request, service::Interceptor as _};

    use super::ChannelToken;

    #[test]
    fn verifier_accepts_its_own_token() -> Result<(), Box<dyn std::error::Error>> {
        // Arrange
        let token = ChannelToken::generate()?;
        let request = token.bearer()?.call(Request::new(()))?;

        // Act
        let verified = token.verifier().call(request);

        // Assert
        assert!(verified.is_ok());
        Ok(())
    }

    #[test]
    fn verifier_refuses_another_token() -> Result<(), Box<dyn std::error::Error>> {
        // Arrange
        let request = ChannelToken::generate()?.bearer()?.call(Request::new(()))?;

        // Act
        let refused = ChannelToken::generate()?.verifier().call(request);

        // Assert
        assert_eq!(
            refused.map(|_| ()).map_err(|status| status.code()),
            Err(Code::Unauthenticated)
        );
        Ok(())
    }

    #[test]
    fn verifier_refuses_a_call_without_a_token() -> Result<(), Box<dyn std::error::Error>> {
        // Act
        let refused = ChannelToken::generate()?.verifier().call(Request::new(()));

        // Assert
        assert_eq!(
            refused.map(|_| ()).map_err(|status| status.code()),
            Err(Code::Unauthenticated)
        );
        Ok(())
    }

    #[test]
    fn token_refuses_a_low_entropy_value() {
        // Act
        let refused = ChannelToken::try_from("a".repeat(43));

        // Assert
        assert!(refused.is_err());
    }
}
