# Bind Gate Passes to claimant keys

Gate Passes will be proof-of-possession capabilities rather than bearer tokens. Each Work Challenge and resulting pass will bind the Relying Service, Protected Action, opaque action reference, expiry, unique challenge identifier, and the Claimant's ephemeral public key; Redemption requires a signature from that key and atomic one-time consumption of the challenge identifier, limiting theft and cross-action replay without embedding personal data.
