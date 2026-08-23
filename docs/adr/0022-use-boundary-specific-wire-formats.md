# Use boundary-specific wire formats

The public gate API will use HTTPS JSON described by OpenAPI 3.1, with Server-Sent Events for initial browser progress, while the Gate Authority-to-Pool Adapter boundary will use gRPC and Protobuf for typed streaming work events. Worker Management and Gate Pass encodings will be selected separately for their constraints, with shared conformance fixtures ensuring every wire adapter implements one semantic lifecycle rather than creating competing domain models.
