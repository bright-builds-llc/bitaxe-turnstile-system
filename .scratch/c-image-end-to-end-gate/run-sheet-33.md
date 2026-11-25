# Run sheet: each job's admission on mainnet (Ticket 33)

The sitting for [Ticket 33](issues/33-job-admission-record.md). The owner plugs in the Gamma 601
and picks its port when Chrome asks. Agents run everything else, including the page's clicks, on the
owner's development authorization. Plan for about 20 minutes. Nothing is flashed.

## What runs

| Part | Value |
| --- | --- |
| Gate | turnstile `main` with Ticket 33's record, clean worktree |
| Board | the Gamma 601 on the owner's reference image of `247d2cd`, as in Ticket 32 |
| Pool | Hydra on mainnet through the owner's node, Bitcoin Core 31.1, now the pin |
| Browser | test Chrome with default settings, started through `open -na`, CDP on port 9334 |
| Work Requirement | `--expected-hashes 35184372088832` (2^45), as in Ticket 32 |

The private files are those in `~/.bitaxe-fork-private/t28/`, as in Ticket 32.

## Before starting

1. Check the node through the tunnel: `~/.bitaxe-fork-private/t07/tunnel_check.sh`. It prints
   the node's version, which must be 31.1.
2. Open the tunnel and keep it open, then start Hydra from
   `~/.bitaxe-fork-private/t07/hydra-cmdline.txt`. Don't restart Hydra until the join below has
   run. Each start overwrites `hydra-1.log`, and the join needs every admission of the sitting.
3. Check the 601 reports `247d2cd`, paused, with `mineOnBoot` 0.
4. Record the Gate commit, the image digests and Hydra's pins.
5. Start Chrome as in Ticket 32. Run no build, test or check in the Gate's checkout until the
   launcher stops.

## Steps, in order

1. **Launch the Gate** as in Ticket 32, with `--run-dir ~/.bitaxe-fork-private/t33/run`.
2. **`journey` on the 601.** Run the harness as in Ticket 32, with `--cases journey`. The owner
   picks the 601. Mining takes about 30 s, then restoration.
3. Capture the board's log (`/api/system/logs`, redacted), and grep the proxy log for `stale_job`.
4. Stop the launcher with Ctrl-C.
5. **Join the logs**, before Hydra stops:

   ```bash
   bun scripts/job-admission-evidence.ts \
     --adapter-log ~/.bitaxe-fork-private/t33/run/pool-adapter.log \
     --hydra-log ~/.bitaxe-fork-private/t07/hydra/hydra/hydra-1.log
   ```

   It prints counts and times only.

## Pass

- **The journey:** it passes as in Ticket 32, and the board restores with `ok=1`.
- **The join:**
  - it exits 0;
  - `relayed` is at least 1;
  - `unadmittedRelayed` is 0;
  - its relay times fall within the journey.

## Stop at once

- A board mines with no lease, or is still `active` after the journey.
- A restoration that isn't confirmed, or `ok=0`.
- The join reports an unadmitted relayed job. Keep both logs out of both repositories, and
  diagnose before any rerun.
- The same failure twice in a row.
- A private value in output, in a log kept with evidence, or in a commit.

## Afterwards

- **The board:** paused, with core voltage off.
- **Gate:** the launcher exited 0, the Tailscale serve is off, and the Gate container is gone.
- **Hydra and the tunnel:** stopped.
- **Records:**
  - the fork's `docs/project/gate-integration-evidence.md` gets "Ticket 33: each job's admission";
  - Ticket 33 is ticked with a dated comment;
  - criterion 5 in `spec.md` is updated.

## Non-claims

- **The join shows membership, not order.** Hydra logs an admission after it writes the job, so the
  two logs' times can't show which came first. That admission comes before release is the patch's
  property, shown by its tests and the regtest runner.
- **A credited share isn't joined.** The proxy credits only jobs it holds, which are only jobs it
  relayed; any other submit is refused unforwarded (`tests/stratum_v1_proxy/stale_work.rs`).
- **One board, one journey**, on one image.
