# Recover Gate Pass issuance workers with durable leases

Gate Pass issuance persists `pending`, `signing`, `issued`, or `failed` state and uses a short renewable lease while signing. Workers atomically claim eligible intents, and another worker may reclaim an expired lease after a crash; attempt metadata is diagnostic, while the immutable signing deadline and unique stored compact JWS determine behavior.
