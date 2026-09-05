# Use fixed Serial/JTAG for local Workers

Accepted 2026-09-04. Supersedes the active TinyUSB/WebUSB topology and compatibility-preservation decisions in ADRs 0091 and 0092, and the Controller 0.3-specific signing bindings in ADR 0093. Historical records remain unchanged.

Use one fixed ESP32-S3 USB Serial/JTAG owner with a direct Web Serial browser adapter. Local control, heartbeat, and closed diagnostics use typed framed messages on one stream; diagnostics never authorize commands. Browser USB identifiers are permission/admission hints. Fresh Device Identity possession binds the session nonces, signed serial manifest, capability, and running source/ELF identity.

Controller 0.4, serial 0.1, possession 0.2, capability 0.2, deployment trust 0.2, and lease authorization 0.2 replace all active prototype profiles. Keep the deep WorkerController interface, full-input authorization, durable anti-replay state, role-separated authorities, and independently verified Mining Baseline restoration. Remove obsolete active code and exports rather than keeping compatibility shims.

Foreground ownership is explicit. One-second peer heartbeats have a 2.8-second firmware deadline that closes dispatch admission and starts safe stop within three seconds. Heartbeats cannot extend Work Leases. Losing foreground ownership, transport, or session requires a new explicit admission; returning to a page never resumes mining automatically.

The canonical wire and signature details are in `docs/protocol/bwg-worker-serial-0.1.md`. Gate owns those contracts and browser conformance; firmware owns the physical transport, deadline enforcement, and hardware campaign.
