# Distinguish BWG failure from policy fallback

When all trusted Gate Authorities or approved pools are unavailable, BWG fails closed and never accepts expired passes, estimates, unsigned claims, or unverifiable transferred progress. A Relying Service may retry, choose another trusted path, defer, or explicitly waive BWG through its Abuse Policy, but it records and reports that fallback rather than representing it as successful proof of work.
