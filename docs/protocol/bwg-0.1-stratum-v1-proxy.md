# BWG/0.1 Stratum V1 Pool Adapter Proxy

The reference Pool Adapter is an MIT Rust TCP proxy between an unmodified standard Stratum V1 Worker and one upstream Mining Pool connection. It forwards `mining.subscribe`, `mining.authorize`, `mining.set_difficulty`, `mining.notify`, `mining.submit`, and their JSON-RPC responses without adding Work Challenge or Protected Action fields to Stratum.

## Work Session admission

The Pool Adapter issues one deterministic opaque username and 256-bit secret for an exact `(Work Session ID, expiry)` under an operator key. Repeating one generation returns the same credentials after response loss, while another Work Session receives different values. Credentials may not extend beyond 60 seconds, the Work Lease wall-clock expiry, the Work Challenge expiry, or the remaining monotonic Work Lease duration. A later generation atomically rotates the verifier for the same Work Session, and an older generation cannot roll it back. PostgreSQL stores only a domain-separated secret verifier, the opaque session mapping, issuance/expiry times, and exact Authority-issued Work Lease context; it never stores the Worker secret.

`mining.authorize` is checked locally before it reaches the upstream connection. Invalid credentials receive a standard `result:false` response, expired credentials terminate processing, and every later `mining.submit` must name the authorized username. Each accepted upstream subscription is assigned a connection ID, and its case-canonical `extranonce1` is durably reserved before the successful subscription response is exposed to the Worker. Authorization then binds that reservation to the authenticated Work Session. Every pre-bind exit removes the reservation; if admission and cleanup both fail, the adapter reports both errors for recovery instead of hiding the leak. A reconnect may receive a fresh `extranonce1`, but no two connection records can claim the same coinbase space.

## Target and job state

`mining.set_difficulty` is parsed as a positive canonical JSON decimal with at most nine fractional digits. The proxy calculates the 256-bit target through checked decimal-rational multiplication and division without floating-point accounting. Each `mining.notify` snapshots the then-effective target into its job, so a later difficulty update cannot change an older job’s Accepted Work Event.

A clean `mining.notify` invalidates every older job before another submit can be forwarded. Rejected upstream responses pass directly back to the Worker and create no event. Event identity is stable for one session/request replay. Share Fingerprint is derived from the reconstructed 80-byte Bitcoin block header, so the same candidate is globally deduplicable while otherwise identical submissions with distinct `extranonce1` values remain distinct shares. The header hash is also checked against the compact network target captured in the job.

## Persistence and delivery

An upstream `result:true` is not released to the Worker immediately. The transcript module first emits `PersistAccepted` with the exact target-qualified event, upstream response, and the Work Lease observation captured when the submit was forwarded. The TCP adapter commits them to the context-local `pool_adapter.accepted_work_outbox`; only `accepted_persisted` releases the unchanged response to the Worker. Replaying a response after connection loss returns the first durable event, lease observation, and response instead of changing their receipt time or monotonic reading.

Delivery workers lease pending outbox events and resend the exact event until the Gate Authority acknowledges it. A process crash or unavailable Authority leaves the event recoverable after lease expiry, while Authority-side event/share deduplication returns stable acknowledgements without double credit. The Pool Adapter marks delivery acknowledged only after the Authority call succeeds.

Worker submissions always reach the upstream Mining Pool before header reconstruction, network-target classification, outbox persistence, or Gate Authority delivery begins. If local observer state is malformed or outbox persistence fails afterward, the Worker receives no false acceptance, but a potential block candidate has already continued on the Mining Pool path.

Frames are capped at 16 KiB before allocation, idle connections time out, and each session retains at most 64 outstanding request IDs and 64 jobs. Duplicate in-flight JSON-RPC IDs fail closed instead of overwriting request state.

The context-local retention seam rejects periods below the hosted 30-day operational floor, oversized batches, and snapshot cutoffs later than its trusted current time. Once that floor has elapsed, one bounded transaction removes expired verifier/session rows, their connection reservations, abandoned unbound reservations, and acknowledged outbox events; pending delivery rows are never retired. Repeating the same retirement is idempotent and releases historical `extranonce1` space for safe reuse.

## Conformance

The checked-in [`stratum-v1-proxy-transcript.json`](../../conformance/bwg-0.1/stratum-v1-proxy-transcript.json) drives the Rust transcript test. PostgreSQL and real TCP acceptance additionally cover:

- deterministic credentials and expiry;
- generation-bound credential rotation and monotonic lease advancement;
- unique connection-scoped extranonce reservation across restart;
- integer and fractional variable difficulty;
- reconstructed-header fingerprinting and network-target classification;
- stale, rejected, duplicate, reconnect, and cross-session submissions;
- persistence-before-acknowledgement;
- outbox lease recovery and at-least-once Authority delivery;
- the existing Gate Authority Verified Progress transaction;
- upstream-first behavior during a Pool Adapter persistence outage; and
- bounded, idempotent Pool Adapter retirement after the governance floor.

Run `cargo test --all-features --test stratum_v1_proxy` or the repository-wide `bun run verify`.
