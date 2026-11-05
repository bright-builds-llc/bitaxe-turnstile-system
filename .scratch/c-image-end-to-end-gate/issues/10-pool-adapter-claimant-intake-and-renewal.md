# Pool Adapter takes claimant Pool Selection and extends Stratum sessions on Renew

Type: task
Status: ready-for-agent
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

- [ ] Claimant Pool Selection intake at the Pool Adapter boundary, keeping the
  Authority on the commitment alone, with the Hydra upstream authorization
  derived from it.
- [ ] Renew extends the registered and live Stratum session without changing
  the Worker's password, or a decision recorded that the grant carries fresh
  credentials.
- [ ] Same-second re-grant succeeds without letting an older generation roll
  back a newer one.
- [ ] Tests for each, and update `docs/protocol/bwg-0.1-stratum-v1-proxy.md`.

## Comments
