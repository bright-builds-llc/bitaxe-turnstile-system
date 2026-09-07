# Worker serial transport 0.2

This is the active fixed ESP32-S3 Serial/JTAG profile, under ADR 0096. It
replaces serial 0.1 without an active compatibility fallback. Controller 0.4,
possession 0.2 and their role-separated authorization contracts remain.

## Wire records and integrity

Records are UTF-8 JSON objects followed by one LF. Their exact fields are
`profile`, `kind`, `sessionId`, `sequence`, `payloadBytes`, `payloadSha256`,
and `payload`. Profile is `bwg-worker-serial/0.2`; kinds remain `session`,
`control`, `heartbeat`, and `diagnostic`. Existing session-token, u32 sequence,
payload-object, duplicate-key and extra-field rejection rules remain.

The complete record, including LF, is at most 66,560 bytes. A control payload
is at most 65,536 bytes. `payloadBytes` is the exact UTF-8 byte length of the
payload JSON value, excluding whitespace outside that value. `payloadSha256`
is its canonical unpadded base64url SHA-256 digest. Whitespace, key order and
escapes inside the value are hashed exactly as transmitted. Receivers must
retain the raw payload span; JSON parsing followed by serialization is not an
integrity check. Verify integrity before processing any record, including
heartbeats and receive acknowledgements. Never log hashes or payload contents.

## Signed manifest

Retain the existing manifest fields and values, changing its profile to 0.2
and adding these exact fields:

| Field | Value |
| --- | --- |
| `hostToDeviceReceiveWindowBytes` | `2048` |
| `maximumHostWriteChunkBytes` | `1024` |
| `recordWriteTimeoutMilliseconds` | `2000` |
| `payloadIntegrity` | `sha256_exact_utf8_json` |

The complete manifest is signed through the existing capability and bound into
fresh possession with exact firmware and logical-session identity. Hello
cannot enlarge the manifest's window or change integrity semantics.

## Bootstrap and receive credit

The existing `session`/`hello` record is uncredited and must itself fit 2,048
bytes. The host sends no subsequent bytes before validating `hello_ack`.
The acknowledgement retains its existing fields and adds
`receiveWindowBytes: 2048` and `receivedBytes: 0`. This admits transport only;
possession and Work authorization remain separate.

Both cumulative byte counters start at zero immediately after the Hello LF.
Do not attribute a whole read batch to one epoch if it crosses that boundary.
Every later raw host byte, including delimiters, partial records and
heartbeats, counts against the window.

Firmware sends a sequenced, integrity-protected `session` record with exactly
this payload shape whenever receive progress advances:

```json
{"op":"receive_credit","receivedBytes":1024}
```

`receivedBytes` is the cumulative u32 count actually drained from the native
receive driver in that session. Coalescing intermediate counts is allowed;
withholding progress until a complete record or a full window is not. Credit
production and the sole output writer must run independently of blocking
Start, Renew, Restore, logging and NVS work. Preserve heartbeat priority, then
credit priority ahead of control replies and diagnostics. Discard old-epoch
credit on closure.

The host reserves/debits bytes before calling native `writer.write`, then
writes at most 1,024 bytes and never exceeds 2,048 reserved but unacknowledged
bytes. Acknowledgements may arrive before native write promises settle. Require
strictly advancing credits no greater than bytes reserved for send. Reconnect
before u32 exhaustion; never wrap or refund failed writes. A record's send
resolves only after acknowledgement of its complete cumulative byte count.

Device-to-host records retain native TX backpressure and gain the same payload
integrity validation. Receive-credit records do not themselves require credit
and never refresh heartbeat clocks, possession freshness or Work Leases.

A complete validated Close revokes Work authority immediately. Its closing
transport epoch may emit one bounded final consumption credit, within 2000 ms,
only while no newer Hello has begun. This receipt permits the host's final send
to settle; all other retired-epoch credits, controls and heartbeats are discarded.
Native output admission is rechecked at bounded nonblocking write attempts and
flush polls. Bytes already admitted to native TX cannot be retracted.

Before the matching fresh Hello acknowledgement, the host may discard at most
32 integrity-valid, well-formed old receive-credit records without applying
their counters or resetting any deadline. To resynchronize after an interrupted
old output record, it may discard one leading malformed UTF-8/JSON protocol
line, at most 66560 bytes and terminated by LF. Valid JSON with wrong profile,
fields or integrity still fails. These bootstrap exceptions end immediately
after Hello validation; ordinary active-session parsing remains strict.

## Deadlines, ordering and cancellation

One 2,000-ms write deadline covers a complete record, all native chunks, credit
waits and its final consumption acknowledgement. Do not restart it per chunk.
After heartbeat admission, send a fresh heartbeat before a potentially long
indivisible control record. Retain one-second heartbeats, the 2.8-second device
deadline and the three-second gate-closure/shutdown-initiation requirement.

Assign output sequences only when a record is selected for transmission.
Priority must never transmit a higher assigned sequence before a queued lower
one. Maintain one output owner and never interleave bytes from two records.

Cancellation stops future bytes and heartbeats for an unfinished record. It
must release credit waiters and cannot append Restore or Close inside partial
JSON, finish a cancelled command, or restart from a late credit. Use independent
device-local revocation and fresh-session restoration evidence in that case.
No automatic command replay or reconnect is permitted.

## Required verification

Exercise the production channel against a 4,096-byte, 64-byte-packet bounded
receiver with deliberately paused draining. Reproduce the uncredited loss;
prove bounded outstanding data and exact delivery when draining resumes.
Verify removed/duplicated bytes, lexical JSON variants, wrong digests/lengths,
old or excessive credits, overflow, lost acknowledgements, partial-record
cancellation, large records near heartbeat boundaries and blocked command
owners. No corrupt record may reach controller dispatch and no revoked send
may emit additional bytes. Diagnostics expose closed categories and bounded
counts only. Real-device timing and four-cycle qualification remain separate.
