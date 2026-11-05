# Compose and rehearse the production path

Type: task
Status: ready-for-agent
Blocked by: 01, 04

## Objective

Assemble the page and services Ticket 07 will use, and rehearse them end to end
with a software device and test keys, so the hardware run only adds the board.

## Plan

- [ ] Reference account-creation page with `bwg-core/component`,
  `connectWebSerialHeadlessClient` and the onboarding device.
- [ ] Gate Authority, Reference Relying Service, PostgreSQL, the Stratum V1 proxy
  and pinned Hydra and Bitcoin Core, started by one script. Core Ticket 24 owns
  the general self-hosted package; this is the narrower run setup.
- [ ] A browser test from challenge to redeemed Gate Pass through the simulated
  serial Worker, with Verified Progress from adapter-accepted work and restoration
  confirmed at the Work Requirement.
- [ ] A written run sheet for Ticket 07: page, commits, keys the owner loads, and
  the stop conditions.

## Comments
