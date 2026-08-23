## lesson-separate-pass-expiry-from-idempotent-outcomes | 2026-08-22 15:00

1. Date: 2026-08-22 15:00 CDT
2. What went wrong: Idempotent Redemption was described in a way that could imply the Claimant retains or reuses a Gate Pass indefinitely after the first accepted Redemption.
3. Preventive rule: Model an expiring, single-use authorization separately from the durable server-side action outcome; burn the pass on the first valid Redemption and let only the Relying Service's outcome and internal retry state survive.
4. Trigger signal to catch it earlier: A token-retry design says the client can keep presenting a consumed or expired pass to drive execution instead of limiting it to retrieval of an already accepted outcome.

## lesson-mainnet-acceptance-needs-guardrails-not-a-stage-gate | 2026-08-22 20:52

1. Date: 2026-08-22 20:52 CDT
2. What went wrong: Mainnet interaction was placed behind deterministic and hardware-regtest stage gates even though the user accepts working directly with mainnet unless a concrete serious risk requires otherwise.
3. Preventive rule: When mainnet use is explicitly authorized, identify and mitigate the exact irreversible boundaries while keeping deterministic tests in parallel; do not convert general caution into an unrequested environment prohibition.
4. Trigger signal to catch it earlier: A proposal delays all mainnet work until later phases without first naming a specific unmitigated mainnet-only risk that makes current bounded work unsafe.
