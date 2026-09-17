# Worker Standard V2 qualification profile

The inner signed Stratum profile `bwg-worker-stratum-v2-standard/0.1` is an
explicit qualification extension to Controller0.4. The outer Start/Renew
protocol and untagged V1 grant canonical bytes remain unchanged. Existing signed
capability0.2 does not advertise V2 support.

This implementation follows firmware contract `str005-v2-serial-v1`, frozen at
source `6a4a45f8` with SHA256
`d23220a4ac5021470b18d7e97cb4b82ba28232d9d5a0f8340389852b39841c79`. Native
readiness and hardware acceptance are separate obligations; these client
interfaces do not establish either result.

The closed V2 value contains `profile`, `endpoint`, `authorityPublicKey`, and
`userIdentity`. The endpoint must use canonical literal private IPv4 and an
explicit port. Authority is mandatory. Unknown or mixed profiles fail closed.
Signing covers the complete value, qualification attempt, and current possession
binding. V1 credentials, optional difficulty and fallback fields are forbidden
in this variant.

The qualification page freezes exact before/candidate firmware identities, Gate
commit, trust and `stratumV2Scope` (`channel` or `share`). It must begin in
`before`, capture its private preservation baseline, and release Serial
ownership before changing to `candidate`. Each scope has its own fresh page and
four update/reconnect cycles. Scope changes and imported baselines are rejected.

The page exposes `stratumV2Possession()`,
`stratumV2ChannelStart(input,binding)`,
`stratumV2Status(scope,attemptIdOrNull,binding)`, and
`stratumV2ChannelCancel(attemptId,binding)`. Channel cannot use signed work
routes. Share uses the normal signed Start/Renew/Stop flow and cannot invoke
diagnostic Start or Cancel. Its retained attempt ID is the funded qualification
attempt ID. A successful Start binds subsequent status reads to that same
session; it never refreshes an expired admission or restarts an ambiguous
request.

Status includes a RAM-only current network observation and retained connection
for correlation. Neither may be journaled. `projectWorkerV2Evidence` returns
only the closed device record, with bounded stages, operation timing summaries
and source-produced ASIC/nonce/write/ACK facts. A typed record is not an
independent acceptance judgment. Resource release, clock failures, original
failures and terminal outcomes retain their actual provenance across polling and
reconnect.

Reservation-clock amendment `str005-v2-serial-clock-v1` is published at
`c53f9db9507f77955c4c8c9df7438225d1393dcd`, SHA256
`4fbdfc754610855c904c6434a4da6ef8506323c95582a0b23a6873a79bc3aaef`. Share
reports a null reservation deadline until the existing first guarded dispatch
arms it, then retains the actual absolute deadline. Channel remains admission
plus 120 seconds. These observations never extend either lease or heartbeat
authority.

For Share observer setup, `submitBudgetReview()` caches the fresh private
possession context. `stratumV2TelemetryEndpoint()` consumes that existing
binding for read-only endpoint observations without refreshing possession; an
explicit binding remains supported. Finish observer and fixture readiness before
`prepareStartAuthorization()`, which posts to the signing route before
returning. Refresh the same-binding idle V2 status before issuance and again
before Start. Neither the endpoint nor its binding belongs in page diagnostics
or evidence.

Share's `suppressHeartbeats()` returns `worker-v2-fault-headroom-v1` metadata
from the exact fresh status that passed its guard: worker generation,
observation time in device microseconds, and both remaining deadlines in
milliseconds. It requires an active mining state with no prior revocation or
completed safe stop. The legacy method's behavior remains unchanged.
Network-worker quiescence does not release the effect fence while physical
restoration is still pending.
