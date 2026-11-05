use sqlx::PgPool;

use crate::authority_persistence::AuthorityPersistenceError;

/// Allocates the next sequence for one Work Lease Authority key, or none at the ceiling.
pub(super) async fn allocate(
    pool: &PgPool,
    key_id: &str,
) -> Result<u64, AuthorityPersistenceError> {
    let maybe_sequence = sqlx::query_scalar::<_, i64>(
        "INSERT INTO gate_authority.work_lease_authorization_sequences AS sequence
             (key_id, last_sequence)
         VALUES ($1, 1)
         ON CONFLICT (key_id) DO UPDATE
         SET last_sequence = sequence.last_sequence + 1
         WHERE sequence.last_sequence < 9223372036854775807
         RETURNING last_sequence",
    )
    .bind(key_id)
    .fetch_optional(pool)
    .await?;
    let Some(sequence) = maybe_sequence else {
        return Err(AuthorityPersistenceError::WorkLeaseSequenceExhausted);
    };
    u64::try_from(sequence).map_err(|_| AuthorityPersistenceError::InvalidPersistedData)
}
