# First end-to-end Gate on the C image

Type: task
Status: ready-for-human
Blocked by: 06

## Objective

Run one complete Gate on a real board through Ticket 06's page and services,
with the owner at the board. The Gamma 601 goes first, flashed by hand with the C
reference image, as the board the owner's image was admitted on; the Ultra 205
follows. Onboarding is not part of this run (Ticket 15).

Follow [run-sheet-07.md](../run-sheet-07.md).

## Plan

- [x] Owner: choose the network for the run. Criterion 5 needs mainnet with
  per-job BIP 23 admission (Core Ticket 18).
- [x] Owner: choose the origin. A Tailscale origin on this Mac, approved
  2026-11-07.
- [x] Owner: generate the Gate's keys and launch the deployment with
  `scripts/launch-gate-deployment.sh`, which reads the Work Lease Authority and
  Gate Pass keys from the owner's files. Agents never see them.
- [x] Gate: consent shown, Start, renewals, shares through the adapter credited as
  Verified Progress, the Work Requirement reached, restoration confirmed as
  `challenge_satisfied`, the Gate Pass redeemed once with DPoP and refused on reuse.
- [x] Evidence: board, Gate and firmware commits, image and ELF digests, timings,
  non-claims, and nothing private, recorded in both repositories.
- [ ] The Ultra 205, after the 601.

## Answer

The 601 passed on mainnet on 2026-11-08 and 2026-11-09, with the owner's
reference image of `247d2cd` (`esp-miner.bin` SHA-256 `3ce1afa785b2c7c6`, ELF
`fcebd0f9835a68ba`), Hydra 0.12.0 at `8eca024` pinned at difficulty 4096, and
the owner's Bitcoin Core 31.1 node instead of the 28.1 pin. The firmware
repository's `docs/project/gate-integration-evidence.md`, "Ticket 07", has the
full record.

- Consent and Start, in every run.
- Renew: in the run of 2026-11-09 at 02:27 UTC, with the Gate at `d744e55` and
  the Work Requirement raised to 2^45 within the Standard bounds, the Authority
  issued two renewals before the requirement was met 40 s into the lease.
- Verified Progress from shares through the adapter reached the requirement:
  2^44 in 16 s on 2026-11-08 at 18:59, and 2^45 on 2026-11-09.
- Restoration confirmed as `challenge_satisfied`: the board logged
  `restoration_requested` and `Lease stop finished ok=1` after stops of 47,991
  and 47,862 ms, and the page went on to redeem.
- Redeemed once with DPoP each time. A resend of the identical redemption was
  refused with 401 `invalid_redemption` on 2026-11-08, with the count unchanged.

Both runs above had the page in a default-settings Chrome window minimized from
first work to after redemption (ADR-0110). The second also released the board's
port at redemption.

Non-claims: the 205 hasn't run. On hardware, reuse was tried only with the same
DPoP proof; a fresh proof on a spent pass is refused in
`restart_rejects_consumed_pass_and_converges_new_pass_on_one_redemption`. The
renewals rest on the lease sequence and the lease running on, since the board
doesn't log them. In the later runs the agent launched the deployment at the
owner's request; the keys stayed in the owner's files and the binaries'
environments.

## Comments

- 2026-11-06: the owner chose mainnet. Neither pinned Hydra nor job admission
  needs `-txindex`, and both work against a pruned node.
  - Hydra's source calls only `getblockchaininfo`, `getblocktemplate` (including
    the BIP 23 proposal), `getdifficulty`, `submitblock` and
    `decoderawtransaction`, and none reads the transaction index. Upstream's own
    signet and testnet4 node configs run `prune=1000` with `txindex` off.
  - On regtest, the upstream admission tests and the Hydra integration pass at
    `-prune=550` without txindex. They also pass after `pruneblockchain`
    deleted blocks 0 to 253. That one-off expected the halved regtest subsidy,
    because the chain was past height 600.
  - `scripts/hydra-mainnet-stack.sh` runs the node pruned, and refuses to start
    Hydra while the node is in initial block download. The run sheet gives the
    disk needs and sync time.
