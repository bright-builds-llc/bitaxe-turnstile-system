use super::*;

const CLIENT_ID: &str = "hydra-integration-service";
const SERVICE_SECRET: &str = "hydra-integration-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA";
const AUTHORITY_SIGNING_SEED: &str = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";

pub(super) struct IntegrationFixture {
    pub(super) database: PostgresTestDatabase,
    pub(super) authority_application: AuthorityApplication,
    pub(super) authority_task: tokio::task::JoinHandle<()>,
    pub(super) authority_address: SocketAddr,
    pub(super) reference_task: tokio::task::JoinHandle<()>,
    pub(super) reference_address: SocketAddr,
    pub(super) challenge_id: ChallengeId,
    pub(super) claimant: Claimant,
    pub(super) hydra_address: SocketAddr,
    pub(super) payout_script: bitcoin::ScriptBuf,
    pub(super) adapter: SimulatedPoolAdapter,
    pub(super) outbox: PostgresAcceptedWorkOutbox,
    pub(super) sessions: PostgresStratumSessionRegistry,
    pub(super) credentials: bwg_core::stratum_v1::StratumSessionCredentials,
    pub(super) upstream_authorization: StratumUpstreamAuthorization,
    pub(super) now: u64,
}

pub(super) async fn arrange_integration() -> Result<IntegrationFixture, Box<dyn Error>> {
    let hydra_address = std::env::var("BWG_HYDRA_STRATUM_ADDR")?.parse::<SocketAddr>()?;
    let payout_address = std::env::var("BWG_HYDRA_PAYOUT_ADDRESS")?;
    let payout_script = payout_address
        .parse::<Address<_>>()?
        .require_network(Network::Bitcoin)?
        .script_pubkey();
    let database = PostgresTestDatabase::start().await?;
    let authority_application =
        AuthorityApplication::connect_postgres(authority_config()?, database.database_url())
            .await?;
    let adapter = authority_application.simulated_pool_adapter();
    let (authority_url, authority_address, authority_task) =
        spawn_http(authority::router(authority_application.clone())).await?;
    let (reference_url, reference_address, reference_task) =
        spawn_reference_http(authority_url.clone(), database.database_url()).await?;
    let claimant = Claimant::generate()?;
    let reference_probe = reqwest::Client::new()
        .post(format!("{reference_url}/account-creation/challenge"))
        .json(&serde_json::json!({
            "claimant_key": claimant.public_jwk_json.clone()
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    assert_eq!(
        reference_probe["action_policy"],
        ActionPolicy::ACCOUNT_CREATION_STANDARD_V1
    );
    let challenge = reqwest::Client::new()
        .post(format!("{authority_url}/v0/challenges"))
        .header(CLIENT_ID_HEADER, CLIENT_ID)
        .bearer_auth(SERVICE_SECRET)
        .json(&serde_json::json!({
            "action_policy": ActionPolicy::ACCOUNT_CREATION_LIGHT_V1,
            "action_reference": "action_hydra_solo_integration_01",
            "claimant_key": claimant.public_jwk_json.clone()
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let challenge_id = ChallengeId::try_from(
        challenge["challenge_id"]
            .as_str()
            .ok_or("challenge response needs an identifier")?
            .to_owned(),
    )?;
    let outbox = PostgresAcceptedWorkOutbox::connect(database.database_url()).await?;
    let sessions = PostgresStratumSessionRegistry::connect(database.database_url()).await?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let session_id = WorkSessionId::try_from("session_hydra_solo_integration_01".to_owned())?;
    let selection =
        PoolSelection::bitcoin_address("pool_offer_hydra_solo_v1".to_owned(), payout_address)?;
    let selection_commitment = adapter
        .consent_pool_selection_for_simulation(&challenge_id, &selection)
        .await?;
    adapter
        .register_session(&challenge_id, session_id.clone())
        .await?;
    let lease = adapter
        .start_lease(
            &session_id,
            WorkerClock::new("boot_hydra_solo_integration", 0)?,
        )
        .await?;
    let lease_context = StratumLeaseContext::new(
        lease.lease_id().to_owned(),
        "boot_hydra_solo_integration".to_owned(),
        0,
        lease.renew_at_monotonic_milliseconds(),
        lease.expires_at_monotonic_milliseconds(),
    )?;
    let credentials = StratumCredentialIssuer::new([31_u8; 32]).issue(
        session_id.clone(),
        lease_context,
        now,
        now + 60,
        now + 300,
    )?;
    sessions.register(&credentials).await?;
    let upstream_authorization = adapter
        .upstream_authorization_for_simulation(&session_id, &selection, "x".to_owned())
        .await?;
    assert_eq!(
        upstream_authorization.payout_commitment(),
        selection_commitment.commitment()
    );
    Ok(IntegrationFixture {
        database,
        authority_application,
        authority_task,
        authority_address,
        reference_task,
        reference_address,
        challenge_id,
        claimant,
        hydra_address,
        payout_script,
        adapter,
        outbox,
        sessions,
        credentials,
        upstream_authorization,
        now,
    })
}

pub(super) struct AuthoritySink {
    pub(super) adapter: SimulatedPoolAdapter,
    pub(super) state: Mutex<AuthoritySinkState>,
}

pub(super) struct AuthoritySinkState {
    pub(super) progress: Vec<String>,
    pub(super) maybe_latest_lease_context: Option<StratumLeaseContext>,
}

pub(super) fn issuance_qualifying_event(
    session_id: WorkSessionId,
) -> Result<AcceptedWorkEvent, Box<dyn Error>> {
    let mut assigned_target = [0xff_u8; 32];
    assigned_target[..5].fill(0);
    assigned_target[5] = 0x3f;
    Ok(AcceptedWorkEvent::try_from(AcceptedWorkEventInput {
        event_id: AcceptedWorkEventId::try_from("event_hydra_issuance_precondition_01".to_owned())?,
        work_session_id: session_id,
        assigned_target,
        received_at: ReceiptTime::try_from(
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        )?,
        share_fingerprint: ShareFingerprint::try_from(
            "share_hydra_issuance_precondition_01".to_owned(),
        )?,
        network_target_outcome: NetworkTargetOutcome::BelowNetworkTarget,
        maybe_worker_report: None,
    })?)
}

#[async_trait]
impl AcceptedWorkSink for AuthoritySink {
    async fn deliver(
        &self,
        event: bwg_core::progress::AcceptedWorkEvent,
        lease_context: StratumLeaseContext,
    ) -> Result<(), AcceptedWorkSinkError> {
        let acknowledgement = self
            .adapter
            .report_stratum(event, &lease_context)
            .await
            .map_err(|_| AcceptedWorkSinkError::Unavailable)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| AcceptedWorkSinkError::Unavailable)?;
        state
            .progress
            .push(acknowledgement.verified_progress().to_decimal_string());
        state.maybe_latest_lease_context = Some(lease_context);
        Ok(())
    }
}

pub(super) fn authority_config() -> Result<Config, Box<dyn Error>> {
    let credential = ServiceCredential::new(
        CLIENT_ID,
        SERVICE_SECRET,
        DeploymentEnvironment::Development,
        "https://relying.example".to_owned(),
        vec!["https://app.relying.example".to_owned()],
        vec![
            ActionPolicy::AccountCreationLightV1,
            ActionPolicy::AccountCreationStandardV1,
        ],
    )?;
    let public = AuthorityPublicConfig::new(
        "https://authority.example",
        "https://authority.example",
        authority_keys()?,
        "https://authority.example/policies/operator",
        "https://authority.example/privacy",
        "https://authority.example/terms",
    )?;
    Ok(
        Config::new(DeploymentEnvironment::Development, vec![credential], public)?
            .with_signing_key_seed("authority-a".to_owned(), AUTHORITY_SIGNING_SEED)?,
    )
}

async fn spawn_reference_http(
    authority_url: String,
    database_url: &str,
) -> Result<(String, SocketAddr, tokio::task::JoinHandle<()>), Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let reference_url = format!("http://{address}");
    let trusted =
        reference_service::TrustedAuthority::new("https://authority.example", authority_keys()?)?;
    let config = reference_service::Config::new(
        authority_url,
        CLIENT_ID,
        SERVICE_SECRET,
        "https://relying.example",
        format!("{reference_url}/account-creation/redeem"),
        trusted,
    )?;
    let application =
        reference_service::ReferenceApplication::connect_postgres(config, database_url).await?;
    let task = tokio::spawn(async move {
        axum::serve(listener, reference_service::router(application))
            .await
            .expect("test Reference Relying Service should run until aborted");
    });
    Ok((reference_url, address, task))
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct IssuedPassSnapshot {
    pub(super) status: String,
    pub(super) gate_pass: String,
}

pub(super) async fn lookup_gate_pass(
    authority_url: &str,
    challenge_id: &ChallengeId,
    claimant: &Claimant,
    proof_id: &str,
    now: u64,
) -> Result<IssuedPassSnapshot, Box<dyn Error>> {
    let public_url = format!(
        "https://authority.example/v0/challenges/{}/gate-pass",
        challenge_id.as_str()
    );
    let proof = claimant.sign_issuance_proof(&public_url, challenge_id.as_str(), proof_id, now)?;
    let response = reqwest::Client::new()
        .get(format!(
            "{authority_url}/v0/challenges/{}/gate-pass",
            challenge_id.as_str()
        ))
        .header(CLAIMANT_PROOF_HEADER, proof)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let status = response["status"]
        .as_str()
        .ok_or("Gate Pass lookup status is missing")?
        .to_owned();
    let gate_pass = response["gate_pass"]
        .as_str()
        .ok_or_else(|| format!("Gate Pass lookup bytes are missing for status {status}"))?
        .to_owned();
    Ok(IssuedPassSnapshot { status, gate_pass })
}

pub(super) async fn spawn_http(
    router: Router,
) -> Result<(String, SocketAddr, tokio::task::JoinHandle<()>), std::io::Error> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("test server should run until its task is dropped");
    });
    Ok((format!("http://{address}"), address, task))
}
