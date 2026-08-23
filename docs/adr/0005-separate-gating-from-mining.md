# Separate gating from mining

Gate policy and Gate Pass issuance will belong to a Gate Authority, while Bitcoin job construction, share acceptance, blocks, and rewards will remain the Mining Pool's responsibility. A thin Pool Adapter will associate challenge-scoped pool sessions with Work Challenges and report normalized accepted work; implementations may co-deploy these roles, but the protocol will not embed application authorization into Stratum or mining-pool internals.
