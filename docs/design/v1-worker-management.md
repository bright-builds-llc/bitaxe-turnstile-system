# V1 Worker Management

## Remote capabilities

- View health, temperature, power, hashrate, firmware, connectivity, and mining state.
- Authorize, dispatch, renew, and cancel signed Work Leases.
- Confirm Mining Baseline restoration.
- Pause or resume ordinary mining.
- Identify and rename a Worker.
- Perform Update-Authority-signed OTA with rollback.
- Revoke or transfer the Owner Grant.

## Local-only capabilities

- Voltage, frequency, fan, and thermal-policy changes.
- Wi-Fi and ordinary pool credential changes.
- Factory reset and Device Reclamation initiation.
- Irreversible eFuse security hardening.
- Sensitive raw logs and credential-bearing recovery.

Web and Capacitor applications share one safe remote API. Full UI and device-user parity remain long-term goals, but capabilities move into the remote set only after their hardware safety, authorization, privacy, failure, and recovery contracts are independently verified.

## Hosted telemetry defaults

| Data | Default retention |
| --- | ---: |
| Current state | Live while connected |
| One-minute operational aggregates | 24 hours |
| Hourly aggregates | 30 days, opt-in |
| Safety and command audit records | 30 days |
| Sensitive raw logs | Never uploaded automatically |

Wi-Fi and pool credentials, payout addresses, IP addresses, SSIDs, and MAC addresses are excluded from telemetry. Owners may export and delete retained history; detailed short-lived diagnostics remain local to the Worker.
