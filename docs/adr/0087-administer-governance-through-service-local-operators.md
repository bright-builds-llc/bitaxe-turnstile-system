# Administer governance through Service-Local Operators

BWG/0.1 data governance is administered through separate host-local Gate Authority and Relying Service command-line interfaces backed by least-privileged context-specific database roles. We rejected a remote administrative HTTP API and reuse of Claimant proofs because either would create a new network authentication protocol and enlarge claimant-bound read authority into privileged export or destruction authority.
