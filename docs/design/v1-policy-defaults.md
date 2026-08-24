# V1 Policy Defaults

These are configurable reference-product defaults, not protocol constants. A Gate Policy transmits the exact integer Work Requirement for each issued challenge, and changing a future preset does not require a protocol revision or alter an already issued challenge.

## Work presets

| Preset | Equivalent Binary-Zero Work | Approximate expected hashes | Ultra 205 estimate at 400 GH/s |
| --- | ---: | ---: | ---: |
| Light | 42 bits | `2^42` | 11 seconds |
| Standard | 44 bits | `2^44` | 44 seconds |
| Elevated | 46 bits | `2^46` | 2 minutes 56 seconds |

Account creation uses Standard by default. Relying Services may configure exact per-action requirements or revise their named presets as needs change.

## Post-completion behavior

Gate Pass issuance ends every challenge Work Lease and restores each participating Worker's Mining Baseline. Continuous mining is outside the v1 gate lifecycle; a later “Keep mining” experience starts only through separate consent, pool selection, payout, fee, and persistence terms.

## Lifecycle limits

| Artifact or ceremony | Default lifetime |
| --- | ---: |
| Work Challenge | 15 minutes |
| Work Lease | 60 seconds, renewed every 20 seconds while authorized control is healthy |
| Completed Gate Pass | 2 minutes to redeem |
| DPoP redemption proof | 60-second clock window and single use |
| Pairing Ceremony | 5 minutes |

Work Lease expiry restores the Mining Baseline but preserves Credited Work until the Work Challenge expires. A browser may retain the challenge's non-extractable ephemeral key only through challenge and pass expiry so an interrupted tab can resume without creating a persistent tracking identity.

BWG/0.1 does not extend signed artifact deadlines with verifier clock skew. Synchronized server clocks are required, and the signed or persisted deadline is the first invalid instant.

## Progress cadence

Verified Progress advances only through Accepted Work Events. The reference pool's variable-difficulty policy should target approximately one accepted share every two seconds for Bitaxe-class Workers and, when practical, keep one assigned share below 25% of the Work Requirement. Clients may animate a separate Activity Estimate but never count it toward completion.

## Hosted-service billing

V1 has no recurring donated-work quota. Any beta pool or service percentage is bounded and disclosed in the Reward Policy. A future billing context may request separately consented normalized work after real operating costs are measured; raw share counts are never a billing unit, and alternative payment methods remain possible.

## Trusted consent surface

The embedded Web Component may confirm Light and Standard local work. Elevated work, remote Worker dispatch, materially changed failover terms, pairing, and persistent-management enrollment require a confirmation surface served from the configured Gate Authority or Worker Management origin; widget configuration cannot suppress it.

## Bitcoin network

The first real Worker integration may use mainnet. Every mainnet job is independently checked against its Reward Policy and its exact constructed block must receive BIP 23 proposal acceptance from Bitcoin Core before release; any unavailable, inconclusive, or disagreeing result fails closed. Equivalent regtest scenarios run continuously in conformance and CI but do not replace this per-job admission check.
