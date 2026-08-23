# Separate expiring Gate Passes from durable outcomes

An unredeemed Gate Pass will expire absolutely after its short lifetime and cannot be refreshed, extended, banked, or exchanged. Its first valid Redemption atomically burns it and creates a Redemption Record; the Relying Service owns any internal retry, while a bounded status lookup using the Action Reference and Claimant key may retrieve the accepted outcome without reauthorizing or restarting the Protected Action.
