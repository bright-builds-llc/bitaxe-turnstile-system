# Compose and rehearse the production path

Type: task
Status: resolved
Blocked by: 12

## Objective

Assemble the page and services Ticket 07 will use, and rehearse them end to end
with a software device and test keys, so the hardware run only adds the board.

## Plan

- [x] Reference account-creation page with `bwg-core/component` and
  `connectWebSerialHeadlessClient`, for a board already running the C image.
  Onboarding is proven apart from it (Tickets 03 to 05 and 15).
- [x] Gate Authority, Reference Relying Service, PostgreSQL, the Stratum V1 proxy
  and pinned Hydra and Bitcoin Core, started by one script. Core Ticket 24 owns
  the general self-hosted package; this is the narrower run setup.
- [x] A browser test from challenge to redeemed Gate Pass through the simulated
  serial Worker, with Verified Progress from adapter-accepted work and restoration
  confirmed at the Work Requirement.
- [x] A written run sheet for Ticket 07: page, commits, keys the owner loads, and
  the stop conditions.

## Answer

`scripts/rehearse-production-path.sh` runs the production `gate-authority` and
`reference-service` binaries behind one HTTPS origin, on regtest with test keys.
`gate-authority` now runs the Pool Adapter's proxy, delivery and expiry sweep
in its own process when `BWG_STRATUM_PROXY_LISTEN_ADDRESS` is set (ADR-0109).
The page is `reference/account-creation.html`. Its claimant transport and
20-second Renew stay in reference-page code until Ticket 17.

The browser test drives the page through a fake serial Worker, which hands its
Stratum grant to a CPU miner. On the passing run:

- one Renew landed while shares were in flight;
- 41 real shares were acknowledged across two lease windows, with no refusals,
  and credited as Verified Progress;
- one synthetic share crossed the Work Requirement;
- restoration was confirmed as `challenge_satisfied`, and the miner stopped;
- redemption returned 200, and the replay was refused with 401.

Only the rehearsal harness can send the synthetic share, and
`tests/rehearsal_isolation.rs` checks that no library or production source names
it. The run sheet for Ticket 07 is [run-sheet-07.md](../run-sheet-07.md).

Non-claim: real shares did not reach the Standard Work Requirement here. Ticket 07
proves that on the 601.

## Comments
