# C-image end-to-end Gate map

[Spec](spec.md). The first Gate on the C Reference Firmware image through the
production browser path. Planning only so far.

| Ticket | Type | Status | Blocked by |
| --- | --- | --- | --- |
| [01](issues/01-authority-worker-lease-grants.md) Authority issues signed Worker Lease grants and renewals | task | needs-info | None |
| [02](issues/02-c-image-onboarding-contract.md) Agree the C image's onboarding contract | grilling | ready-for-human | None |
| [03](issues/03-c-image-onboarding-commands.md) C image serves onboarding inspection and install | task | ready-for-agent | 02 |
| [04](issues/04-web-serial-onboarding-device.md) Web Serial onboarding device | task | ready-for-agent | 02 |
| [05](issues/05-signed-c-image-package.md) Owner signs the C image's firmware package | task | ready-for-human | 03, 04 |
| [06](issues/06-production-path-rehearsal.md) Compose and rehearse the production path | task | ready-for-agent | 01, 04 |
| [07](issues/07-first-c-image-gate.md) First end-to-end Gate on the C image | task | ready-for-human | 05, 06 |
| [08](issues/08-interruptions-and-negatives.md) Interruptions and negatives on the C image | task | ready-for-human | 07 |
| [09](issues/09-core-mvp-evidence-map.md) Map C-image evidence onto the Core MVP | task | ready-for-agent | 08 |

## Decisions so far

None yet.