- 2026-11-06: the owner chose an existing synced mainnet node over a new pruned
  sync. It runs Bitcoin Core 31.1 with `txindex`, which is a deviation from the
  28.1 pin that the evidence must name.
  - `scripts/hydra-mainnet-stack.sh --external-node` downloads and starts no
    Bitcoin Core. It takes loopback RPC and ZMQ URLs (through the owner's SSH
    tunnel) and an owner-only credentials file outside the repository. It
    refuses to start Hydra unless the node reports chain `main` and has left
    initial block download.
  - Credentials reach curl on stdin and Hydra through its environment, never
    a command line, the config or a log.
  - `scripts/verify-hydra-solo-integration.sh --external-node` passes on
    regtest against a separately started node. The stack refused it six ways
    and left it running, and Hydra then passed the integration through the
    same path.
  - The pruned sync stays in the run sheet as the fallback.
- 2026-11-07: the launcher the run sheet assumed now exists, with the owner's
  approval and a Tailscale origin.
  - `scripts/gate-deployment-keys.ts` generates the Gate Pass signing key, the
    service credential and the Stratum credential key, mode 600, and prints only
    public values.
  - `scripts/launch-gate-deployment.sh` reads those keys and the existing Work
    Lease Authority from files at run time. It passes them only through each
    binary's environment, and checks the lease key against the owner trust.
  - It seeds the lease sequence above `lease-sequence.json` plus a margin, and
    fails closed if that file is unreadable. It records the run's high-water mark
    back at the end.
  - It binds the proxy to the LAN address and serves the filled page through
    `tailscale serve`. Its logs redact the address and the tailnet name.
  - `scripts/rehearse-gate-deployment-launch.sh` proves it on regtest with
    generated test keys. It doesn't use Tailscale or the board.
  - Hydra takes its payout from the pool user file
    (`--payout-from-pool-user`), so the address never goes on a command line.
  - The consent screen's policy links don't resolve yet; that is Ticket 19.
- 2026-11-07: the first real run stopped at the proxy. The board opens with
  `mining.configure` for version rolling, and the proxy refused any first frame
  but `mining.subscribe`. Its version-rolled six-parameter submits would also
  have been refused.
  - The proxy now forwards one `mining.configure` before subscribe and relays the
    reply. Nothing else is accepted before authorization. Submits apply the
    version bits under the granted mask, as Hydra does.
  - A proxy test replays the board's exact order, and the rehearsal's CPU miner
    now configures and rolls versions the same way.
  - "Worker admission rollback failed" came from the controller rejecting
    rollback with the same failure it had already closed on. The page now shows
    that one failure instead.
- 2026-11-07: the mainnet run stopped at the first new Bitcoin block.
  - Job admission makes Hydra close every Stratum connection on a new tip. The
    board reconnected and resubmitted its pre-tip result. The proxy ended the
    session on the unknown job, and after three tries the board gave up.
  - The proxy now answers a retired job's submit with error 21, "Job not found",
    and keeps the session. Past 96 jobs it retires the oldest instead of ending.
    Hydra sends a same-tip job about every 10 s without `clean_jobs`, so a tip
    over about 10.7 minutes would have hit the old bound of 64.
  - Hydra's vardiff had raised the board to about 19.1M, roughly a day per share
    at its rate, and an unbounded difficulty can overflow in a debug build.
    Mainnet Hydra now starts and stays at 4096, one share for the 2^44
    requirement. A share that large is credited in full; nothing caps it.
  - The rehearsal now mines a block mid-lease. Hydra's close on a new tip
    stopped the Work Session there, so the next share was refused as
    `work_lease_ended`.
  - On the owner's choice ("Option A"), Hydra now keeps the connection across a
    new tip. It still removes old-tip jobs and sends the new tip's job with
    `clean_jobs`. The rehearsal's lease survives the block.
  - The proxy now answers a job it dropped with "Stale job" and one it never
    sent with "Job not found", both error 21, and logs them as `stale_job` and
    `unknown_job`. The board's rejected-share list shows which one happened.
