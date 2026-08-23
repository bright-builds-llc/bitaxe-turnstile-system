# Enforce Work Leases with monotonic deadlines

Reference Firmware will validate signed lease freshness, convert each bounded duration into a local monotonic deadline, and require fresh authenticated renewal. Reboot, monotonic reset, uncertain time, or lost continuity terminates rather than resumes the lease and restores the Mining Baseline; server wall clocks remain synchronized with only documented bounded skew for JWT and DPoP validation.
