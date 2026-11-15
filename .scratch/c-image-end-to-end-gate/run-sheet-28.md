# Run sheet: negatives on both boards (Ticket 28)

The sitting for [Ticket 28](issues/28-negatives-on-both-boards.md). The owner
plugs in both boards and picks a port each time Chrome asks. Agents run
everything else, including the page's clicks, on the owner's development
authorization. Plan for about 45 minutes. Nothing is flashed.

## What runs

| Part | Value |
| --- | --- |
| Gate | turnstile `main` at `f1c05ae` or later, clean worktree |
| Boards | the Gamma 601 and the Ultra 205, both on the owner's reference image of `247d2cd` (`esp-miner.bin` `3ce1afa785b2c7c6…`, ELF `fcebd0f9835a68ba…`) |
| Pool | Hydra on mainnet through the owner's node (Bitcoin Core 31.1, a deviation from the 28.1 pin), as in Ticket 07 |
| Browser | test Chrome with default settings, CDP on port 9334 |
| Work Requirement | `--expected-hashes 35184372088832` (2^45), as in Ticket 08 |

Private files, all mode 600 under `~/.bitaxe-fork-private/t28/`:
- `board-values.txt`, the values the audit searches for. It holds 8: the firmware
  commit, the image, ELF and partition-table digests, both boards' base-MAC
  digests, and each board's capability signature.
- `payout-address.txt`, the address part of the owner's pool user, which the
  owner confirmed on 2026-11-14.

## Before starting

1. Check the node through the tunnel: `~/.bitaxe-fork-private/t07/tunnel_check.sh`
   passed on 2026-11-14.
2. Open the tunnel and keep it open, then start Hydra from
   `~/.bitaxe-fork-private/t07/hydra-cmdline.txt`.
3. Record the Gate commit, the image digests and Hydra's pins.
4. Plug in both boards. Each must report paused with `mineOnBoot` 0 before any
   run starts.

## Steps, in order

1. **`discardedReplies` on the 205 (no lease).** Start
   `tools/bwg_gate/acceptance_supervisor.ts` from the fork, with:
   - the owner trust and the reference image's commit and ELF;
   - `--authority` pointing at a folder that doesn't exist, so nothing can sign.

   It was dry-run on 2026-11-14 and reached `configured`. Then:
   - The owner clicks Connect and picks the 205.
   - An agent calls `interruptPendingStatusForQualification()`, reconnects, and
     records `helloRecovery`.
   - Repeat 5 times.
   - A 0 is recorded with the firmware's reason (`bwg_writer.c`, `select_control`).

2. **Launch the Gate:**

   ```bash
   scripts/launch-gate-deployment.sh --keys-dir ~/.bitaxe-fork-private/t07 \
     --lease-authority-dir ~/.local/share/bitaxe-worker-acceptance-20260904 \
     --owner-trust ~/.bitaxe-fork-private/owner-trust/trust.json \
     --image-dir ~/.bitaxe-fork-private/reference/image \
     --run-dir ~/.bitaxe-fork-private/t28/run --expected-hashes 35184372088832
   ```

3. **Expiry releases the port (Ticket 26), on the 205, left running in the
   background.**
   - Run one normal challenge: Connect, consent, Start.
   - Pause after first work, then leave it paused.
   - After 15 min the challenge expires. Pass: restoration confirmed, then the
     port closed, and no Gate Pass.

4. **`withheld` and `expired_context` on the 601**, while step 3 waits:

   ```bash
   bun scripts/gate-negatives-harness.ts --browser http://127.0.0.1:9334 \
     --origin <printed origin> --payout-address-file ~/.bitaxe-fork-private/t28/payout-address.txt \
     --board-values-file ~/.bitaxe-fork-private/t28/board-values.txt --cases withheld,expired_context
   ```

   The board's restore takes about 47 s, inside the harness's 120 s rollback limit.

5. **`handed_over` on both boards**, after step 3 has ended:
   - Tab a is the 601 and tab b the 205.
   - Use `--cases handed_over` with the same options.

6. **After each case:**
   - Capture each board's log (`/api/system/logs`, redacted).
   - Capture the Authority's rows for the challenge.
   - Grep the proxy log for `stale_job`.

7. Stop the launcher with Ctrl-C. It records the lease high-water mark.

## Pass

- **`withheld`:** the board never receives `start_lease`, and the Authority
  ends the attempt `cancelled`.
- **`expired_context`:** the board refuses `start_lease` with
  `admission_required`, and the page fails closed and drops the port.
- **`handed_over`:** each page refuses the other tab's grant before
  `start_lease`, and the two bindings differ.
- **Every case:**
  - Verified Progress 0, and no Gate Pass request.
  - The board ends paused with `ok=1` and never mines.
  - The audit finds no violation, and the harness prints `negatives: passed`.
- **Port releases:** a confirmed Cancel (every case) and the step 3 expiry each
  close the port.

## Stop at once

- A board mines with no lease, or is still `active` after a case.
- A restoration that isn't confirmed, or `ok=0`.
- The same failure twice in a row.
- A private value in output, a log kept with evidence, or a commit.

On a stop:
- press the page's Cancel;
- unplug a board that keeps mining;
- keep the logs out of both repositories.

## Afterwards

- **Boards:** both paused, with core voltage off.
- **Gate:** the launcher exited 0, the Tailscale serve is off, and the Gate
  container is gone.
- **Hydra and the tunnel:** stopped, unless another run follows.
- **Records:** the fork's `docs/project/gate-integration-evidence.md` gets
  "Ticket 28 on both boards", and Ticket 28 is ticked with a dated comment.

## Non-claims

- **The boards' Device Identity keys aren't in `board-values.txt`.** Nothing on
  disk records them, and capturing one needs a Hello that the page performs
  inside the browser. The audit's field rules still allow only the binding
  digest as a board-derived field.
- **The 205's consent screen names "Bitaxe 601".** The page's disclosure lists
  one worker, and adding the 205 would double the combined hashrate in its
  duration estimate. The negatives never mine, so the estimate doesn't matter
  here.
- **A handed-over grant is refused by the page, not by the board.** The board's
  "contexts differ" refusal stays proven by `negative-cases.json` and the C host
  tests.
- **One run each**, on one image.
- **A stale job is claimed only if the proxy logs one.** The negatives never
  mine, so only step 3's few minutes of mining can show one.
