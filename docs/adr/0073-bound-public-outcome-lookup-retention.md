# Bound public Outcome Lookup retention independently

Claimant-facing Outcome Lookup remains available for a configurable window defaulting to 24 hours after Redemption acceptance, independently of the longer audit or product retention applied to Redemption Records and Protected Action Outcomes. Replay identifiers for Claimant Outcome Proofs are retained only for the proof freshness interval plus permitted clock skew and are then deleted. Pass Consumption markers remain until no conforming verifier could accept the pass, while longer retention follows the separate audit or product policy.
