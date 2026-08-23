# Select the Gate Pass signing key when signing succeeds

A Gate Pass Issuance Intent pins pass identity, claims, algorithm, and signing deadline but not a specific `kid`. The first successful signer transaction selects an eligible active key and atomically stores that `kid` with the final compact JWS bytes under a uniqueness constraint, allowing key rotation to recover unsigned backlog while every retry returns one identical pass.
