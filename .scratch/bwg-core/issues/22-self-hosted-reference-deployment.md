# 22: Package a reproducible self-hosted reference deployment

**What to build:** A self-hoster can launch the complete reference BWG Core stack through one documented, reproducible path and receive the same public interfaces, trust controls, provenance, health signals, and safety behavior as the hosted deployment.

**Blocked by:** 04: Secure challenge issuance and publish Authority discovery; 07: Persist and recover the gate lifecycle; 11: Protect account creation with an accessible Web Component; 17: Submit block candidates independently of gate outages.

**Status:** ready-for-agent

- [ ] One supported launch path starts Gate Authority, PostgreSQL, Pool Adapter, pinned Hydra/P2Pool, Bitcoin Core integration, reference service, and Web Component assets.
- [ ] Configuration distinguishes public endpoints, private service links, trust roots, secrets, Pool Offers, Action Policies, and payout terms.
- [ ] Startup fails visibly when required pins, migrations, keys, proposal validation, or dependencies are unavailable.
- [ ] Authority discovery, source, version, commit, build, engine, and license provenance are visible.
- [ ] Health and readiness distinguish application availability from valid mining-job readiness.
- [ ] Backup, restore, upgrade, key rotation, shutdown, and recovery operations are documented and testable.
- [ ] The deployment passes the same public acceptance harness without self-host-specific protocol forks.
