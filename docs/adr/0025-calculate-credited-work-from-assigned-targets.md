# Calculate Credited Work from assigned targets

Each accepted, non-duplicate share will receive integer Credited Work equal to floor(2^256 / (assigned_target + 1)), following Bitcoin's expected-hashes interpretation of target work. Accounting uses the server-assigned target rather than reported hashes or the accidental depth of a lucky result, sums with integer arithmetic, and serializes exact values without floating-point difficulty.
