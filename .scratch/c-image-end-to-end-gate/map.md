# C-image end-to-end Gate map

[Spec](spec.md). The first Gate on the C Reference Firmware image through the
production browser path. Tickets 01, 10 and 11 are resolved; the rest is still planning.

| Ticket | Type | Status | Blocked by |
| --- | --- | --- | --- |
| [01](issues/01-authority-worker-lease-grants.md) Authority issues signed Worker Lease grants and renewals | task | resolved | None |
| [02](issues/02-c-image-onboarding-contract.md) Agree the C image's onboarding contract | grilling | ready-for-human | None |
| [03](issues/03-c-image-onboarding-commands.md) C image serves onboarding inspection and install | task | ready-for-agent | 02 |
| [04](issues/04-web-serial-onboarding-device.md) Web Serial onboarding device | task | ready-for-agent | 02 |
| [05](issues/05-signed-c-image-package.md) Owner signs the C image's firmware package | task | ready-for-human | 03, 04 |
| [11](issues/11-late-work-delivery-after-renew.md) Authority judges a Work Event by the reading at which it was observed | task | resolved | 10 |
| [12](issues/12-terminal-refusal-of-uncreditable-work.md) Authority refuses uncreditable work terminally, and delivery stops retrying it | task | ready-for-agent | 11 |
| [06](issues/06-production-path-rehearsal.md) Compose and rehearse the production path | task | ready-for-agent | 04, 12 |
| [07](issues/07-first-c-image-gate.md) First end-to-end Gate on the C image | task | ready-for-human | 05, 06 |
| [08](issues/08-interruptions-and-negatives.md) Interruptions and negatives on the C image | task | ready-for-human | 07 |
| [09](issues/09-core-mvp-evidence-map.md) Map C-image evidence onto the Core MVP | task | ready-for-agent | 08 |
| [10](issues/10-pool-adapter-claimant-intake-and-renewal.md) Pool Adapter takes claimant Pool Selection and extends Stratum sessions on Renew | task | resolved | 01 |
| [13](issues/13-flaky-sse-expiry-test.md) Lifecycle SSE expiry test flakes under load | bug | ready-for-agent | None |

## Decisions so far

- Ticket 01, ADR-0106: claimant Work Session routes on the Authority issue signed
  Worker Lease grants and renewals, and also carry claimant Pause and Cancel.
  Pool Selection stays at the Pool Adapter, which is Ticket 10.
- Ticket 10: Renew extends the Worker's Stratum session in place under the same
  password, rather than the renewal carrying fresh credentials. Credential
  generations are ordered by issue milliseconds. ADR-0107: claimant Pool
  Selection is an Authority route that keeps only the commitment. The Pool
  Adapter stores the raw choice until the challenge is terminal.
- Ticket 11: accepted work is judged by its reading inside the lease window,
  not by delivery time or order. Deduplication stops a second credit.
- Ticket 12, on the owner's choices: work delivered after the challenge
  deadline is dropped. The Authority refuses uncreditable work with a typed,
  terminal refusal, and delivery retries only outages.
