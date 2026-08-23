# Use unmodified Stratum behind transport-neutral adapters

The first reference deployment will use standard Stratum V1 as its Mining Transport for broad Worker compatibility, while the Pool Adapter exposes transport-neutral Work Session and credited-work events to the Gate Authority. Stratum V2 will be added through another adapter, and the gate protocol will not define a new mining transport or modify Stratum without a demonstrated interoperability gap.
