# Deliver Accepted Work Events at least once

Pool Adapters will durably record Accepted Work Events before delivery and resend them until acknowledged, while Gate Authorities transactionally deduplicate adapter event IDs and stable share fingerprints before calculating Credited Work from assigned targets. This at-least-once contract tolerates process and network failure without distributed transactions, lost progress, or double credit.
