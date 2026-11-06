# C-image end-to-end Gate map

[Spec](spec.md). The first Gate on the C Reference Firmware image through the
production browser path. Tickets 01, 02, 10, 11 and 12 are resolved; the rest is still planning.
The first Gate (06, 07) and onboarding (14, 03, 04, 05, 15) run apart, and both
feed 09.

| Ticket | Type | Status | Blocked by |
| --- | --- | --- | --- |
| [01](issues/01-authority-worker-lease-grants.md) Authority issues signed Worker Lease grants and renewals | task | resolved | None |
| [02](issues/02-c-image-onboarding-contract.md) Agree the C image's onboarding contract | grilling | resolved | None |
| [14](issues/14-gate-onboarding-contract-for-the-c-image.md) Gate onboarding contract matches the C image | task | ready-for-agent | 02 |
| [03](issues/03-c-image-onboarding-commands.md) C image reports onboarding facts and guards its own boot | task | ready-for-agent | 02, 14 |
| [04](issues/04-web-serial-onboarding-device.md) Browser onboarding device over the ROM bootloader | task | ready-for-agent | 03 |
| [05](issues/05-signed-c-image-package.md) Owner signs the C image's firmware package | task | ready-for-human | 03, 04 |
| [15](issues/15-c-image-onboarding-on-the-601.md) Onboarding on the 601, from stock and between reference images | task | ready-for-human | 05 |
| [11](issues/11-late-work-delivery-after-renew.md) Authority judges a Work Event by the reading at which it was observed | task | resolved | 10 |
| [12](issues/12-terminal-refusal-of-uncreditable-work.md) Authority refuses uncreditable work terminally, and delivery stops retrying it | task | resolved | 11 |
| [06](issues/06-production-path-rehearsal.md) Compose and rehearse the production path | task | claimed | 12 |
| [07](issues/07-first-c-image-gate.md) First end-to-end Gate on the C image | task | ready-for-human | 06 |
| [08](issues/08-interruptions-and-negatives.md) Interruptions and negatives on the C image | task | ready-for-human | 07, 17 |
| [09](issues/09-core-mvp-evidence-map.md) Map C-image evidence onto the Core MVP | task | ready-for-agent | 08, 15 |
| [10](issues/10-pool-adapter-claimant-intake-and-renewal.md) Pool Adapter takes claimant Pool Selection and extends Stratum sessions on Renew | task | resolved | 01 |
| [13](issues/13-flaky-sse-expiry-test.md) Lifecycle SSE expiry test flakes under load | bug | ready-for-agent | None |
| [16](issues/16-pool-adapter-grpc-process.md) Pool Adapter runs as its own process over gRPC | task | ready-for-agent | None |
| [17](issues/17-sdk-http-transport-and-renew.md) SDK claimant HTTP transport and component-owned Renew | task | ready-for-agent | 06 |

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
- Ticket 12, ADR-0108, on the owner's choices: work delivered after the
  challenge deadline is dropped. The Authority refuses uncreditable work with a
  typed, terminal refusal, and delivery retries only outages, with backoff. The
  refusal belongs to the adapter boundary and its shared vectors, not OpenAPI.
- Ticket 02, on the owner's choices: the first Gate runs on a 601 flashed by
  hand, and onboarding is proven apart from it. Onboarding covers stock ESP-Miner
  and reference updates, and every ESP-Miner build is settings schema `1`. The
  browser is the one writer, through the ROM bootloader with a pinned esptool-js.
  It refuses an unknown partition table before any write, never writes NVS except
  to restore the backup on rollback, and checks settings with nonce-keyed HMACs.
  The C image turns on app rollback and marks itself valid only after its own
  startup check. Upstream's table becomes scheme `esp32-factory-ota-ab`. The Worker
  Serial manifest shouldn't change. Ticket 14 records it in an ADR.
- Ticket 06, ADR-0109, on the owner's choices: the Pool Adapter's proxy, delivery
  and expiry sweep run in the Authority's process until Ticket 16 builds the gRPC
  process. The rehearsal crosses the Work Requirement with one synthetic share
  that only the rehearsal can send. Ticket 17 moves the HTTP transport and Renew
  into the SDK before anything past 07.
