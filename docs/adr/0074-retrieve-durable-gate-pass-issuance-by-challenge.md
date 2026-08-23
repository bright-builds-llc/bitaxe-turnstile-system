# Retrieve durable Gate Pass issuance by Work Challenge

A Claimant-authenticated Issuance Lookup keyed by Work Challenge ID returns `pending`, terminal `failed`, or the exact compact JWS bytes durably stored for an issued Gate Pass. Repeated lookup never signs again, changes the chosen key, extends pass expiry, or returns different successful bytes, making delayed issuance and lost responses safely recoverable.
