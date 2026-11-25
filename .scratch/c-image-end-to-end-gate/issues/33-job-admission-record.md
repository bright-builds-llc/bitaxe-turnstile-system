# Each job's admission, recorded against the jobs a board received

Type: task
Status: in-progress
Blocked by: None

## Objective

Criterion 5 is Partial for two reasons. First, the mainnet runs mined only jobs that Hydra's Job
Admission patch released, but no run records that each job a board received had an accepted
admission. Second, the node was Bitcoin Core 31.1, not the 28.1 pin. The owner chose (2026-11-24)
to repin to 31.1 and to close the criterion with one mainnet journey on the Gamma 601.

## Plan

- [x] The Pool Adapter logs `Stratum job relayed` with each job's ID and `clean_jobs`
  (`StratumProxyAction::RelayJob`). Hydra already logs `Job admission completed` or `failed` per
  job.
- [x] `scripts/job-admission-evidence.ts` joins the two logs. Hydra's decimal IDs are matched to the
  adapter's hex ones as `BigInt`, since they exceed 2^53. It prints counts and times only. It fails
  unless a job was relayed and every relayed job was admitted.
- [x] `scripts/rehearse-production-path.sh` runs the join after its journey, on regtest Hydra with
  admission on.
- [x] The pin moves to the official Bitcoin Core 31.1:
  - `SHA256SUMS` carries 11 good builder signatures;
  - the archive matches it;
  - the regtest runner and the rehearsal pass on it.
- [ ] [Run sheet 33](../run-sheet-33.md) on the 601, on mainnet: the journey passes, and so does
  the join.
- [ ] The fork's evidence gets a Ticket 33 section, and criterion 5 in `spec.md` is updated.

## Comments

- 2026-11-24, before the sitting, on macOS arm64:
  - **Runner on 31.1:** `scripts/verify-hydra-solo-integration.sh` passed. Its summary gives:
    - `bitcoin_core_version=31.1`;
    - `bip23_success_result=json_null`;
    - 10 admissions;
    - 2 blocks, each `core_result=accepted`.
    Its block observer timed out as in every 28.1 run.
  - **Join in the rehearsal:**
    - `rehearse-production-path.sh`, on 28.1 and again on 31.1: 4 relayed, 4 admitted, across a
      new tip.
    - `--negatives` on 31.1: 3 relayed, 3 admitted.
    - Neither run had an unadmitted relayed job.
  - **Mutation check:** with the relay log line removed, the rehearsal failed with `relayed` 0.
