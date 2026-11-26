# First end-to-end Gate on the C Reference Firmware image

Status: ready-for-agent

ADR-0105 made `bitaxe-esp-miner-c` the Reference Firmware. Its image reached
Gate parity on the Gamma 601, but every C-image lease so far was signed outside
the Gate Authority, mined against a pool named directly in the grant, and was
driven by the firmware's harness or by this repository's conformance pages. No
C image has completed a Gate through the production browser path. This effort
plans that first run: the `bwg-core/component` web component on the headless
SDK, direct Web Serial, Authority Start and Renew, the Stratum V1 Pool Adapter in
front of pinned Hydra, Verified Progress to the Work Requirement, Mining Baseline
restoration and Gate Pass redemption, on a 601 flashed by hand. The
settings-preserving signed-manifest onboarding is proven apart from it, on the
same board. It is a plan; hardware is used only to measure bounds in Tickets 03
and 04, and for the runs in Tickets 07, 08 and 15.

Rules carried from the firmware repository: only the owner signs, agents never
use the owner's private keys, and committed evidence names its board, commits,
image and ELF digests and non-claims, and holds no IPs, MACs, SSIDs,
credentials, pool users or endpoints. Security findings name topics only.

## Core MVP criteria against C-image evidence

Criteria are from `docs/design/core-mvp-success-criteria.md`, updated
2026-11-26 from Tickets 07, 08, 15, 27, 28, 32 and 33. "Partial" names what the C image
shows and what it doesn't. The hardware evidence is in the firmware repository's
[`docs/project/gate-integration-evidence.md`](https://github.com/bright-builds-llc/bitaxe-esp-miner-c/blob/b1a2f06/docs/project/gate-integration-evidence.md),
in the sections named for Tickets 07, 08, 15, 28, 32 and 33. Those runs used the
owner's reference images (`247d2cd`, and in Ticket 15 the signed `51e5af9` and
`57b0841` packages) on the Gamma 601 or the Ultra 205.

