# V1 Technology

## Gate monorepo

- Rust Cargo workspace
- Tokio asynchronous runtime
- Axum public and operator HTTP APIs
- SQLx with PostgreSQL
- tonic and Protobuf for Pool Adapter gRPC
- rustls for TLS-facing Rust components
- SolidJS Web Component and operator console
- Bun workspace for TypeScript and frontend packages

## Deployables

- One modular Gate Authority service
- One co-located Stratum V1 Pool Adapter proxy per pool-engine deployment
- Pinned external Hydra engine and Bitcoin Core node for the first Pool Offer
- Static hosted or self-hosted Web Component assets

Worker Management uses a separate Rust control-plane service and SolidJS/Capacitor workspace when that repository begins. Internal module boundaries follow the bounded contexts and published protocol ports rather than preemptively creating microservices.
