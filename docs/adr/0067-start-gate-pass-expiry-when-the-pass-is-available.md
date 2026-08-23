# Start Gate Pass expiry when the signed pass is durably available

A Gate Pass Issuance Intent's signing deadline equals its Work Challenge expiry, while Gate Pass `iat` and the two-minute Redemption window begin only when the first signed compact JWS is durably stored and retrievable. The signer may retry with any eligible key until that deadline; an unsigned intent then becomes terminally failed and can never mint a pass later. This prevents signing outages from silently consuming the Claimant's Redemption window without permitting indefinitely delayed authorization.
