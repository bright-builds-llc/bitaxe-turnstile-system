use std::{env, error::Error, future::IntoFuture as _, sync::Arc};

use bwg_core::trusted_consent::{AttestedWebauthnVerifier, TrustedAttestationAnchorInput};
use bwg_core::{
    authority::{
        self, AuthorityApplication, AuthorityPublicConfig, DeploymentEnvironment,
        IssuanceProcessingOutcome, IssuanceWorkerId, ServiceCredential, WorkerLeaseIssuance,
    },
    challenge::ActionPolicy,
    crypto_profile::AuthorityJwkWire,
    pool_adapter_grpc::{
        self, AcceptedWorkIngestService, ChannelToken, GrpcWorkerStratum,
        accepted_work_ingest_router, loopback_listen_address,
    },
    work_lease_authorization::WorkLeaseAuthoritySigner,
};
use serde::Deserialize;
use tokio::{net::TcpListener, task::JoinHandle};
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
    refuse_in_process_pool_adapter()?;
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
    let application = with_configured_worker_leases(application).await?;
    let maybe_ingest = with_configured_accepted_work_ingest(&application).await?;
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

    let serve = axum::serve(listener, authority::router(application)).into_future();
    let Some(ingest) = maybe_ingest else {
        serve.await?;
        return Ok(());
    };
    tokio::select! {
        served = serve => served?,
        ingested = ingest => {
            ingested??;
            return Err("accepted-work ingest stopped".into());
        }
    }
    Ok(())
}

/// The proxy, delivery and sweep run in the `pool-adapter` binary (ADR-0113), so an
/// ADR-0109 configuration stops here instead of starting without them.
fn refuse_in_process_pool_adapter() -> Result<(), Box<dyn Error + Send + Sync>> {
    for retired in [
        "BWG_STRATUM_PROXY_LISTEN_ADDRESS",
        "BWG_POOL_ADAPTER_DATABASE_URL",
        "BWG_STRATUM_CREDENTIAL_KEY",
        "BWG_WORKER_STRATUM_ENDPOINT",
    ] {
        if env::var_os(retired).is_some() {
            return Err(
                format!("{retired} belongs to the pool-adapter binary now (ADR-0113)").into(),
            );
        }
    }
    Ok(())
}

/// Enables claimant Worker Leases when the Work Lease Authority secret is deployed.
///
/// The seed is its own secret, never the Gate Pass or Update Authority key.
async fn with_configured_worker_leases(
    application: AuthorityApplication,
) -> Result<AuthorityApplication, Box<dyn Error + Send + Sync>> {
    let seed = match env::var("BWG_WORK_LEASE_AUTHORITY_SEED") {
        Ok(seed) => seed,
        Err(env::VarError::NotPresent) => {
            tracing::info!("Work Lease Authority is not configured; claimant leases are off");
            return Ok(application);
        }
        Err(error) => return Err(error.into()),
    };
    let signer = WorkLeaseAuthoritySigner::from_seed_base64url(
        env::var("BWG_WORK_LEASE_AUTHORITY_KID")?,
        env::var("BWG_WORK_LEASE_AUTHORITY_ISSUER")?,
        &seed,
    )?;
    let stratum = GrpcWorkerStratum::connect_lazy(
        &env::var("BWG_POOL_ADAPTER_GRPC_URL")?,
        &channel_token()?,
    )?;
    Ok(application
        .with_worker_lease_issuance(WorkerLeaseIssuance::new(signer, Arc::new(stratum)))?)
}

/// Serves accepted-work delivery and Worker disconnects to the Pool Adapter process
/// when its loopback listener is deployed.
async fn with_configured_accepted_work_ingest(
    application: &AuthorityApplication,
) -> Result<
    Option<JoinHandle<Result<(), pool_adapter_grpc::PoolAdapterGrpcError>>>,
    Box<dyn Error + Send + Sync>,
> {
    let listen_address = match env::var("BWG_ACCEPTED_WORK_GRPC_LISTEN_ADDRESS") {
        Ok(address) => loopback_listen_address(&address)?,
        Err(env::VarError::NotPresent) => {
            tracing::info!("accepted-work ingest is not configured; no Pool Adapter delivers here");
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    let router = accepted_work_ingest_router(
        AcceptedWorkIngestService::new(application.simulated_pool_adapter()),
        &channel_token()?,
    );
    let listener = TcpListener::bind(listen_address).await?;
    tracing::info!(%listen_address, "accepted-work ingest listening");
    Ok(Some(tokio::spawn(pool_adapter_grpc::serve(
        router, listener,
    ))))
}

/// The secret both processes present on every boundary call.
fn channel_token() -> Result<ChannelToken, Box<dyn Error + Send + Sync>> {
    Ok(ChannelToken::try_from(env::var(
        "BWG_POOL_ADAPTER_CHANNEL_TOKEN",
    )?)?)
}
