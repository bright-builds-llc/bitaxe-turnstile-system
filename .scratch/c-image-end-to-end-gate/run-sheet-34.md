# Run sheet: a spent Gate Pass on mainnet (Ticket 34)

The sitting for [Ticket 34](issues/34-spent-pass.md). The owner plugs in the Gamma 601 and picks its
port when Chrome asks. Agents run everything else, including the page's clicks, on the owner's
development authorization. Plan for about 20 minutes. Nothing is flashed.

## What runs

| Part | Value |
| --- | --- |
| Gate | turnstile `main` with Ticket 34's retry, clean worktree |
| Board | the Gamma 601 on the owner's reference image of `247d2cd`, as in Ticket 33 |
| Pool | Hydra on mainnet through the owner's node, Bitcoin Core 31.1, the pin |
| Browser | test Chrome with a fresh default-settings profile, started through `open -na`, CDP on port 9334 |
| Work Requirement | `--expected-hashes 35184372088832` (2^45) |

The private files are those in `~/.bitaxe-fork-private/t28/`, as in Tickets 32 and 33.

## Before starting

1. Check the node through the tunnel with `~/.bitaxe-fork-private/t07/tunnel_check.sh`. It must
   report 31.1.
2. Open the tunnel and keep it open, then start Hydra from
   `~/.bitaxe-fork-private/t07/hydra-cmdline.txt`.
3. Check the 601 reports `247d2cd`, paused, with `mineOnBoot` 0.
4. Record the Gate commit, the image digests and Hydra's pins.
5. Start Chrome as in Ticket 33. Run no build, test or check in the Gate's checkout until the
   launcher stops. The harness bundles its retry script in memory and writes nothing.

## Steps, in order

1. **Launch the Gate** as in Ticket 33, with `--run-dir ~/.bitaxe-fork-private/t34/run`.
2. **`journey` on the 601.** Run the harness as in Ticket 33, with `--cases journey`. The owner
   picks the 601 and leaves the window where it is while the chooser is open. Once the page
   redeems, the harness retries the spent pass at once, while it's unexpired.
3. Capture the board's log (`/api/system/logs`, redacted), and grep the proxy log for `stale_job`.
4. Count in `~/.bitaxe-fork-private/t34/run/reference-service.log`:
   - `Protected Action succeeded`, which must be exactly 1;
   - `Gate Pass was already consumed`, which must be at least 1.
5. Stop the launcher with Ctrl-C, then stop Hydra and close the tunnel.

## Pass

- **The journey** passes as in Ticket 33, and the board restores with `ok=1`.
- **The spent pass:**
  - the harness's evidence shows `refresh` as `identical` or `refused`;
  - the retry got `replayStatus` 401 with `invalid_redemption`;
  - the page's own redemption was answered 200.
- **The service's log** holds one execution and a refusal as already consumed.

## Stop at once

- A board mines with no lease, or is still `active` after the journey.
- A restoration that isn't confirmed, or `ok=0`.
- The action runs twice, or the retry is answered 200.
- The same failure twice in a row.
- A private value in output, in a log kept with evidence, or in a commit.

## Afterwards

- **The board:** paused, with core voltage off.
- **Gate:** the launcher exited 0, the Tailscale serve is off, and the Gate container is gone.
- **Hydra and the tunnel:** stopped.
- **Records:**
  - the fork's `docs/project/gate-integration-evidence.md` gets "Ticket 34: a spent Gate Pass";
  - Ticket 34 is ticked with a dated comment;
  - criterion 10 in `spec.md` is updated.

## Non-claims

- **The retry is the claimant's own.** It comes from the same page, with the same key. A pass
  stolen to another device is stopped by its key binding, which the Rust tests show, not this run.
- **The pass is retried before it expires.** A retry after expiry is refused for the expiry, which
  the Rust tests show.
- **Execution after a service restart** stays the Rust test's
  (`restart_rejects_consumed_pass_and_converges_new_pass_on_one_redemption`).
- **One board, one journey**, on one image.
