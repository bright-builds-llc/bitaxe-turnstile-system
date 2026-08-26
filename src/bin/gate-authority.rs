use std::{env, error::Error, sync::Arc};

use bwg_core::trusted_consent::{AttestedWebauthnVerifier, TrustedAttestationAnchorInput};
use bwg_core::{
    authority::{
        self, AuthorityPublicConfig, DeploymentEnvironment, IssuanceProcessingOutcome,
        IssuanceWorkerId, ServiceCredential,
    },
    challenge::ActionPolicy,
    crypto_profile::AuthorityJwkWire,
};
use serde::Deserialize;
use tokio::net::TcpListener;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TrustedAttestationAnchorWire {
    ca_pem: String,
    aaguid: Uuid,
    description: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    tracing_subscriber::fmt().try_init()?;
    let environment = env::var("BWG_ENVIRONMENT")?.parse::<DeploymentEnvironment>()?;
    let service_client_id = env::var("BWG_SERVICE_CLIENT_ID")?;
    let service_secret = env::var("BWG_SERVICE_CREDENTIAL")?;
    let relying_service_audience = env::var("BWG_RELYING_SERVICE_AUDIENCE")?;
    let allowed_origins = env::var("BWG_ALLOWED_ORIGINS")?
        .split(',')
        .map(str::to_owned)
        .collect();
    let allowed_policies = env::var("BWG_ALLOWED_ACTION_POLICIES")?
        .split(',')
        .map(ActionPolicy::parse)
        .collect::<Result<Vec<_>, _>>()?;
    let trusted_consent_enabled =
        allowed_policies.contains(&ActionPolicy::AccountCreationElevatedV1);
    let credential = ServiceCredential::new(
        service_client_id,
        &service_secret,
        environment,
        relying_service_audience,
        allowed_origins,
        allowed_policies,
    )?;
    let authority_keys =
        serde_json::from_str::<Vec<AuthorityJwkWire>>(&env::var("BWG_AUTHORITY_JWKS_JSON")?)?;
    let public_config = AuthorityPublicConfig::new(
        env::var("BWG_AUTHORITY_ISSUER")?,
        env::var("BWG_AUTHORITY_PUBLIC_BASE_URL")?,
        authority_keys,
        env::var("BWG_OPERATOR_POLICY_URL")?,
        env::var("BWG_PRIVACY_URL")?,
        env::var("BWG_TERMS_URL")?,
    )?;
    let signing_kid = env::var("BWG_AUTHORITY_SIGNING_KID")?;
    let signing_seed = env::var("BWG_AUTHORITY_SIGNING_SEED")?;
    let config = authority::Config::new(environment, vec![credential], public_config)?
        .with_signing_key_seed(signing_kid, &signing_seed)?;
    let database_url = env::var("BWG_AUTHORITY_DATABASE_URL")?;
    let application = if trusted_consent_enabled {
        let anchors = serde_json::from_str::<Vec<TrustedAttestationAnchorWire>>(&env::var(
            "BWG_WEBAUTHN_TRUSTED_ATTESTATION_JSON",
        )?)?
        .into_iter()
        .map(|anchor| TrustedAttestationAnchorInput {
            ca_pem: anchor.ca_pem,
            aaguid: anchor.aaguid,
            description: anchor.description,
        })
        .collect();
        let verifier = AttestedWebauthnVerifier::new(
            &env::var("BWG_WEBAUTHN_RP_ID")?,
            &env::var("BWG_WEBAUTHN_RP_ORIGIN")?,
            anchors,
        )?;
        authority::AuthorityApplication::connect_postgres_with_trusted_consent_verifier(
            config,
            &database_url,
            Arc::new(verifier),
        )
        .await?
    } else {
        authority::AuthorityApplication::connect_postgres(config, &database_url).await?
    };
    let issuance_application = application.clone();
    let issuance_worker_id =
        IssuanceWorkerId::try_from(format!("worker_{}", Uuid::new_v4().simple()))?;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(250));
        loop {
            interval.tick().await;
            let now = match std::time::SystemTime::UNIX_EPOCH.elapsed() {
                Ok(duration) => duration.as_secs(),
                Err(error) => {
                    tracing::error!(%error, "system clock is unavailable to issuance worker");
                    continue;
                }
            };
            match issuance_application
                .process_next_issuance(&issuance_worker_id, now)
                .await
            {
                Ok(IssuanceProcessingOutcome::Issued { challenge_id }) => {
                    tracing::info!(challenge_id = %challenge_id.as_str(), "Gate Pass issued");
                }
                Ok(IssuanceProcessingOutcome::NoWork) => {}
                Err(error) => {
                    tracing::warn!(%error, "Gate Pass issuance iteration failed");
                }
            }
        }
    });
    let listen_address =
        env::var("BWG_LISTEN_ADDRESS").unwrap_or_else(|_| "127.0.0.1:3000".to_owned());
    let listener = TcpListener::bind(&listen_address).await?;
    tracing::info!(%listen_address, "Gate Authority listening");

    axum::serve(listener, authority::router(application)).await?;

    Ok(())
}
