# BWG/0.1 Pool Offers and Direct Payout Selection

Every issued Work Challenge carries `pool_offers`, a visible non-empty offer list plus a compact
Authority signature. The JWS protected type is `bwg-pool-offer-set+jws`; its payload binds the
Authority issuer, exact Work Challenge ID, immutable Action Policy revision, exact ordered offers,
and `BWG/0.1`. Clients verify the configured issuer, challenge, policy, and Authority key before
treating any visible offer as approved. Changing an endpoint, fee, allocation, privacy term, or any
other signed byte without a new valid signature fails closed.

Each offer discloses the Mining Pool and Pool Adapter identities, versions, source repositories,
and licenses; Stratum transport and endpoint; Reward Policy and all fees; accepted payout-choice
types; privacy terms; and operator terms. The reference offer uses the separately deployed
[P2Poolv2](https://github.com/p2poolv2/p2poolv2) `v0.12.0` engine at
`8eca024bde6c2de74620dce2f9cc7fb9a544c5c0` under `AGPL-3.0-or-later` and the BWG Stratum V1
adapter under MIT. Its solo/direct-coinbase policy allocates 100% to the selected destination with
zero pool and service fees. Lower-difficulty Accepted Work creates only gate
progress: it creates no future-revenue claim, custodial balance, payout threshold, or PPLNS record.

The Claimant chooses a checksum-valid Base58Check or SegWit mainnet receive address, or an
offer-approved beneficiary, through the Pool Adapter boundary. The raw value stays local to that
boundary for job construction. The Gate
Authority receives and persists only a domain-separated, challenge-scoped SHA-256 commitment plus
the approved offer ID; the Relying Service, Work Challenge, Gate Pass, lifecycle SSE, logs, and
governance exports never receive the raw payout value.

The commitment input is the UTF-8 domain `BWG/0.1 pool selection commitment`, followed by NUL and
the challenge ID, offer ID, destination type, and destination value, with a NUL between each field.

A proposal may be replaced while the challenge remains `issued`. Work Consent confirms the exact
commitment, after which the selection is durable and immutable across restart. Work Session
registration is forbidden until a consented selection exists. The pure classification contract
allows pre-consented endpoint/identity failover only when economic, payout, privacy, operator, and
license terms remain equivalent; any listed change requires fresh Work Consent, while an unsupported
transport fails validation entirely.

On upgrade, a legacy challenge without signed Pool Offers cannot safely begin or resume work. Its
sessions fail closed, any unsigned issuance intent becomes terminal, and an issued/active/satisfied
challenge expires. Legacy descriptors remain readable so an already-issued Gate Pass can complete
its bounded lookup/retirement lifecycle without making the old challenge selectable again.
