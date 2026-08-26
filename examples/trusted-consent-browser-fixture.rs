//! Browser-conformance fixture only.
//!
//! This deliberately substitutes the hardware attestation-chain leg after verifying browser
//! challenge, origin, UP, and UV. Production must use `AttestedWebauthnVerifier`.

use std::{error::Error, sync::Arc};

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bwg_core::{
    authority::{self, AuthorityApplication, CLIENT_ID_HEADER},
    challenge::ChallengeId,
    lifecycle::WorkerClock,
    progress::WorkSessionId,
    trusted_consent::{
        TrustedConsentError, TrustedConsentWebauthnVerifier, VerifiedWebauthn,
        WebauthnCeremonyStart,
    },
};
use ring::{
    digest,
    rand::{SecureRandom as _, SystemRandom},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::RwLock};
use uuid::Uuid;

#[path = "../tests/support/authority_keys.rs"]
mod authority_key_support;
#[path = "../tests/support/postgres.rs"]
mod postgres_support;
#[path = "../tests/support/trusted_consent_authority.rs"]
mod trusted_consent_authority_support;
use authority_key_support::{CLAIMANT_PUBLIC_JWK, authority_keys};
use postgres_support::PostgresTestDatabase;
use trusted_consent_authority_support::{CLIENT_ID, SERVICE_SECRET, authority_config_with_issuer};

const AUTHORITY_ORIGIN: &str = "https://authority.example";
const AUTHORITY_ISSUER: &str = "https://authority.example/issuer";
const SESSION_ID: &str = "session_browser_trusted_01";

#[derive(Clone)]
struct FixtureState {
    adapter: bwg_core::authority::SimulatedPoolAdapter,
    descriptor: Arc<RwLock<Option<Value>>>,
}

