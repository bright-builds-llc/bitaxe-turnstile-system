//! Raw claimant Pool Selection held at the Pool Adapter until its challenge ends (ADR-0107).

use sqlx::Row as _;

use super::{PostgresStratumSessionRegistry, StratumUpstreamAuthorization, StratumV1Error};
use crate::{
    challenge::ChallengeId,
    pool_offer::{PoolSelection, PoolSelectionCommitment},
    progress::WorkSessionId,
};

impl PostgresStratumSessionRegistry {
    /// Stores one session's raw Pool-facing payout choice beside its commitment.
    ///
    /// A later choice for the same challenge replaces an earlier one; the Authority refuses
    /// any change once the choice is consented.
    pub async fn record_pool_selection(
        &self,
        session_id: &WorkSessionId,
        challenge_id: &ChallengeId,
        selection: &PoolSelection,
        challenge_expires_at_unix_seconds: u64,
        now_unix_seconds: u64,
    ) -> Result<(), StratumV1Error> {
        sqlx::query(
            "INSERT INTO pool_adapter.session_pool_selections AS selection (
                 session_id, challenge_id, pool_offer_id, payout_destination_type,
                 payout_destination, payout_commitment, challenge_expires_at_unix_seconds,
                 recorded_at_unix_seconds
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (session_id) DO UPDATE
             SET pool_offer_id = EXCLUDED.pool_offer_id,
                 payout_destination_type = EXCLUDED.payout_destination_type,
                 payout_destination = EXCLUDED.payout_destination,
                 payout_commitment = EXCLUDED.payout_commitment,
                 recorded_at_unix_seconds = EXCLUDED.recorded_at_unix_seconds
             WHERE selection.challenge_id = EXCLUDED.challenge_id",
        )
        .bind(session_id.as_str())
        .bind(challenge_id.as_str())
        .bind(selection.offer_id())
        .bind(selection.payout_destination_type())
        .bind(selection.payout_destination())
        .bind(selection.commitment(challenge_id.as_str()))
        .bind(to_i64(challenge_expires_at_unix_seconds)?)
        .bind(to_i64(now_unix_seconds)?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Derives one session's Pool-facing authorization from its stored choice.
    ///
    /// A choice whose challenge has expired is deleted here and yields nothing.
    pub async fn session_upstream_authorization(
        &self,
        session_id: &WorkSessionId,
        upstream_secret: &str,
        now_unix_seconds: u64,
    ) -> Result<Option<StratumUpstreamAuthorization>, StratumV1Error> {
        let maybe_row = sqlx::query(
            "SELECT challenge_id, pool_offer_id, payout_destination_type, payout_destination,
                    payout_commitment, challenge_expires_at_unix_seconds
             FROM pool_adapter.session_pool_selections WHERE session_id = $1",
        )
        .bind(session_id.as_str())
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = maybe_row else {
            return Ok(None);
        };
        let expires_at = u64::try_from(row.try_get::<i64, _>("challenge_expires_at_unix_seconds")?)
            .map_err(|_| StratumV1Error::InvalidSessionConfig)?;
        if now_unix_seconds >= expires_at {
            self.delete_expired_pool_selections(now_unix_seconds)
                .await?;
            return Ok(None);
        }
        let challenge_id = ChallengeId::try_from(row.try_get::<String, _>("challenge_id")?)
            .map_err(|_| StratumV1Error::InvalidSessionConfig)?;
        let offer_id = row.try_get::<String, _>("pool_offer_id")?;
        let destination = row.try_get::<String, _>("payout_destination")?;
        let selection = match row
            .try_get::<String, _>("payout_destination_type")?
            .as_str()
        {
            "bitcoin_mainnet_address" => {
                PoolSelection::bitcoin_address(offer_id.clone(), destination)
            }
            "approved_beneficiary" => {
                PoolSelection::approved_beneficiary(offer_id.clone(), destination)
            }
            _ => return Err(StratumV1Error::InvalidSessionConfig),
        }
        .map_err(|_| StratumV1Error::InvalidSessionConfig)?;
        let retained = PoolSelectionCommitment::persisted(
            offer_id,
            row.try_get::<String, _>("payout_commitment")?,
        )
        .map_err(|_| StratumV1Error::InvalidSessionConfig)?;
        StratumUpstreamAuthorization::from_authority_binding(
            &challenge_id,
            session_id.clone(),
            &selection,
            retained,
            upstream_secret.to_owned(),
        )
        .map(Some)
    }

    /// Deletes a challenge's raw choice once the challenge reaches a terminal state.
    pub async fn delete_pool_selection(
        &self,
        challenge_id: &ChallengeId,
    ) -> Result<(), StratumV1Error> {
        sqlx::query("DELETE FROM pool_adapter.session_pool_selections WHERE challenge_id = $1")
            .bind(challenge_id.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Deletes every raw choice whose challenge has expired, returning how many went.
    pub async fn delete_expired_pool_selections(
        &self,
        now_unix_seconds: u64,
    ) -> Result<u64, StratumV1Error> {
        Ok(sqlx::query(
            "DELETE FROM pool_adapter.session_pool_selections
             WHERE challenge_expires_at_unix_seconds <= $1",
        )
        .bind(to_i64(now_unix_seconds)?)
        .execute(&self.pool)
        .await?
        .rows_affected())
    }
}

fn to_i64(value: u64) -> Result<i64, StratumV1Error> {
    i64::try_from(value).map_err(|_| StratumV1Error::InvalidSessionConfig)
}
