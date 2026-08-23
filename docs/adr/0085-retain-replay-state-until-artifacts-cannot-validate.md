# Retain replay state until authorization artifacts cannot validate

The Gate Authority keeps signed issuance material claimant-retrievable through Gate Pass expiry plus maximum clock skew and may then remove the JWS while retaining policy-required audit metadata. A Relying Service keeps Pass Consumption markers until no conforming verifier could accept the pass, while Redemption Records and Protected Action Outcomes follow their independent audit or product retention policy.