#[derive(Deserialize)]
struct StartRequest {
    maybe_trusted_consent_receipt: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let database = PostgresTestDatabase::start().await?;
    let application = AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
        authority_config_with_issuer(AUTHORITY_ISSUER)?,
        database.database_url(),
        Arc::new(ConformanceBrowserVerifier),
    )
    .await?;
    let fixture = FixtureState {
        adapter: application.simulated_pool_adapter(),
        descriptor: Arc::new(RwLock::new(None)),
    };
    let fixture_router = Router::new()
        .route("/fixture/config", get(fixture_config))
        .route("/fixture/start-lease", post(start_lease))
        .with_state(fixture.clone());
    let router = authority::router(application).merge(fixture_router);
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let local_origin = format!("http://{address}");
    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("browser fixture server should remain available");
    });

    let descriptor = reqwest::Client::new()
        .post(format!("{local_origin}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&json!({
            "action_policy": "account-creation.elevated.v1",
            "action_reference": "action_browser_trusted_01",
            "claimant_key": CLAIMANT_PUBLIC_JWK
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let challenge_id = ChallengeId::try_from(
        descriptor["challenge_id"]
            .as_str()
            .ok_or("fixture challenge ID")?
            .to_owned(),
    )?;
    fixture
        .adapter
        .consent_default_pool_offer_for_simulation(&challenge_id)
        .await?;
    fixture
        .adapter
        .register_session(
            &challenge_id,
            WorkSessionId::try_from(SESSION_ID.to_owned())?,
        )
        .await?;
    *fixture.descriptor.write().await = Some(descriptor);
    println!("{local_origin}");
    std::future::pending::<()>().await;
    drop(database);
    Ok(())
}

async fn fixture_config(State(state): State<FixtureState>) -> Result<Json<Value>, StatusCode> {
    let descriptor = state
        .descriptor
        .read()
        .await
        .clone()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(Json(json!({
        "descriptor": descriptor,
        "authorityTrust": {
            "issuer": AUTHORITY_ISSUER,
            "trustedKeys": authority_keys().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        }
    })))
}

async fn start_lease(
    State(state): State<FixtureState>,
    Json(request): Json<StartRequest>,
) -> Response {
    let session_id = match WorkSessionId::try_from(SESSION_ID.to_owned()) {
        Ok(session_id) => session_id,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let clock = match WorkerClock::new("boot_browser_trusted_01", 1_000) {
        Ok(clock) => clock,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let result = if let Some(receipt) = request.maybe_trusted_consent_receipt {
        state
            .adapter
            .start_lease_with_trusted_consent(&session_id, clock, &receipt)
            .await
    } else {
        state.adapter.start_lease(&session_id, clock).await
    };
    match result {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => (StatusCode::FORBIDDEN, error.to_string()).into_response(),
    }
}

struct ConformanceBrowserVerifier;

impl TrustedConsentWebauthnVerifier for ConformanceBrowserVerifier {
    fn maybe_rp_origin(&self) -> Option<&str> {
        Some(AUTHORITY_ORIGIN)
    }

    fn begin(
        &self,
        user_id: Uuid,
        challenge_id: &str,
    ) -> Result<WebauthnCeremonyStart, TrustedConsentError> {
        let mut challenge = [0_u8; 32];
        SystemRandom::new()
            .fill(&mut challenge)
            .map_err(|_| TrustedConsentError::WebauthnUnavailable)?;
        let challenge = URL_SAFE_NO_PAD.encode(challenge);
        Ok(WebauthnCeremonyStart {
            creation_options: json!({
                "publicKey": {
                    "rp": { "id": "authority.example", "name": "BWG browser conformance" },
                    "user": {
                        "id": URL_SAFE_NO_PAD.encode(user_id.as_bytes()),
                        "name": challenge_id,
                        "displayName": "BWG Claimant"
                    },
                    "challenge": challenge,
                    "pubKeyCredParams": [
                        { "type": "public-key", "alg": -7 },
                        { "type": "public-key", "alg": -257 }
                    ],
                    "timeout": 120000,
                    "attestation": "direct",
                    "authenticatorSelection": {
                        "residentKey": "discouraged",
                        "userVerification": "required"
                    }
                }
            }),
            registration_state: json!({ "challenge": challenge }),
        })
    }

    fn finish(
        &self,
        response: Value,
        registration_state: Value,
    ) -> Result<VerifiedWebauthn, TrustedConsentError> {
        let expected_challenge = registration_state["challenge"]
            .as_str()
            .ok_or(TrustedConsentError::InvalidWebauthnState)?;
        let client_data = decode_json_field(&response, "clientDataJSON")?;
        if client_data["type"] != "webauthn.create"
            || client_data["challenge"] != expected_challenge
            || client_data["origin"] != AUTHORITY_ORIGIN
        {
            return Err(TrustedConsentError::WebauthnRejected);
        }
        let attestation = decode_response_field(&response, "attestationObject")?;
        let rp_id_hash = digest::digest(&digest::SHA256, b"authority.example");
        let start = attestation
            .windows(rp_id_hash.as_ref().len())
            .position(|window| window == rp_id_hash.as_ref())
            .ok_or(TrustedConsentError::WebauthnRejected)?;
        let flags = *attestation
            .get(start + rp_id_hash.as_ref().len())
            .ok_or(TrustedConsentError::WebauthnRejected)?;
        if flags & 0x01 == 0 || flags & 0x04 == 0 {
            return Err(TrustedConsentError::WebauthnRejected);
        }
        Ok(VerifiedWebauthn {
            user_present: true,
            user_verified: true,
            attestation: "trusted_non_self",
        })
    }
}

fn decode_json_field(response: &Value, field: &str) -> Result<Value, TrustedConsentError> {
    let bytes = decode_response_field(response, field)?;
    serde_json::from_slice(&bytes).map_err(|_| TrustedConsentError::InvalidWebauthnResponse)
}

fn decode_response_field(response: &Value, field: &str) -> Result<Vec<u8>, TrustedConsentError> {
    let encoded = response["response"][field]
        .as_str()
        .ok_or(TrustedConsentError::InvalidWebauthnResponse)?;
    URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| TrustedConsentError::InvalidWebauthnResponse)
}
