# 09: Diagnose rejected Start and review the original budget

Status: resolved
Blocked by: None
Type: task

- [x] Parse only bounded closed admission-stage, first-failure, readiness and budget diagnostics.
- [x] Expose possessed-session budget review without echoing campaign identity.
- [x] Validate mask relationships, fixed window charges and at most one pending window.
- [x] Add a qualification-only invalid-signature Start through the production browser adapter.
- [x] Require a correlated authentication rejection and release without appending another command.
- [x] Keep the reviewed possession binding private and reuse it once for authorization preparation.
- [x] Pass targeted browser adapter, parser, signature rejection and TypeScript checks.
- [x] Pass full Gate verification; firmware owns coordinated pinning, publication and hardware acceptance.

## Context

A live Start timed out and left fresh recovery admission unavailable. Firmware
owns the cleanup fixes and hardware evidence. Gate must report the exact rejected
boundary, retain the first failure, and query the existing campaign ledger before
any later qualification window. A diagnostic line cannot establish campaign
identity, restoration, budget authority, or available mining time.

## Comments

The serial 0.2 envelope and Controller 0.4 error shape remain unchanged. The new
read-only `acceptance_budget_review` result and qualification helpers are described
in the canonical serial specification. No signing endpoint, owner credentials,
window issuance, or campaign claim enters the rejection fixture. Software tests
verify the all-zero signature fails and that a correlated rejection releases the
port. Physical rejection/reconnection and live mining remain firmware-owned
acceptance obligations, not claims of this ticket.

## Answer

Full Gate verification passed, including 371 web/CLI tests, Rust, TypeScript,
browser conformance, package and standards checks. ADR 0097 defines reservation
cleanup and the conditional remaining-budget successor. The production codec,
shared schema/vectors and browser adapter agree on the read-only review and
closed rejection response. The firmware task owns its implementation pin and
all physical evidence; this ticket does not claim live-mining success.
