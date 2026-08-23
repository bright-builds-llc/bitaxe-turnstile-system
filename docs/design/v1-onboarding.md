# V1 Onboarding Flow

## Entry

The Relying Service backend validates the Protected Action, creates an opaque Action Reference, and requests a Work Challenge from its trusted Gate Authority. The Web Component receives only the public challenge descriptor and asks whether the Claimant has a compatible Bitcoin miner.

## Worker paths

### Previously managed Workers

The Claimant opens the trusted Worker Authorization surface, authenticates strongly, selects one or more online Workers, and approves a single-challenge Worker Capability. The Relying Service receives no Account Identity or Device Identity.

### Local Bitaxe reference path

1. The Claimant connects a Bitaxe over USB through a direct user gesture.
2. The client detects board and firmware capabilities without reading secrets.
3. Compatible Reference Firmware proceeds directly.
4. Otherwise, the client offers a signed compatible image with settings preservation enabled.
5. Schema admission, optional client-encrypted Migration Backup, flashing, reboot, and redacted retention verification complete locally.
6. No Bright Builds account or mobile application is required.

### Other compatible Workers

An advanced flow provides short-lived Stratum V1 session configuration for any compatible Worker. Reference Firmware and Bitaxe ownership are not protocol requirements.

### No compatible Worker

The client explains that the Protected Action requires Bitcoin-productive work, provides neutral open-hardware information and a guided Bitaxe path, and displays any alternative authorization or payment methods configured by the Relying Service. A service may deliberately offer no fallback.

## Consent and work

The Claimant selects an approved Pool Offer and per-challenge Payout Destination or explicit donation beneficiary. Before starting, the client discloses exact expected hashes, Equivalent Binary-Zero Work, Worker-specific duration and energy estimates when available, Reward Policy, participating Workers, cancellation behavior, and safety ceilings.

Work begins only after Work Consent. Verified Progress advances through Accepted Work Events; a visually distinct Activity Estimate may indicate current mining. Multiple Workers may contribute, failed equivalent pools may resume without losing progress, and changed economic or privacy terms require fresh consent.

## Completion

At the Work Requirement threshold, the Gate Authority issues a two-minute proof-of-possession Gate Pass. Every Work Lease ends and each Worker confirms restoration of its Mining Baseline. The Claimant redeems the pass with DPoP for the exact Action Reference; the Relying Service atomically consumes it and creates an idempotent Redemption Record. Continuous mining, account creation, mobile installation, and persistent device management are separate optional follow-on experiences.
