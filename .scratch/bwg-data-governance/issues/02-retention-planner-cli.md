# 02: Plan retention through service-local operator CLIs

**What to build:** A Service-Local Operator can run either context's CLI to obtain a read-only, digest-bound Retention Job plan, and can only apply that exact bounded plan when destructive mode and explicit confirmation are present.

**Blocked by:** 01: Publish the governance contract and lifecycle model.

**Status:** ready-for-agent

- [ ] Pure typed policy calculation rejects configuration below Retention Floors and produces independently verifiable eligibility reasons and actions.
- [ ] Separate Gate Authority and Relying Service CLIs expose `plan-retention`, `apply-retention`, and `export` without adding remote HTTP administration.
- [ ] Additive migrations persist context-local immutable manifests, job state, and resumable cursors while leaving legacy rows ineligible until safe terminal times exist.
- [ ] Planning never mutates governed records; apply is disabled by default and rejects missing confirmation, digest drift, stale policy, or the wrong context.
- [ ] CLI-level tests prove dry-run and repeated apply behavior without using database rows as acceptance oracles.
