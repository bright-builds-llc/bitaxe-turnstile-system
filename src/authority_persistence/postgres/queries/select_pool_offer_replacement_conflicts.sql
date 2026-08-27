SELECT EXISTS (
           SELECT 1
           FROM gate_authority.pool_offer_replacements
           WHERE replaced_session_id = $1
       ) AS replacement_exists,
       EXISTS (
           SELECT 1
           FROM gate_authority.work_sessions
           WHERE session_id = $2
       ) AS candidate_exists
