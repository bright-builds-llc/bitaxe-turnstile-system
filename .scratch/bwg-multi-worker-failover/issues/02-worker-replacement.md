# 02: Replace failed Workers without durable device identity

**What to build:** A failed or disconnected Work Session ends independently, while a replacement
Worker joins the same active Work Challenge using fresh operational identity and preserved progress.

**Blocked by:** 01: Aggregate exact work across concurrent and successive sessions.

**Status:** ready-for-agent

- [ ] Failure, disconnect, or lease expiry terminates only the affected Work Session and leaves
  healthy sessions eligible under the challenge lifecycle.
- [ ] A replacement receives fresh session credentials, generation, and extranonce space without
  receiving or exposing a persistent Worker or Device identifier.
- [ ] Replacement resumes from Authority-observed challenge progress rather than copying local
  progress or identity from the failed session.
- [ ] Cancelled, expired, satisfied, or pass-issued challenges reject replacement admission and
  terminate every late registration race.
- [ ] Safe per-session status and replacement reason remain observable across Pool Adapter restart
  without leaking Worker identity to the Relying Service.
