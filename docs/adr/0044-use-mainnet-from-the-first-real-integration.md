# Use mainnet from the first real mining integration

Real Worker integration may use Bitcoin mainnet from the outset rather than waiting behind a regtest activation stage. Before releasing any mainnet job, the pool path will independently verify Reward Policy outputs and block construction, require BIP 23 proposal acceptance of the exact constructed block, and fail closed on any payout, commitment, previous-block, target, or proposal disagreement; continuous regtest fixtures remain parallel CI evidence, not a prohibition on bounded mainnet work.
