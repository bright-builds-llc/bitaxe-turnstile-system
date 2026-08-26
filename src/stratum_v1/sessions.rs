use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::hmac;
use sqlx::PgPool;

use super::{StratumLeaseContext, StratumSessionConfig, StratumSessionCredentials, StratumV1Error};
use crate::progress::WorkSessionId;

/// Context-local durable mapping for short-lived Worker credentials and extranonce space.
#[derive(Clone)]
pub struct PostgresStratumSessionRegistry {
    pool: PgPool,
}

impl PostgresStratumSessionRegistry {
    pub async fn connect(database_url: &str) -> Result<Self, StratumV1Error> {
        let pool = PgPool::connect(database_url).await?;
        sqlx::migrate!("./migrations/pool_adapter")
            .run(&pool)
            .await?;
        Ok(Self { pool })
    }

    #[doc(hidden)]
    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn register(
        &self,
        credentials: &StratumSessionCredentials,
    ) -> Result<(), StratumV1Error> {
        let verifier = secret_verifier(credentials.secret());
        let maybe_session = sqlx::query_scalar::<_, String>(
            "INSERT INTO pool_adapter.stratum_sessions AS session (
                 session_id, username, secret_verifier, issued_at_unix_seconds,
                 expires_at_unix_seconds,
                 lease_id, continuity_id, last_monotonic_milliseconds,
                 renew_at_monotonic_milliseconds, lease_expires_at_monotonic_milliseconds
             ) VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, $8, $9, $10)
             ON CONFLICT (session_id) DO UPDATE
             SET secret_verifier = EXCLUDED.secret_verifier,
                 issued_at_unix_seconds = EXCLUDED.issued_at_unix_seconds,
                 expires_at_unix_seconds = EXCLUDED.expires_at_unix_seconds,
                 lease_id = EXCLUDED.lease_id,
                 continuity_id = EXCLUDED.continuity_id,
                 last_monotonic_milliseconds = EXCLUDED.last_monotonic_milliseconds,
                 renew_at_monotonic_milliseconds = EXCLUDED.renew_at_monotonic_milliseconds,
                 lease_expires_at_monotonic_milliseconds =
                     EXCLUDED.lease_expires_at_monotonic_milliseconds
             WHERE session.username = EXCLUDED.username
               AND (
                   EXCLUDED.issued_at_unix_seconds > session.issued_at_unix_seconds
                   OR (
                       EXCLUDED.issued_at_unix_seconds = session.issued_at_unix_seconds
                       AND session.secret_verifier = EXCLUDED.secret_verifier
                       AND session.expires_at_unix_seconds = EXCLUDED.expires_at_unix_seconds
                       AND session.lease_id = EXCLUDED.lease_id
                       AND session.continuity_id = EXCLUDED.continuity_id
                       AND session.last_monotonic_milliseconds =
                           EXCLUDED.last_monotonic_milliseconds
                       AND session.renew_at_monotonic_milliseconds =
                           EXCLUDED.renew_at_monotonic_milliseconds
                       AND session.lease_expires_at_monotonic_milliseconds =
                           EXCLUDED.lease_expires_at_monotonic_milliseconds
                   )
               )
             RETURNING session_id",
        )
        .bind(credentials.session_id().as_str())
        .bind(credentials.username())
        .bind(verifier)
        .bind(to_i64(credentials.issued_at_unix_seconds())?)
        .bind(to_i64(credentials.expires_at_unix_seconds())?)
        .bind(credentials.lease_context().lease_id())
        .bind(credentials.lease_context().continuity_id())
        .bind(to_i64(
            credentials.lease_context().last_monotonic_milliseconds(),
        )?)
        .bind(to_i64(
            credentials
                .lease_context()
                .renew_at_monotonic_milliseconds(),
        )?)
        .bind(to_i64(
            credentials
                .lease_context()
                .expires_at_monotonic_milliseconds(),
        )?)
        .fetch_optional(&self.pool)
        .await;
        match maybe_session {
            Ok(Some(_)) => Ok(()),
            Ok(None) => Err(StratumV1Error::ConflictingSessionReplay),
            Err(sqlx::Error::Database(error)) if error.is_unique_violation() => {
                Err(StratumV1Error::ConflictingSessionReplay)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub async fn authenticate(
        &self,
        username: &str,
        secret: &str,
        now_unix_seconds: u64,
    ) -> Result<Option<AuthenticatedStratumSession>, StratumV1Error> {
        let maybe_row = sqlx::query(
            "SELECT session_id, secret_verifier, issued_at_unix_seconds, expires_at_unix_seconds,
                    lease_id::text AS lease_id, continuity_id,
                    last_monotonic_milliseconds, renew_at_monotonic_milliseconds,
                    lease_expires_at_monotonic_milliseconds
             FROM pool_adapter.stratum_sessions WHERE username = $1",
        )
        .bind(username)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = maybe_row else {
            return Ok(None);
        };
        use sqlx::Row as _;
        let expires_at = to_u64(row.try_get("expires_at_unix_seconds")?)?;
        let persisted_verifier = row.try_get::<String, _>("secret_verifier")?;
        if now_unix_seconds >= expires_at || !verify_secret(secret, &persisted_verifier) {
            return Ok(None);
        }
        Ok(Some(AuthenticatedStratumSession {
            session_id: WorkSessionId::try_from(row.try_get::<String, _>("session_id")?)?,
            lease_context: StratumLeaseContext::new(
                row.try_get("lease_id")?,
                row.try_get("continuity_id")?,
                to_u64(row.try_get("last_monotonic_milliseconds")?)?,
                to_u64(row.try_get("renew_at_monotonic_milliseconds")?)?,
                to_u64(row.try_get("lease_expires_at_monotonic_milliseconds")?)?,
            )?,
            issued_at_unix_seconds: to_u64(row.try_get("issued_at_unix_seconds")?)?,
            expires_at_unix_seconds: expires_at,
        }))
    }

    pub async fn reserve_extranonce(
        &self,
        session_id: &WorkSessionId,
        connection_id: &str,
        extranonce1: &str,
        now_unix_seconds: u64,
    ) -> Result<(), StratumV1Error> {
        let canonical_extranonce = canonical_extranonce(connection_id, extranonce1)?;
        let result = sqlx::query_scalar::<_, String>(
            "INSERT INTO pool_adapter.stratum_connections AS connection (
                 connection_id, session_id, extranonce1, reserved_at_unix_seconds
             ) VALUES ($1::uuid, $2, $3, $4)
             ON CONFLICT (connection_id) DO UPDATE
             SET connection_id = connection.connection_id
             WHERE connection.session_id = EXCLUDED.session_id
               AND connection.extranonce1 = EXCLUDED.extranonce1
               AND connection.reserved_at_unix_seconds = EXCLUDED.reserved_at_unix_seconds
             RETURNING connection_id::text",
        )
        .bind(connection_id)
        .bind(session_id.as_str())
        .bind(canonical_extranonce)
        .bind(to_i64(now_unix_seconds)?)
        .fetch_optional(&self.pool)
        .await;
        match result {
            Ok(Some(_)) => Ok(()),
            Ok(None) => Err(StratumV1Error::ExtranonceCollision),
            Err(sqlx::Error::Database(error)) if error.is_unique_violation() => {
                Err(StratumV1Error::ExtranonceCollision)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub async fn reserve_connection(
        &self,
        connection_id: &str,
        extranonce1: &str,
        now_unix_seconds: u64,
    ) -> Result<(), StratumV1Error> {
        let canonical_extranonce = canonical_extranonce(connection_id, extranonce1)?;
        let result = sqlx::query_scalar::<_, String>(
            "INSERT INTO pool_adapter.stratum_connections AS connection (
                 connection_id, session_id, extranonce1, reserved_at_unix_seconds
             ) VALUES ($1::uuid, NULL, $2, $3)
             ON CONFLICT (connection_id) DO UPDATE
             SET connection_id = connection.connection_id
             WHERE connection.session_id IS NULL
               AND connection.extranonce1 = EXCLUDED.extranonce1
               AND connection.reserved_at_unix_seconds = EXCLUDED.reserved_at_unix_seconds
             RETURNING connection_id::text",
        )
        .bind(connection_id)
        .bind(canonical_extranonce)
        .bind(to_i64(now_unix_seconds)?)
        .fetch_optional(&self.pool)
        .await;
        map_reservation_result(result)
    }

    pub async fn bind_connection(
        &self,
        connection_id: &str,
        session_id: &WorkSessionId,
    ) -> Result<(), StratumV1Error> {
        if uuid::Uuid::parse_str(connection_id).is_err() {
            return Err(StratumV1Error::InvalidSessionConfig);
        }
        let maybe_connection = sqlx::query_scalar::<_, String>(
            "UPDATE pool_adapter.stratum_connections
             SET session_id = $2
             WHERE connection_id = $1::uuid
               AND (session_id IS NULL OR session_id = $2)
             RETURNING connection_id::text",
        )
        .bind(connection_id)
        .bind(session_id.as_str())
        .fetch_optional(&self.pool)
        .await?;
        maybe_connection
            .map(|_| ())
            .ok_or(StratumV1Error::ExtranonceCollision)
    }

    pub async fn release_unbound_connection(
        &self,
        connection_id: &str,
    ) -> Result<(), StratumV1Error> {
        if uuid::Uuid::parse_str(connection_id).is_err() {
            return Err(StratumV1Error::InvalidSessionConfig);
        }
        sqlx::query(
            "DELETE FROM pool_adapter.stratum_connections
             WHERE connection_id = $1::uuid AND session_id IS NULL",
        )
        .bind(connection_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

/// Verified durable session identity returned without exposing its stored verifier.
pub struct AuthenticatedStratumSession {
    session_id: WorkSessionId,
    lease_context: StratumLeaseContext,
    issued_at_unix_seconds: u64,
    expires_at_unix_seconds: u64,
}

impl AuthenticatedStratumSession {
    pub fn session_id(&self) -> &WorkSessionId {
        &self.session_id
    }

    pub fn expires_at_unix_seconds(&self) -> u64 {
        self.expires_at_unix_seconds
    }

    pub fn into_session_config(
        self,
        username: String,
        secret: String,
        now_unix_seconds: u64,
    ) -> Result<StratumSessionConfig, StratumV1Error> {
        if now_unix_seconds >= self.expires_at_unix_seconds {
            return Err(StratumV1Error::ExpiredCredentials);
        }
        let upstream_username = username.clone();
        let upstream_secret = secret.clone();
        Ok(StratumSessionConfig {
            session_id: self.session_id,
            lease_context: self.lease_context,
            username,
            secret,
            upstream_username,
            upstream_secret,
            issued_at_unix_seconds: self.issued_at_unix_seconds,
            expires_at_unix_seconds: self.expires_at_unix_seconds,
        })
    }
}

fn secret_verifier(secret: &str) -> String {
    URL_SAFE_NO_PAD.encode(hmac::sign(&secret_verifier_key(), secret.as_bytes()).as_ref())
}

fn canonical_extranonce(connection_id: &str, extranonce1: &str) -> Result<String, StratumV1Error> {
    if uuid::Uuid::parse_str(connection_id).is_err() {
        return Err(StratumV1Error::InvalidSessionConfig);
    }
    if extranonce1.is_empty()
        || extranonce1.len() > 64
        || !extranonce1.len().is_multiple_of(2)
        || !extranonce1.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(StratumV1Error::InvalidExtranonce);
    }
    Ok(extranonce1.to_ascii_lowercase())
}

fn map_reservation_result(
    result: Result<Option<String>, sqlx::Error>,
) -> Result<(), StratumV1Error> {
    match result {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(StratumV1Error::ExtranonceCollision),
        Err(sqlx::Error::Database(error)) if error.is_unique_violation() => {
            Err(StratumV1Error::ExtranonceCollision)
        }
        Err(error) => Err(error.into()),
    }
}

fn verify_secret(secret: &str, verifier: &str) -> bool {
    URL_SAFE_NO_PAD
        .decode(verifier)
        .ok()
        .is_some_and(|tag| hmac::verify(&secret_verifier_key(), secret.as_bytes(), &tag).is_ok())
}

fn secret_verifier_key() -> hmac::Key {
    hmac::Key::new(hmac::HMAC_SHA256, b"BWG/0.1 Stratum secret verifier")
}

fn to_i64(value: u64) -> Result<i64, StratumV1Error> {
    i64::try_from(value).map_err(|_| StratumV1Error::InvalidSessionConfig)
}

fn to_u64(value: i64) -> Result<u64, StratumV1Error> {
    u64::try_from(value).map_err(|_| StratumV1Error::ConflictingSessionReplay)
}
