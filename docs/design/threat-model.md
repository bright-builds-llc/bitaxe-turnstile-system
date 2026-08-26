# Threat Model

## Trust boundaries

- A Relying Service explicitly trusts configured Gate Authorities.
- A Gate Authority explicitly trusts configured Pool Adapters.
- The Claimant trusts the selected Pool Offer, Reference Client, and any Worker Controller used.
- A Mining Pool retains authority over Bitcoin jobs, block submission, and reward construction.
- Self-hosting collapses delegation but does not make unsafe code or operations trustless.

## Threats and controls

| Threat | Primary controls | Residual risk |
| --- | --- | --- |
| Replayed or stolen Gate Pass | Short expiry, audience and action binding, DPoP, atomic consumption | A compromised trusted Authority can still mint passes |
| Fake or duplicate work | Challenge-scoped sessions, assigned targets, accepted-response evidence, durable event IDs and share fingerprints | A malicious trusted Pool Adapter can falsely attest work |
| Cryptojacking by a website | Work Consent, client ceilings, no page-load mining, Authority-origin attested WebAuthn confirmation and signed receipts for consequential work, expiring leases | A malicious page can still misrepresent Light or Standard custom UI around the conforming component; WebAuthn does not prove personal identity |
| Worker left on challenge pool | Monotonic Work Lease, loss-of-continuity stop, Mining Baseline snapshot and restoration | Firmware compromise can bypass its own controls |
| Mainnet reward loss | Independent Reward Policy checks, exact BIP 23 proposal acceptance, immediate block submission, pinned pool engine | A latent consensus, construction, or operational bug can still lose a rare block reward |
| Cross-site tracking | Fresh pairwise Claimant keys, opaque Action References, context minimization, ephemeral payout defaults | Reused Bitcoin addresses and network metadata remain correlatable by observers |
| Device or relay compromise | Device Identity challenge-response, signed commands, narrow remote API, local-only dangerous controls, signed OTA | V1 Device Identity is not tamper-proof hardware attestation |
| Account takeover | Passkeys or NIP-46/NIP-98 strong auth, Step-Up Authentication, user-held recovery, no staff override | Compromise of every linked authenticator remains account compromise |
| Pool or Authority outage | Equivalent pre-consented failover, explicit Abuse Policy fallback, fail-closed BWG outcome | A service with no fallback can become unavailable |
| Large miner advantage | Equal normalized work for equivalent risk | High-hashrate actors finish faster; BWG prices work and does not equalize time |

## Non-claims

BWG does not prove humanity, uniqueness, identity, physical Bitaxe ownership, actual joules consumed, clean energy provenance, or freedom from automation. It does not make configured Gate Authorities, Pool Adapters, pools, relays, firmware, or clients globally trustless.
