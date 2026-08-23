# Bound Protected Action execution finality

Each immutable Action Policy pins an execution deadline, maximum attempts, and retryable-error classes. The Relying Service durably leases each internal Action Execution Attempt with its next retry time and marks the Protected Action Outcome `failed` on a non-retryable error or exhaustion of either bound, preventing crashed or unhealthy workers from leaving an outcome pending forever.
