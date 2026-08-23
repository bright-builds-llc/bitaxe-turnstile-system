ALTER TABLE gate_authority.work_challenges
ADD COLUMN terminal_at_unix_seconds BIGINT;

ALTER TABLE gate_authority.work_challenges
ADD CONSTRAINT work_challenges_terminal_positive CHECK (
    terminal_at_unix_seconds IS NULL OR terminal_at_unix_seconds > 0
);

UPDATE gate_authority.work_challenges AS challenge
SET terminal_at_unix_seconds = challenge.expires_at_unix_seconds
WHERE NOT EXISTS (
    SELECT 1
    FROM gate_authority.gate_pass_issuance_intents AS intent
    WHERE intent.challenge_id = challenge.challenge_id
);

UPDATE gate_authority.work_challenges AS challenge
SET terminal_at_unix_seconds = CASE intent.status
    WHEN 'issued' THEN intent.issued_at_unix_seconds
    WHEN 'failed' THEN intent.signing_deadline_unix_seconds
    ELSE NULL
END
FROM gate_authority.gate_pass_issuance_intents AS intent
WHERE intent.challenge_id = challenge.challenge_id;

CREATE INDEX work_challenges_terminal_at
ON gate_authority.work_challenges (terminal_at_unix_seconds)
WHERE terminal_at_unix_seconds IS NOT NULL;

ALTER TABLE gate_authority.gate_pass_issuance_intents
ADD COLUMN gate_pass_retired_at_unix_seconds BIGINT;

ALTER TABLE gate_authority.gate_pass_issuance_intents
DROP CONSTRAINT gate_pass_issuance_intents_check;

ALTER TABLE gate_authority.gate_pass_issuance_intents
ADD CONSTRAINT gate_pass_issuance_material_state CHECK (
    (
        status = 'issued'
        AND issued_at_unix_seconds IS NOT NULL
        AND issued_at_unix_seconds > 0
        AND expires_at_unix_seconds IS NOT NULL
        AND expires_at_unix_seconds > issued_at_unix_seconds
        AND (
            (gate_pass IS NOT NULL AND gate_pass_retired_at_unix_seconds IS NULL)
            OR (
                gate_pass IS NULL
                AND gate_pass_retired_at_unix_seconds >= expires_at_unix_seconds
            )
        )
    )
    OR (
        status <> 'issued'
        AND gate_pass IS NULL
        AND gate_pass_retired_at_unix_seconds IS NULL
    )
);

ALTER TABLE gate_authority.governance_tombstones
ADD CONSTRAINT governance_tombstone_time_order CHECK (
    terminal_at_unix_seconds > 0
    AND pseudonymized_at_unix_seconds >= terminal_at_unix_seconds
    AND delete_after_unix_seconds >= pseudonymized_at_unix_seconds
);
