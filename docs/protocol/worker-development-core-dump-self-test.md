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
