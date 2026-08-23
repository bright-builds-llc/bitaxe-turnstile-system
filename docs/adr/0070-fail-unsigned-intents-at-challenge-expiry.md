# Fail unsigned issuance intents at Work Challenge expiry

The Gate Pass signer may retry a durable Issuance Intent with any eligible signing key until the associated Work Challenge expires. If no signed pass has been durably stored by that deadline, the intent becomes terminally failed and can never mint a pass afterward; the Claimant must start a new Work Challenge unless the applicable Abuse Policy explicitly permits a separate fallback.
