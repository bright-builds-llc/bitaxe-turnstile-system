# 17: Submit block candidates independently of gate outages

**What to build:** A network-valid block candidate reaches Bitcoin Core immediately through the Mining Pool path even when Gate Authority delivery, PostgreSQL, SSE, or the Relying Service is unavailable.

**Blocked by:** 16: Admit only exact BIP 23-valid mainnet jobs.

**Status:** ready-for-agent

- [ ] Block qualification and submission occur on the Mining Pool's latency-critical path.
- [ ] Gate event persistence, acknowledgement, and delivery occur outside that submission dependency.
- [ ] Gate Authority, database, event-stream, and application outage scenarios do not prevent block submission.
- [ ] Submission result and reward outcome remain separate from Gate Pass validity.
- [ ] Stale, rejected, duplicate, and reorganized block outcomes have explicit behavior.
- [ ] The same result receives only its assigned-target Credited Work rather than luck-based extra credit.
- [ ] End-to-end evidence measures submission timing and records residual operational risk.
