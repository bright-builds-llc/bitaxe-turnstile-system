# Create action execution intent inside the Redemption transaction

The first accepted Redemption atomically consumes the Gate Pass, creates the Redemption Record, creates its pending Protected Action Outcome, and inserts one durable Action Execution Intent. Workers may claim that outbox entry only after commit, eliminating the crash gap between authorization acceptance and scheduling the protected action.
