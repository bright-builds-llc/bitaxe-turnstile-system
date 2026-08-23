# Keep Redemption accepted when action execution fails

A terminally failed Protected Action Outcome does not alter its accepted Redemption Record or reverse Pass Consumption. The Relying Service exposes a safe failure reason through Outcome Lookup, never refunds the completed work or retries authorization with the consumed pass, and requires any genuinely new Protected Action attempt to use a new Action Reference under the applicable Action Policy.
