# 13: Accept standard Stratum V1 work through the transparent proxy

**What to build:** A non-Bitaxe Worker can use short-lived challenge credentials against the MIT Rust Pool Adapter proxy, mine through a simulated upstream pool, and advance the same Gate Authority progress path without custom Stratum extensions.

**Blocked by:** 05: Credit accepted work and stream Verified Progress; 09: Disclose and select a solo Pool Offer.

**Status:** ready-for-agent

- [ ] Standard subscribe, authorize, notify, target, submit, and response flows pass through unchanged.
- [ ] Each Work Session receives unique short-lived credentials and extranonce space.
- [ ] The target effective at submission becomes the Accepted Work Event target.
- [ ] The adapter durably records an accepted event before acknowledging the Worker.
- [ ] Reconnect, duplicate, cross-session, rejected, stale, and expired credential cases behave deterministically.
- [ ] The proxy resends events at least once until the Gate Authority acknowledges them.
- [ ] Potential block results continue upstream before non-critical gate processing.
