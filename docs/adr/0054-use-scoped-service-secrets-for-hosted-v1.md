# Use scoped service secrets for hosted v1

Hosted Relying Services will authenticate with a client identifier and high-entropy API secret shown once, stored only as a verifier, scoped to permitted operations and Action Policies, bound to expected audiences and origins, separated by environment, rate-limited, and safely rotatable with brief overlap. Secrets never enter browser code; asymmetric client assertions remain an advanced conformance profile for high-security and self-hosted deployments.
