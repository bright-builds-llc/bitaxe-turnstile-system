# ADR-0105: Reference Firmware is the C fork of ESP-Miner

Accepted 2026-11-05, recording the owner's decision of 2026-10-30. It replaces
the Reference Firmware row of ADR-0030 and `docs/design/repository-ownership.md`.
No Gate contract, profile identifier or fixture changes.

The owner moved Reference Firmware from the Rust `bright-builds-llc/bitaxe-esp-miner`
to `bright-builds-llc/bitaxe-esp-miner-c`, a fork of upstream ESP-Miner that keeps
AxeOS and adds the Gate in its own `bwg_worker` component. The fork is GPL-3.0 as
a whole, and code moved from the Rust repository keeps its MIT notice. This
repository stays MIT, and contracts still cross by versioned packages and
conformance fixtures, as ADR-0030 says.

The C image needs no new signature. The owner's Update Authority capabilities for
the Ultra 205 and the Gamma 601, signed for the Rust image, name
`bright-builds-reference-firmware` 0.1.0 and bind Worker Serial manifest digest
`a43c2c7d61f95fc6`. The fork's manifest hashes to the same digest, so a C image
built with the owner's public trust and those capabilities is Reference Firmware,
and the Gate pins it by its source commit and ELF digest as before. On 2026-11-03
the Gate at `eb6a770`, given only the owner's trust, admitted the 601 running such
an image and ran one owner-signed lease through the firmware's host harness. That
run didn't use this repository's production browser path. Agents never use the
owner's private keys; only the owner signs.

The Rust repository, its ADRs and its evidence stay as historical records about
Rust images, and none of that evidence carries over to a C image. A change to the
fork's Worker Serial manifest needs new capability signatures from the owner.
Rust-only surfaces the C image lacks, such as cadence v2 stages, startup
diagnostics and `rust_panic_receipt`, keep their parsers here, since no Gate path
requires them. The fork's `docs/project/gate-integration-evidence.md` lists them.