| # | Criterion | C-image evidence |
| --- | --- | --- |
| 1 | Relying Service creates the challenge | The Reference Relying Service's account-creation page created each challenge in Tickets 07, 08 and 28, on mainnet |
| 2 | Claimant selects the Bitaxe Reference Client | The Bitaxe choice: "Connect Bitaxe over USB" in every Ticket 07 run, on both boards. The standard Stratum V1 Worker choice isn't a firmware path and wasn't run here |
| 3 | Onboarding preserves settings, no account or app | Ticket 15, on the 601: the signed package installed from stock v2.15.4 and from `247d2cd`, a reference-to-reference update (`51e5af9` to `57b0841`), and every rollback, each with the settings categories (nonce-keyed HMACs) matching and no account or app. An unknown partition table was refused with nothing written, and a failed startup check was recovered by the bootloader and the page. One board, no Migration Backup, and the failed check's fault was staged |
| 4 | Work Consent disclosure | Consent was shown before every Start through the deployed page (Tickets 07, 08, 28, 32). The page names the connected board, from its signed capability, with that board's duration estimate, and refuses before consent if no configured Worker is that board. On hardware each consent named only the connected board: the Ultra 205 at 70.4 s and the Gamma 601 at 29.3 s, including in one tab each during the handover (Ticket 32). Tests pin the criterion's six fields in the client's disclosure and in the gate's terms, and the policy links resolve (Ticket 19) |
| 5 | Reward outputs and BIP 23 acceptance before release | On mainnet on the 601 (Ticket 33), each of the 6 jobs the Pool Adapter relayed to the board had an accepted Job Admission in Hydra's log, and none failed. Hydra's Job Admission patch checks the Reward Policy and gets the BIP 23 proposal accepted before it releases a job. The node was Bitcoin Core 31.1, now the pin. The logs show which jobs were admitted, not that admission came first; that rests on the patch's tests and the regtest runner. One board, one journey |
| 6 | Work through the Pool Adapter to pinned Hydra | The Pool Adapter's proxy in `gate-authority` to Hydra 0.12.0 at `8eca024`, patched only for Job Admission and block submission, on mainnet, on both boards (Ticket 07) |
| 7 | Accepted Work Events advance Verified Progress | Shares through the adapter took Verified Progress to the Work Requirement, 2^44 and 2^45, on both boards (Ticket 07). No double credit across an adapter restart is a Rust test (Ticket 27), not hardware |
| 8 | Work Requirement ends leases and confirms restoration | For one Worker: at the requirement the board stopped with `restoration_requested` and `Lease stop finished ok=1`, and restoration was confirmed as `challenge_satisfied`, on both boards (Ticket 07). Several Workers in one challenge weren't run |
| 9 | Gate Pass redeems with fresh DPoP | Redeemed once with DPoP in each mainnet run, on both boards (Ticket 07) |
| 10 | Action executes once, pass can't be reused | Partial: one redemption per pass. On the 601, resending the identical redemption was refused with 401 `invalid_redemption` and the count stayed the same (Ticket 07). A fresh proof on a spent pass is refused only in a Rust test, and a refresh wasn't tried |
| 11 | Failure cases fail safely | Partial. On hardware through the deployed page: Pause, terminal Cancel, expiry, tab close, a USB drop, a power pull and a pool failure on the 205 (Ticket 08); expiry on the 205, and withheld and expired-context grants on the 601 (Ticket 28) and on the 205 (Ticket 32). The handover with tab a on the 601 and tab b on the 205, in two profiles: each page refused the other tab's grant before `start_lease`, the bindings differed, and neither board logged a lease (Ticket 32). The board's own "contexts differ" refusal rests on `negative-cases.json` and the C host tests (`test_lease_auth.c`). Adapter replay is a Rust test (Ticket 27). No stale job came during a lease (Tickets 28, 32). Malformed payout and invalid proposal weren't run on the C image, by the owner's choice (2026-11-22) |
| 12 | Conformance Profiles pass in CI | Not a firmware criterion; no Client profile run against a real board |
| 13 | Privacy across context boundaries | Ticket 28's audit found none of eight board values in any Authority request, and only the control-session digest reached it from a board. In Ticket 32, on both boards, a mining journey each and the negatives: the audit searched every Authority request, and every Start and Renew grant, including the journeys' Renew grants and redemption, for the eight values and both boards' Device Identity fingerprints from the page's own store, and found none. The payout destination appeared only as the pool selection's `payout_destination`. The raw Device Identity key isn't searched, only its fingerprint. Rust tests show the Authority refuses an account identifier, action payload or payout destination in challenge issuance, and that after redemption the account ID sits in no Authority or Pool Adapter row |

## Gaps found while planning

- No Authority HTTP route returned a `WorkerLeaseGrant` on Start or Resume, or
  served Renew. Ticket 01 added the claimant Work Session routes (ADR-0106).
  Ticket 10 added claimant Pool Selection (ADR-0107) and Stratum session
  renewal. Ticket 11 stopped late or unordered delivery from ending a lease, and
  Ticket 12 made uncreditable work a terminal refusal (ADR-0108).
- Onboarding has only a simulated `BitaxeOnboardingDevice`. The C image reports
  no settings-schema version, settings readability or A/B rollback facts, and its
  build leaves app rollback off. Ticket 02 settled the contract: the browser writes
  through the ROM bootloader, and the C image reports and proves over Worker
  Serial. Upstream's table needs the new scheme `esp32-factory-ota-ab`, and
  settings digests become nonce-keyed HMACs. Tickets 14, 03 and 04.
- The C image has no signed firmware package manifest. Ticket 05.

## Tickets

Dependency order: 01, 02, 06, 10, 11 and 12 are resolved. 07, 13 and 14 start now.
The Gate path is 06, then 07, then 08. The onboarding path is 14, then 03, 04, 05
and 15. 09 follows 08 and 15.
See [map.md](map.md).
