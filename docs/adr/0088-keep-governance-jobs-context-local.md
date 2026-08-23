# Keep governance jobs context-local

Each Gate Authority or Relying Service Retention Job, export, Governance Manifest, cursor, audit event, and transaction belongs to exactly one persistence context, even when both contexts share a PostgreSQL cluster. This extends the existing transaction boundary to governance work: independent failure and recovery are preferable to cross-schema foreign keys or transactions that would couple Redemption to Authority availability.
