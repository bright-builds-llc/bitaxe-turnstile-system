WITH RECURSIVE session_lineage AS (
    SELECT session_id, replaces_session_id, 0 AS depth
    FROM gate_authority.work_sessions
    WHERE session_id = $1

    UNION ALL

    SELECT predecessor.session_id,
           predecessor.replaces_session_id,
           lineage.depth + 1
    FROM gate_authority.work_sessions AS predecessor
    JOIN session_lineage AS lineage
      ON predecessor.session_id = lineage.replaces_session_id
)
SELECT session.challenge_id,
       session.pool_offer_id,
       session.payout_commitment,
       (
           SELECT replacement.candidate_offer
           FROM session_lineage AS lineage
           JOIN gate_authority.pool_offer_replacements AS replacement
             ON replacement.candidate_session_id = lineage.session_id
           ORDER BY lineage.depth
           LIMIT 1
       ) AS replacement_offer
FROM gate_authority.work_sessions AS session
WHERE session.session_id = $1
