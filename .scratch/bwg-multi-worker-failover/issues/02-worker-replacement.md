# 02: Replace failed Workers without durable device identity

**What to build:** A failed or disconnected Work Session ends independently, while a replacement
Worker joins the same active Work Challenge using fresh operational identity and preserved progress.

**Blocked by:** 01: Aggregate exact work across concurrent and successive sessions.

**Status:** resolved

- [x] Failure, disconnect, or lease expiry terminates only the affected Work Session and leaves
  healthy sessions eligible under the challenge lifecycle.
- [x] A replacement receives fresh session credentials, generation, and extranonce space without
  receiving or exposing a persistent Worker or Device identifier.
- [x] Replacement resumes from Authority-observed challenge progress rather than copying local
  progress or identity from the failed session.
- [x] Cancelled, expired, satisfied, or pass-issued challenges reject replacement admission and
  terminate every late registration race.
- [x] Safe per-session status and replacement reason remain observable across Pool Adapter restart
  without leaking Worker identity to the Relying Service.

## Answer

Work Session failure and established-transport disconnect remain session-local: the affected
session retains its derived stop reason, a healthy peer stays leased and continues challenge-scoped
progress, and the Relying-facing challenge lifecycle exposes only aggregate progress. Every Stratum
TCP adapter construction now requires a disconnect sink, and the Hydra composition supplies its
Authority adapter so an authenticated connection ending cannot silently leave the session leased.
After Authority and Pool Adapter registry restart, one explicit replacement transition atomically
copies the consented pool binding into a new opaque Work Session, pins the stopped predecessor and
derived reason, and allocates a challenge-monotonic generation. Exact response-loss replay returns
the same transition; a conflicting replacement is fenced out.

The replacement then receives a fresh Work Lease, Stratum username, secret, and extranonce
reservation while continuing from the Authority's durable progress rather than predecessor-local
state or device identity. Pool Adapter status lookup recovers the transition generation and reason,
while the public challenge projection exposes none of those session identifiers or credentials.
Exact replacement replay remains stable even after the challenge later becomes terminal; current
lifecycle and expiry checks apply only when creating a new transition.

The Ticket 02 tracer exposed and fixed one terminal race. Threshold completion previously stopped
only leased sessions, so a replacement registered immediately before completion remained stranded
as `ready`. The same challenge transaction now moves both `ready` and `leased` sessions to
`stopping` with `challenge_satisfied`. PostgreSQL acceptance tests cover that satisfied/pass-issued
path, expiry, failure/disconnect isolation, restart, replacement replay and generation fencing,
credential/extranonce freshness, TCP disconnect notification, and public identity redaction; the
existing lifecycle concurrency suite supplies deterministic cancellation and registration
serialization evidence.