- 2026-11-08: the third mainnet run had every share rejected.
  - The regtest patch was applied to the mainnet build too. Hydra advertised its
    difficulty divided by 10^10 but enforced 4096. ESP-Miner ignores a difficulty
    below 0.0001, so the board stayed at 1 and Hydra refused every share. The
    same patch's fast vardiff likely drove run 1's 19.1M difficulty.
  - Mainnet Hydra now gets only the Job Admission and block-submission patches,
    and its difficulty is pinned at 4096. Every stack start checks Hydra's
    set_difficulty against the configured one and stops on a mismatch.
  - Regtest still needs the scaling: at 0.0001 every regtest share is a block.
    The rehearsal miner now ignores out-of-range difficulty like ESP-Miner, with
    its floor scaled by the same factor.
- 2026-11-08: the fourth mainnet run had every share rejected at difficulty 4096.
  - Job admission gave the coinbase its witness reserved value, which a block
    with a witness commitment needs, but the notify halves then carried the
    witness serialization. ESP-Miner hashes them as sent, so its merkle root
    differed from Hydra's and Hydra judged each share below 4096.
  - The notify halves are now non-witness. The proposed block and any found
    block add the reserved value back. A Hydra test covers each.
  - The rehearsal miner and the Hydra integration test now hash the coinbase as
    ESP-Miner does and stop on a witness-serialized one. Before the fix the
    rehearsal failed on exactly that.
  - The proxy now logs each refused submit with the pool's error code. Hydra
    sends errors as JSON-RPC objects, which ESP-Miner shows as "unknown".
- 2026-11-08: the fifth mainnet run issued the Gate Pass, but the page never
  redeemed it.
  - The restore already waits for the 152 s restoration bound, not 30 s. The
    board took about 47 s to stop and cool. Meanwhile the page still read
    "running", so the `pass_issued` restore and the 20 s renewal each sent a
    second serial command. The controller refused it locally and then ended its
    own session, which failed the first restore. The terminal state was never
    exposed.
  - Now the client sends one restoration for all terminal events and no other
    controller command after it starts. A failed confirmation still exposes the
    terminal state and reports the error; renewals have stopped, so the lease
    ends mining. The controller no longer ends its session over a command it
    refused locally.
  - The rehearsal's fake board now confirms restoration after 35 s, and the run
    checks that no command followed the restore.
- 2026-11-08: the sixth run lost its restore the same way. The board stopped
  cleanly for `restoration_requested`, but its USB session ended about 2.3 s
  into the stop, so the page never got the confirmation and the Gate Pass
  expired unredeemed.
  - The firmware repository's gate host sends the page's exact restore, with
    `challenge_satisfied`, and it passed on the 601. Three runs in a Chrome tab
    kept awake by the extension's debugger also passed and redeemed.
  - Chrome throttles a hidden tab's timers, to one a minute within minutes, so
    the owner's page stopped sending heartbeats during the 47 s stop, and the
    board's 2.8 s deadline ended the session.
  - ADR-0110 replaces ADR-0094's foreground clause: after a foreground Connect,
    the session lasts while the page is open. `web/page-clock.ts` runs the
    heartbeat, deadlines and the renew cadence on a Worker (`ddd6364`).
- 2026-11-08: a minimized run on `ddd6364`'s tree restored and redeemed. Its
  single share met 2^44 in 16 s, before the first Renew.
- 2026-11-09: the page now releases the port after redemption (`6eaa593`), the
  launcher removes its tailnet serve on exit (`70f31cc`), and
  `--expected-hashes` asks for a Work Requirement within the Standard bounds
  (`d744e55`). A minimized run at 2^45 renewed twice, restored and redeemed.
