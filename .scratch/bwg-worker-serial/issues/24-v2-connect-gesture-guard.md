# Guard the V2 qualification Connect gesture

Status: resolved Type: task Blocked by: None

Implement the published firmware permission amendment
`str005-v2-serial-permission-v1` at source
`3d19bba786c73ac1b94c2dff0e47aabe86eace19`, SHA256
`e0ec62fd7248d202f85868cac848294cd8261ced3a63b129d25fa32777d285cd`. This ticket
owns the Gate qualification UI correction only. Failed-preparation closure,
successor admission and hardware qualification belong to the firmware repository
task.

- [x] Guard V2 qualification Connect with trusted, visible, focused and active
  gesture predicates before invoking any controller code.
- [x] Keep rejected preconditions local and unconsumed; preserve ordinary SDK
  behavior and permission/admission failure reporting.
- [x] Verify both permission-stage branches report zero opens, frames and scope
  activations without claiming that no chooser selection occurred.
- [x] Exercise production gesture handling in an actual headless browser.
- [x] Run ordered Cargo, type, browser, package and standards verification.
- [x] Complete review and publish the verified Gate correction.

## Boundaries

No device access, permission auto-selection, focus emulation, requestPort
wrapper, getPorts fallback, firmware protocol or mining authority changes. DOM
focus is an additional guard; the operator must independently verify the native
foreground window before a genuine Chrome gesture. Missing gesture predicates
produce only a static notice outside the observed acceptance state.

## Verification review

The V2 qualification Connect handler now rejects missing trusted, visible,
focused or active gesture predicates before invoking any controller code. The
notice is static and outside `#state`; rejection does not consume admission or
call the existing failure handler. Valid qualified Connect runs synchronously in
the click task. Ordinary Connect retains its prior asynchronous scheduling, and
the public controller/SDK implementation is unchanged.

Both permission-stage branches have explicit production-controller regressions:
selection rejection and selected-port foreground loss each report `permission`
and `operation_failed`, zero opens, frames and scope activations, and released
ownership. The second branch still records that selection occurred, preserving
the required non-claim.

The frozen two-file preflight regression command passes 15 tests. Full web tests
pass 788 tests with 2,089 assertions. Ordered Cargo format, Clippy, build and
tests pass; typecheck, browser build, package, trust/lookup and standards checks
pass. Actual headless Chromium verifies an untrusted programmatic click stays
local, a trusted click invokes the inert software callback synchronously with
all four DOM predicates, and ambient activation cannot make a later programmatic
click trusted. No hardware or actual Serial permission is used by that test.
Native OS foreground identity still requires the separate operator observation.

## Answer

Parent review found no remaining behavioral issue. Nullable helper names were
aligned with local standards and the affected type, full web, browser build,
standards and actual headless checks passed again. This commit publishes the
verified correction. The firmware repository still owns closure, fresh context
admission, native foreground operation and hardware evidence. No failed
preparation, device accounting or hardware result is changed by this Gate task.
