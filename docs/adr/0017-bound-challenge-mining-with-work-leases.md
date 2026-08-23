# Bound challenge mining with fail-safe Work Leases

Reference Firmware will perform challenge work only under an authenticated, expiring Work Lease and will capture its Mining Baseline before starting. Cancellation, expiry, or loss of required control continuity ends challenge mining and restores that baseline without depending on cloud availability; the Gate Authority may retain already Credited Work until challenge expiry, but challenge credentials never become ordinary persistent pool settings.
