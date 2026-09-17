# V2 channel and share qualification client

Status: resolved Type: task Blocked by: None

Implement the frozen `str005-v2-serial-v1` contract published by firmware source
`6a4a45f8`, contract SHA256
`d23220a4ac5021470b18d7e97cb4b82ba28232d9d5a0f8340389852b39841c79`. This ticket
owns Gate software only; native fit and both hardware scopes remain the firmware
repository's qualification task responsibilities.

- [x] Preserve untagged V1 signing bytes while adding the closed V2 inner
  profile.
- [x] Parse bounded native V2 status, history, cleanup and actual ASIC facts.
- [x] Add exact-pair channel control and scoped read-only Share collection.
- [x] Retain same-page private baseline across each scope's four fresh cycles.
- [x] Test parser, signer, controller, page, privacy and historical regressions.
- [x] Run ordered Cargo and applicable browser/package/standards checks.
- [x] Review and publish the Gate implementation without claiming hardware
  acceptance.

## Software progress

The tagged V2 grant parser/signing path, scoped status/control methods and page
configuration are implemented. Historical V1 vectors and capability0.2 remain
unchanged. Native evidence is bounded and separated from the RAM-only network
wrapper; status history preserves original binding, first failure and terminal
outcome. Each scope owns its page baseline. Funded and diagnostic Start claims
remain consumed across ambiguous responses and controller replacement.

Review found an application-command collision between Share's renewal poller and
V2 status reads. Both now share the existing page polling slot, including the
fresh pre-fault headroom observation. Heartbeats keep their independent path. A
production page/controller regression holds status while renewal waits and then
verifies continued signed renewal and released ownership.

Ordered format, Clippy and build passed. The first Cargo test stage encountered
a testcontainers PostgreSQL `PortNotExposed` startup failure; its unchanged
focused retry and full test-stage retry passed (352 tests, two existing
ignored). Headless browser conformance passed. Full web checks passed 760 tests,
followed by focused tests for the additional page claim and phase guards.
Typechecking, browser build, package, trust/lookup and standards checks passed.

The published reservation-clock amendment is integrated. All eight current
actual Rust serializer cases, including positive wire-only records and secondary
clock failure, parse successfully; incomplete-to-late-release history also
passes. This record remains claimed; no hardware, native fit, channel exchange
or accepted-share qualification is claimed by Gate software checks.

Reservation-clock amendment `str005-v2-serial-clock-v1` is published at
`c53f9db9507f77955c4c8c9df7438225d1393dcd`, SHA256
`4fbdfc754610855c904c6434a4da6ef8506323c95582a0b23a6873a79bc3aaef`. Share
reports a null reservation deadline until the existing first guarded dispatch
arms it, then retains the actual absolute deadline. Channel remains admission
plus 120 seconds. These observations never extend either lease or heartbeat
authority.

Final integration review added a cached-review endpoint read and exact fresh
headroom metadata. Composed source-flow tests prove review-to-signing does not
refresh possession, keep bindings out of the DOM and retain the physical-effect
fence after the network worker returns. Gate publication still awaits the parent
review; these serializer and software results are not hardware qualification.

Final retained-session review found that an already terminal job collected after
fresh reconnect did not cache the new binding. The controller now retains that
successfully authenticated read binding for later status/cancel collection past
the Start-age window. Idle admission, replacement sessions and any new Start
still require fresh possession, and the original Start remains consumed. The
focused regression and full 778 web tests (2,052 assertions), typecheck, browser
rebuild and standards checks pass. All nine current actual Rust serializer cases
pass the production Gate parser. The final headless rerun and publication remain
coordinated by the parent task; no hardware claims follow from these checks.

## Answer

The scoped Gate implementation is verified and published with this record. Final
headless browser integration passed after the retained-session correction.
Independent firmware-side review found no remaining authority, renewal,
canonical V1 signing or private-field persistence finding. The native producer
now preserves the first protocol failure while limiting secondary facts to
clock/cleanup failures, matching the strict parser; all nine generated Rust
cases pass. Full web verification passed 778 tests with 2052 assertions.

The firmware task still owns clean native packaging, four-cycle continuity in
each scope, actual channel and accepted-share evidence, shutdown, restoration
and resource cleanup. Software checks establish no hardware acceptance.
