# 15: Accept standard Stratum V1 work through the transparent proxy

**What to build:** A non-Bitaxe Worker can use short-lived challenge credentials against the MIT Rust Pool Adapter proxy, mine through a simulated upstream pool, and advance the same Gate Authority progress path without custom Stratum extensions.

**Blocked by:** 05: Credit accepted work and stream Verified Progress; 11: Disclose and select a solo Pool Offer.

**Status:** resolved

- [x] Standard subscribe, authorize, notify, target, submit, and response flows pass through unchanged.
- [x] Each Work Session receives unique short-lived credentials and extranonce space.
- [x] The target effective at submission becomes the Accepted Work Event target.
- [x] The adapter durably records an accepted event before acknowledging the Worker.
- [x] Reconnect, duplicate, cross-session, rejected, stale, and expired credential cases behave deterministically.
- [x] The proxy resends events at least once until the Gate Authority acknowledges them.
- [x] Potential block results continue upstream before non-critical gate processing.

## Answer

The Rust Pool Adapter now runs a bounded transparent Stratum V1 TCP proxy for unmodified Workers.
Verifier-only PostgreSQL admission rotates short-lived Work Session credentials safely, reserves a
case-canonical `extranonce1` before exposing subscription success, and cleans every failed pre-bind
reservation. The pure transcript binds targets to jobs, forwards submits before header observation,
reconstructs real Bitcoin headers, and classifies network candidates without extending Stratum.
Accepted responses persist the exact event, submit-time monotonic lease observation, and unchanged
Worker response before acknowledgement; leased delivery retries the existing Gate Authority path
and semantic replay returns the first durable observation. A bounded, trusted-time retention seam
retires only acknowledged/expired operational rows after the hosted floor. Thirty focused tests,
the full repository verifier, and independent Standards and Spec reviews against `000a377` pass.
