WITH deleted_proofs AS (
    DELETE FROM claimant_issuance_proofs
    WHERE challenge_id = $1
), deleted_events AS (
    DELETE FROM accepted_work_events
    WHERE challenge_id = $1
), deleted_fingerprints AS (
    DELETE FROM share_fingerprints
    WHERE challenge_id = $1
), deleted_sessions AS (
    DELETE FROM work_sessions
    WHERE challenge_id = $1
), deleted_pool_selection AS (
    DELETE FROM pool_selections
    WHERE challenge_id = $1
), deleted_outbox AS (
    DELETE FROM authority_outbox
    WHERE aggregate_id = $1
), deleted_intent AS (
    DELETE FROM gate_pass_issuance_intents
    WHERE challenge_id = $1
)
DELETE FROM work_challenges
WHERE challenge_id = $1
