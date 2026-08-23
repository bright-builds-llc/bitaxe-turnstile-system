# Place a transparent Stratum proxy adapter before Hydra

The first Pool Adapter will be an MIT Rust Stratum V1 proxy co-located in front of a pinned, separately licensed Hydra release running solo/direct-payout mode. It forwards jobs and submissions unchanged, observes assigned targets and accepted responses, durably records Accepted Work Events before acknowledging Workers, and never polls inferred hashrate or teaches Hydra about Protected Actions; potential block traffic continues immediately toward Hydra's submission path.
