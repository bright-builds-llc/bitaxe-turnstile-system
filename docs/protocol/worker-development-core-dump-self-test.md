# Development core-dump self-test qualification

The private acceptance page may enable `coreDumpSelfTestQualification: true`
only under a firmware-owned execution contract. It exposes
`workerAcceptance.coreDumpSelfTest({requestNonce, expectedBootOrdinal})` as a
page-lifetime one-use diagnostic. The authenticated command is
`qualification_core_dump_self_test`; its exact ACK schema is
`worker-qualification-core-dump-self-test-v1`, with the nonce and current/next
boot ordinals. It uses the existing fresh possession, idle restoration, write
settlement, retained port ownership and fresh post-reset admission lifecycle.
The ACK alone never proves a captured dump. Successful observation requires the
next boot's `panic` reset category, exact firmware/ELF identity and runtime
readiness. Ordinary `qualification_restart` still requires `software_cpu`.
Protected evidence substitutes a SHA-256 nonce digest and is available through
`exportCoreDumpSelfTestEvidence()` after a failed observation as well.

The explicit flag is sticky across an existing Stratum V2 before/candidate
transition. Before phase permits only fresh possession and scoped status reads;
its controller hook rejects diagnostic effects. Self-test is candidate-only in
that flow. The original private preservation baseline remains on the same page.
Neither this browser capability nor a successful capture grants mining or
flashing authority; firmware enforces its own physical safe-state checks, and
the task contract owns any permitted effects and private dump handling.

## Closed core-store observations

The native diagnostic parser accepts `core_dump_store_receipt schema=v1` as a
non-authoritative observation. `current_boot` and `previous_boot` origins are
kept distinct. Invalid receipts expose only their origin and the closed status
`unavailable`, `corrupt`, `wrong_firmware` or `wrong_boot`.

Valid receipts include the 16-hex-digit source fingerprint, exact decimal-string
u64 boot ordinal, a closed store stage, u32 capacity/requested/prepared lengths,
i32 SDK results and a boolean self-test marker. Requested/prepared lengths and
SDK results may instead be the literal `unavailable`; an SDK result of `-1`
remains a real numeric error. Arbitrary error text, extra fields, integer overflow
and rounded counters are rejected again at export.

Previous-boot receipts share the existing eight-entry crash-retention bound and
survive reconnects; current observations share the existing 32-entry history.
Identity keys include origin, source fingerprint, boot ordinal and status.
Current progress cannot overwrite a previous receipt. A missing or stale receipt
is not success. The source fingerprint alone does not establish exact ELF
identity: consumers must separately require fresh authenticated identity and
unchanged, pinned image evidence across the diagnostic attempt.
