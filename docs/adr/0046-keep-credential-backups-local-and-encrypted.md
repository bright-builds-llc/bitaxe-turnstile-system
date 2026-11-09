# Keep credential-bearing migration backups local and encrypted

Amended 2026-11-08 by ADR-0111: post-reboot categories are HMAC-SHA-256 under a per-onboarding nonce, not plain hashes, and the rollback copy of the raw `nvs` partition lives only in browser memory. The encrypted download stays optional.

Firmware onboarding will preserve compatible NVS settings by default and admit images only across supported schema ranges. When safe reads permit a Migration Backup, the browser encrypts it with user-provided material before local download, keeps plaintext only in bounded memory, and never sends secrets through services, logs, analytics, QR codes, URLs, storage, or support artifacts; post-reboot verification uses redacted categories and hashes and stops before flashing when recovery cannot be established.
