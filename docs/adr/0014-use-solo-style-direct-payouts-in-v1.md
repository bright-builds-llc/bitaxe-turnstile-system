# Use solo-style direct payouts in v1

The first pool integration will treat accepted lower-difficulty work solely as gate progress, not as a claim on future pool revenue. If a Work Session finds a network-valid block, the coinbase will pay the challenge's disclosed Payout Destinations directly; this avoids custody, balances, thresholds, and PPLNS accounting while remaining honest that a small pool has high reward variance rather than no possibility of reward.
