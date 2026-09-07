# Bound native serial receive progress

Accepted 2026-09-05 during fixed-USB qualification. Supersedes ADR 0094's
serial 0.1 wire contract. Fixed Serial/JTAG, direct Web Serial, Controller 0.4,
possession 0.2, signing roles and the four-cycle requirement remain.

## Evidence

An exact-source no-mining probe sent 65,376 padding bytes while firmware
reported 63,584 received bytes. Its response padding was complete. The explicit
request-count check rejected the exchange. This establishes input loss, without
claiming a measured hardware overflow counter or uninstrumented timing.

The pinned ESP-IDF 5.5.4 Serial/JTAG ISR discards a failed enqueue into its
4,096-byte receive ring. Browser write completion may mean only OS queuing.
Smaller unacknowledged writes, sleeps and larger buffers cannot establish
device consumption. Every small firmware frame also caused an unnecessary
full-capacity 66,560-byte wipe before reception resumed.

## Decision

Publish serial 0.2 with cumulative receive acknowledgements and exact payload
integrity. The signed Serial Application Manifest fixes a 2,048-byte
host-to-device outstanding window, 1,024-byte maximum native write chunk, and
a 2,000-ms whole-record write deadline. Keep 65,536-byte control payloads and
66,560-byte complete wire records. No USB-controller handoff or helper is added.

Hello is bounded and uncredited. Both byte counters begin at zero after its
delimiter and validated acknowledgement, before possession. Subsequent raw
bytes, including partial records and heartbeats, consume credit. Firmware
acknowledges bytes actually drained, independently of command processing.
Credits are session-bound, sequenced and coalesced by the sole writer. They
grant neither possession nor Work authority and refresh no heartbeat or lease.

All envelopes carry the exact lexical UTF-8 payload length and SHA-256 digest.
Validate them before controller dispatch, heartbeat admission or credit
application. Do not parse and reserialize a payload to check its digest. The
digest detects corruption; existing possession and signed Work Leases retain
their authorization roles.

Count bytes before submitting a native write, since receive acknowledgement
can precede write-promise settlement. Never refund a failed write. Close on
backward, excess or overflowing credit. Await final record consumption before
resolving its send. Assign envelope sequences at actual writer dequeue so
heartbeat priority cannot reorder already-assigned counters.

The whole-record deadline includes credit waits. Send a fresh authenticated
heartbeat before a potentially long control record. Cancellation aborts an
unfinished record; it cannot inject Restore or Close into partial JSON, await
credit forever, or resume after a late acknowledgement. Device-local
revocation and fresh-session recovery remain mandatory.

A validated complete Close revokes Work authority immediately and may receive
one final bounded consumption credit while no newer Hello exists. The canonical
contract separately bounds old-credit and partial-output bootstrap recovery;
neither admits authority or extends an admission deadline.

Reuse bounded firmware receive storage and wipe its initialized prefix before
reuse. Avoid secret-bearing reallocations and large stack temporaries. Keep
the existing driver buffers, internal memory reserve and safety deadlines.

## Qualification

Require a deterministic bounded-receiver test that reproduces the observed
loss, then proves outstanding-byte bounds, exact delivery after resumed
draining, corruption rejection before dispatch, and cancellation without
post-revocation writes. Cover lexical JSON variants, stale credits, counter
exhaustion, lost acknowledgements and blocked commands. Preserve failed
attempts and previous-version evidence; do not relabel their cycles for 0.2.

Publish coordinated Gate and firmware identities, requalify four no-mining
cycles, then use the original device campaign and unchanged 240-second ceiling.
