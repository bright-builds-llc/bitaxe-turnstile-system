# 01: Publish the governance contract and lifecycle model

**What to build:** Operators and implementers can rely on one reviewed BWG/0.1 contract for authority, retention, retirement, export, audit, failure recovery, and rollout, with the lifecycle prototype preserved as primary evidence.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] The self-answered grill preserves every decision and rationale from the privileged governance frontier.
- [x] Canonical governance vocabulary and three durable architectural decisions are recorded in domain documentation.
- [x] A normative retention matrix, operator threat model, export/audit contract, and incident behavior are published.
- [x] The disposable prototype validates safety floors, staged retirement, interrupted jobs, snapshot resume, and context isolation on a throwaway branch.

## Answer

Published the BWG/0.1 Data-Governance Profile, decision tree, glossary additions, and ADRs 0087–0089.
The lifecycle prototype is preserved on `codex/prototype-bwg-data-governance-lifecycle` at
`b0014ec353754e94e22b2c7031130bb61c37ee18`; only its validated findings remain on `main`.
