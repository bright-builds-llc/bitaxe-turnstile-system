# Separate expiring Gate Passes from durable outcomes

An unredeemed Gate Pass will expire absolutely after its short lifetime and cannot be refreshed, extended, banked, or exchanged. Its first valid Redemption atomically burns it, creates a Redemption Record, and establishes one separately retryable Protected Action Outcome; the Relying Service owns internal execution, while bounded Outcome Lookup using the Action Reference and Claimant key may retrieve those existing records without reauthorizing or restarting the Protected Action.
