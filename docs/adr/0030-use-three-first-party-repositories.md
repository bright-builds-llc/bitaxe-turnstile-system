# Use three first-party repositories

The system will use this gate monorepo for protocols, Gate Authority, SDKs, widget, adapters, and conformance; the existing `bitaxe-esp-miner` repository for Reference Firmware; and a future worker-management monorepo for Device Relay, Identity and Access, management applications, and shared control-plane packages. Mining Pool engines remain external and replaceable, while versioned packages and conformance fixtures—not Git submodules—carry contracts across repositories.

Amended 2026-11-05 by ADR-0105: Reference Firmware is now `bitaxe-esp-miner-c`, a C fork of upstream ESP-Miner, and the Rust `bitaxe-esp-miner` repository is a historical record.
