# Repository Ownership

Repositories are created only when implementation work begins. This map assigns responsibility without requiring empty scaffolds during design.

| Repository | Owns | Explicitly does not own |
| --- | --- | --- |
| `bitaxe-turnstile-system` | Gate specifications; OpenAPI and Protobuf contracts; Rust Gate Authority and domain crates; Pool Adapter SDKs and implementations; browser SDK; SolidJS gate widget; operator console; conformance fixtures; reference demo | Device fleet control; firmware; Mining Pool engine internals |
| `bitaxe-esp-miner` | Reference Firmware; USB provisioning and control; Work Lease execution; Mining Baseline restoration; Device Identity; outbound Device Relay client | Gate Policy; Credited Work accounting; Gate Pass issuance; website authorization |
| `bitaxe-worker-management` | Device Relay; Identity and Access; Control Grants; pairing backend; SolidJS web management; Capacitor mobile shell and narrow native bridges; shared management packages | Mining Pool accounting; Gate Policy; firmware implementation |
| External pool repositories | Bitcoin job construction; Stratum services; accepted shares; candidate blocks; rewards | Protected Actions; Gate Passes; Account Identities; device management |

Cross-repository contracts are published as versioned crates or packages and exercised through shared conformance fixtures. External pool licenses remain disclosed and isolated by Pool Adapter process boundaries.
