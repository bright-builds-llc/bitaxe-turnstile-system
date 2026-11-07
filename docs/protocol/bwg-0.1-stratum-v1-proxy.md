# BWG/0.1 Stratum V1 Pool Adapter Proxy

The reference Pool Adapter is an MIT Rust TCP proxy between an unmodified standard Stratum V1 Worker and one upstream Mining Pool connection. It forwards `mining.subscribe`, `mining.authorize`, `mining.set_difficulty`, `mining.notify`, `mining.submit`, and their JSON-RPC responses without adding Work Challenge or Protected Action fields to Stratum. A Worker may open with one `mining.configure` before `mining.subscribe`; the proxy forwards it and relays the reply, and nothing else is accepted before authorization. A submit's sixth version-bits parameter is applied under the mask that reply granted, as the Mining Pool applies it, and is refused without one.

## Work Session admission

The Pool Adapter issues one deterministic opaque username and 256-bit secret for an exact `(Work Session ID, expiry)` under an operator key. Repeating one generation returns the same credentials after response loss, while another Work Session receives different values. Credentials may not extend beyond 60 seconds, the Work Lease wall-clock expiry, the Work Challenge expiry, or the remaining monotonic Work Lease duration. A later generation, ordered by its issue time in milliseconds, atomically rotates the verifier for the same Work Session, and an older generation cannot roll it back. PostgreSQL stores only a domain-separated secret verifier, the opaque session mapping, issuance/expiry times, and exact Authority-issued Work Lease context; it never stores the Worker secret.

`mining.authorize` is checked locally before it reaches the upstream connection. Invalid credentials receive a standard `result:false` response, expired credentials terminate processing, and every later `mining.submit` must name the authorized Worker username. For pools such as Hydra that use the standard username as a payout identity, the adapter may translate only the Pool-facing authorize/submit username to the selected address; Worker-facing traffic and accepted responses remain standard, and outbox records never carry the payout address. With per-session upstream authorization, each connection's Pool-facing identity comes from the claimant's choice stored in `pool_adapter.session_pool_selections` (ADR-0107), and a session without one is refused at admission. That row is the only place the raw payout choice is kept, beside its commitment. It is deleted when the challenge is satisfied, cancelled or expired, on lookup after expiry, and by `delete_expired_pool_selections`. Each accepted upstream subscription is assigned a connection ID, and its case-canonical `extranonce1` is durably reserved before the successful subscription response is exposed to the Worker. Authorization then binds that reservation to the authenticated Work Session. Every pre-bind exit removes the reservation; if admission and cleanup both fail, the adapter reports both errors for recovery instead of hiding the leak. A reconnect may receive a fresh `extranonce1`, but no two connection records can claim the same coinbase space.

A Work Lease renewal extends the registration instead of rotating it. The extension keeps the verifier, so the Worker's password is unchanged, and moves the expiry and lease context forward under the same bounds as a fresh issue. It applies only to an unexpired registration of the same lease and continuity, never shrinks the window, and an identical replay succeeds. An admitted connection rereads its registration every five seconds and at its expiry, so it continues past the window it was admitted with; rotated or expired credentials no longer authenticate, and the connection then ends at its own expiry. Each submit's lease reading advances the registered reading by the wall-clock milliseconds elapsed since it was issued, and claimant Work Sessions issue at the Authority lease clock's own reading so the two agree.

## Target and job state

`mining.set_difficulty` is parsed as a positive canonical JSON decimal with at most 18
fractional mantissa digits and an optional base-10 exponent from -18 through 18. The checked `u64`
rational construction rejects combinations whose numerator or denominator overflows. The proxy
then calculates the 256-bit target through wider checked decimal-rational multiplication and
division without floating-point accounting, saturating only when the final target exceeds 256
bits. Each `mining.notify` snapshots the then-effective target into its job, so a later difficulty
update cannot change an older job’s Accepted Work Event.

A clean `mining.notify` invalidates every older job before another submit can be forwarded. A submit for a job the session no longer holds gets error 21, "Job not found", as a pool answers it. It is never forwarded or credited, and the connection continues. Rejected upstream responses pass directly back to the Worker and create no event. Event identity is stable for one session/request replay. Share Fingerprint is derived from the reconstructed 80-byte Bitcoin block header, so the same candidate is globally deduplicable while otherwise identical submissions with distinct `extranonce1` values remain distinct shares. The header hash is also checked against the compact network target captured in the job.

## Persistence and delivery

An upstream `result:true` is not released to the Worker immediately. The transcript module first emits `PersistAccepted` with the exact target-qualified event, upstream response, and the Work Lease observation captured when the submit was forwarded. The TCP adapter commits them to the context-local `pool_adapter.accepted_work_outbox`; only `accepted_persisted` releases the unchanged response to the Worker. Replaying a response after connection loss returns the first durable event, lease observation, and response instead of changing their receipt time or monotonic reading.

Delivery workers lease pending outbox events and resend the exact event until the Gate Authority settles it. An unavailable Authority releases the event for a retry after exponential backoff, from one second up to five minutes. A crashed worker's event is recoverable after its lease expires. Authority-side event and share deduplication returns stable acknowledgements without double credit. The Pool Adapter marks delivery acknowledged only after the Authority call succeeds. An event the Authority will never credit gets a typed refusal (ADR-0108), and the adapter records it once with its reason and never delivers it again.

Worker submissions always reach the upstream Mining Pool before header reconstruction, network-target classification, outbox persistence, or Gate Authority delivery begins. If local observer state is malformed or outbox persistence fails afterward, the Worker receives no false acceptance, but a potential block candidate has already continued on the Mining Pool path.

Frames are capped at 16 KiB before allocation, idle connections time out, and each session retains at most 64 outstanding request IDs and its 96 newest jobs, retiring the oldest; 96 outlasts Hydra's 15-minute job age at its 10-second cadence. Duplicate in-flight JSON-RPC IDs fail closed instead of overwriting request state.

The context-local retention seam rejects periods below the hosted 30-day operational floor, oversized batches, and snapshot cutoffs later than its trusted current time. Once that floor has elapsed, one bounded transaction removes expired verifier/session rows, their connection reservations, abandoned unbound reservations, and acknowledged or refused outbox events; pending delivery rows are never retired. Repeating the same retirement is idempotent and releases historical `extranonce1` space for safe reuse.

## Conformance

The checked-in [`stratum-v1-proxy-transcript.json`](../../conformance/bwg-0.1/stratum-v1-proxy-transcript.json) drives the Rust transcript test. PostgreSQL and real TCP acceptance additionally cover:

- deterministic credentials and expiry;
- generation-bound credential rotation, including within one second, and monotonic lease advancement;
- renewal extension of registered and live sessions without a password change;
- per-session Pool-facing identity from the stored claimant choice, and its deletion at terminal states;
- unique connection-scoped extranonce reservation across restart;
- integer and fractional variable difficulty;
- reconstructed-header fingerprinting and network-target classification;
- stale, rejected, duplicate, reconnect, and cross-session submissions;
- persistence-before-acknowledgement;
- outbox lease recovery, backoff after an outage, and at-least-once Authority delivery;
- terminal refusal of uncreditable work, checked against the shared refusal vectors;
- the existing Gate Authority Verified Progress transaction;
- upstream-first behavior during a Pool Adapter persistence outage; and
- bounded, idempotent Pool Adapter retirement after the governance floor.

Run `cargo test --all-features --test stratum_v1_proxy` or the repository-wide `bun run verify`.
