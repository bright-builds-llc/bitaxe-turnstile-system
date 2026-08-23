# Keep irreversible device hardening out of v1 onboarding

Ordinary Reference Firmware onboarding will generate a non-exportable-by-API Device Identity and use the strongest reversible storage protection available, but will not silently burn secure-boot, flash-encryption, JTAG, or download-mode eFuses. Device Identity is a possession credential rather than hardware attestation; irreversible hardening may be offered later only through a hardware-validated, explicitly consented advanced ceremony with recovery consequences disclosed.
