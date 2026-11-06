# Pool Adapter takes claimant Pool Selection and extends Stratum sessions on Renew

Type: task
Status: resolved
Blocked by: 01

## Objective

Ticket 01 left three Pool Adapter limits that stop a real Bitaxe lease from
outliving its first minute.

The first is that no claimant route accepts the raw Pool Selection, so Start
still needs a selection consented through `SimulatedPoolAdapter`. Hydra's
upstream authorization (`StratumUpstreamAuthorization::from_authority_binding`)
also needs that raw payout choice.

The second is that Stratum credentials last at most 60 seconds, and an admitted
connection keeps the expiry it had at admission. Renew extends the Authority
lease but not the Worker's Stratum session, which ends at about 60 seconds.

The third is that the session registry rotates credentials only when the issue
second advances, so a re-grant within the same second answers 503.

## Plan

- [x] Claimant Pool Selection intake at the Pool Adapter boundary, keeping the
  Authority on the commitment alone, with the Hydra upstream authorization
  derived from it.
- [x] Renew extends the registered and live Stratum session without changing
  the Worker's password, or a decision recorded that the grant carries fresh
  credentials.
- [x] Same-second re-grant succeeds without letting an older generation roll
  back a newer one.
- [x] Tests for each, and update `docs/protocol/bwg-0.1-stratum-v1-proxy.md`.

## Answer

ADR-0107 and commits `0d065a2`, `a68477a`, `c9b4261` and `fc2260e`. The
claimant selects with `POST /v0/challenges/{challenge_id}/work-session/pool-selection`
under the ADR-0106 proof. The Authority keeps only the commitment and hands the
raw choice to the in-process Pool Adapter. The Pool Adapter stores the choice in
`pool_adapter.session_pool_selections` and deletes it at satisfaction, cancel
and expiry. With per-session upstream authorization, the TCP proxy derives each
connection's Hydra identity from that row. Pool Adapter migration 0002 orders
credential generations by issue milliseconds. Renew extends the registered and
live Stratum session under the same password.

The tests cover each part:
- `tests/claimant_pool_selection.rs` scans every Authority table and all log
  output for the raw address, and covers deletion at cancel, satisfaction and
  lookup after expiry, plus the 409 on a changed choice.
- `tests/stratum_v1_proxy/session_upstream.rs` covers the per-session pool
  identity and refuses a session without a stored choice.
- `tests/stratum_v1_proxy/renewal.rs` covers in-place extension and a live
  connection outliving its admitted expiry.
- `tests/stratum_v1_proxy/persistence.rs` covers the same-second re-grant.

## Comments

2026-11-05, parts 2 and 3. Pool Adapter migration 0002 orders credential
generations by issue milliseconds, so a Resume in the same second as its Start
now succeeds. Renew extends the registration in place and keeps the verifier,
so the password is unchanged. A live connection rereads its registration every
five seconds and at expiry. Submits advance the lease reading in milliseconds
from the Authority lease clock's own reading. Tests are in
`tests/stratum_v1_proxy/renewal.rs` and `tests/claimant_work_session.rs`.

Part 1, on the owner's choices 1a and 2a with their two conditions: the
privacy test, and deletion at terminal states rather than only at retention.
Nothing deploys the per-session proxy mode or an expiry sweep yet; Ticket 06
composes them.

Open risk for Ticket 06: accepted work is delivered after it is observed, and
the Authority stops a session whose reading trails the last one it recorded. A
share observed just before a Renew and delivered after it would therefore stop
the lease. How likely that is depends on the delivery loop, which nothing
deploys yet.
