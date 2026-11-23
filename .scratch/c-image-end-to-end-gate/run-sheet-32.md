# Run sheet: privacy, consent and handover on both boards (Ticket 32)

The sitting for [Ticket 32](issues/32-privacy-consent-handover-on-both-boards.md). The owner plugs
in both boards and picks a port each time Chrome asks. Agents run everything else, including the
page's clicks, on the owner's development authorization. Plan for about 60 minutes. Nothing is
flashed.

## What runs

| Part | Value |
| --- | --- |
| Gate | turnstile `main` with Ticket 32's harness, clean worktree |
| Boards | the Gamma 601 and the Ultra 205, both on the owner's reference image of `247d2cd`, as in Ticket 28 |
| Pool | Hydra on mainnet through the owner's node (Bitcoin Core 31.1, a deviation from the 28.1 pin), as in Ticket 07 |
| Browser | test Chrome with default settings, started through `open -na`, CDP on port 9334 |
| Work Requirement | `--expected-hashes 35184372088832` (2^45), as in Tickets 08 and 28 |

Private files, all mode 600 under `~/.bitaxe-fork-private/t28/`, reused because the image hasn't
changed:
- `board-values.txt`: the 8 values the audit searches for. They are the firmware commit; the
  image, ELF and partition-table digests; both boards' base-MAC digests; and each board's
  capability signature.
- `payout-address.txt`: the address part of the owner's pool user.

The harness adds each tab's Device Identity fingerprint, read from the page's own store once its
board is admitted. It searches every request, and every Start or Renew grant, for all of these. The
payout address may appear only as the pool selection's `payout_destination`, and never in a grant
sent to a board. Each case also records the Workers and duration the consent names.

## Before starting

1. Check the node through the tunnel: `~/.bitaxe-fork-private/t07/tunnel_check.sh`.
2. Open the tunnel and keep it open, then start Hydra from
   `~/.bitaxe-fork-private/t07/hydra-cmdline.txt`.
3. Check `board-values.txt` still has 8 lines, and that both boards report `247d2cd`.
4. Record the Gate commit, the image digests and Hydra's pins.
5. Plug in both boards. Each must report paused with `mineOnBoot` 0 before any run starts.
6. Start Chrome:

   ```bash
   open -na "Google Chrome" --args --remote-debugging-port=9334 --user-data-dir=<test profile>
   ```

   Started from a shell, Chrome aborts on the serial chooser.

## Steps, in order

1. **Launch the Gate**, as in Ticket 28:

   ```bash
   scripts/launch-gate-deployment.sh --keys-dir ~/.bitaxe-fork-private/t07 \
     --lease-authority-dir ~/.local/share/bitaxe-worker-acceptance-20260904 \
     --owner-trust ~/.bitaxe-fork-private/owner-trust/trust.json \
     --image-dir ~/.bitaxe-fork-private/reference/image \
     --run-dir ~/.bitaxe-fork-private/t32/run --expected-hashes 35184372088832
   ```

   Every step below runs the harness with these options, changing only `--cases`:

   ```bash
   bun scripts/gate-negatives-harness.ts --browser http://127.0.0.1:9334 \
     --origin <printed origin> --payout-address-file ~/.bitaxe-fork-private/t28/payout-address.txt \
     --board-values-file ~/.bitaxe-fork-private/t28/board-values.txt --cases <cases>
   ```

2. **`journey` on the 205.** The owner picks the 205. It takes about 2 minutes to reach the
   requirement at about 440 GH/s, then about 47 s to restore. This is criterion 4's check: the
   consent names the Ultra 205 alone.
3. **`journey` on the 601.** The owner picks the 601. The consent names the Gamma 601 alone.
4. **`withheld,expired_context` on the 205**, its first run of these cases.
5. **`handed_over`.** Tab a is the 601, in the test profile. Tab b is the 205, in its own profile,
   so its chooser asks every run. Before each click the harness brings that tab's window to the
   front, so the owner can see its chooser.
6. **After each step:**
   - Capture each board's log (`/api/system/logs`, redacted).
   - Capture the Authority's rows for the challenge.
   - Grep the proxy log for `stale_job`.
   - For a journey, the board's log must show:
     - the lease started;
     - `Lease stop finished ok=1`;
     - restoration as `challenge_satisfied`.
7. Stop the launcher with Ctrl-C. It records the lease high-water mark.

## Pass

- **`journey`:**
  - every grant passed through;
  - the Authority reached `satisfied` then `pass_issued`;
  - at least one Renew grant was searched;
  - the redemption was answered 200 once;
  - the board restored with `ok=1`.
- **`withheld`:** the board never receives `start_lease`, and the Authority ends the attempt
  `cancelled`.
- **`expired_context`:** the board refuses `start_lease` with `admission_required`, and the page
  fails closed and drops the port.
- **`handed_over`:** each page refuses the other tab's grant before `start_lease`, and the two
  bindings differ.
- **Every negative:**
  - Verified Progress 0, and no Gate Pass request;
  - the board ends paused with `ok=1` and never mines.
- **Every case:**
  - the consent names only the connected board, with that board's duration estimate;
  - each tab's fingerprint was searched;
  - the audit finds no violation, and the harness prints `negatives: passed`.

## Stop at once

- A board mines with no lease, or is still `active` after a case.
- A restoration that isn't confirmed, or `ok=0`.
- A consent naming the wrong board, or both boards.
- The same failure twice in a row.
- A private value in output, in a log kept with evidence, or in a commit.

On a stop:
- press the page's Cancel;
- unplug a board that keeps mining;
- keep the logs out of both repositories.

## Afterwards

- **Boards:** both paused, with core voltage off.
- **Gate:** the launcher exited 0, the Tailscale serve is off, and the Gate container is gone.
- **Hydra and the tunnel:** stopped.
- **Records:**
  - the fork's `docs/project/gate-integration-evidence.md` gets "Ticket 32 on both boards";
  - Ticket 32 is ticked with a dated comment, and Ticket 29's last item points to it;
  - criteria 4, 11 and 13 in `spec.md` are updated.

## Non-claims

- **The Device Identity is searched as its fingerprint, not its raw key.** The page keeps only the
  fingerprint, a SHA-256 of the key, so a request carrying the raw key alone would pass the search.
  The audit's field rules still allow only the binding digest as a board-derived field.
- **A handed-over grant is refused by the page, not by the board.** The board's "contexts differ"
  refusal stays proven by `negative-cases.json` and the C host tests.
- **Criterion 11's malformed payout and invalid proposal aren't run**, by the owner's choice.
- **The node is Bitcoin Core 31.1**, not the 28.1 pin.
- **One run each**, on one image.
- **A stale job is claimed only if the proxy logs one.**
