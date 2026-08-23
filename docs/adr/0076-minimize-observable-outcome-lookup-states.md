# Minimize observable Outcome Lookup states

Outcome Lookup returns only `pending`, `succeeded` with a safe result, or `failed` with a safe reason for an authenticated, publicly available record. Unknown Action References, Claimant-key mismatches, and expired public lookup windows remain externally indistinguishable, while internal retry details and sensitive failure data are never exposed.
