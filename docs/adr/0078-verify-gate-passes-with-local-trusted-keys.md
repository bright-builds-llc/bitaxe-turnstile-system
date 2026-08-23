# Verify Gate Passes with local trusted Authority keys

Relying Services validate Gate Passes against a durable local Trusted Authority Key Set and never depend on a live Gate Authority inside the Redemption transaction. An unfamiliar `kid` may trigger one bounded metadata refresh before the transaction begins, but discovery alone grants no trust and Authority database or network availability cannot become part of atomic Pass Consumption.
