# Version BWG security semantics strictly

Development will use `BWG/0.x` until complete Conformance Profiles stabilize, then publish `BWG/1` with `/v1` HTTP paths and explicit versions in descriptors, challenges, handshakes, capabilities, and passes. Unknown non-critical fields may be ignored, unknown critical fields fail closed, Protobuf numbers remain reserved, and changed work accounting, signatures, trust, or lifecycle semantics require a new major version without reinterpreting issued artifacts.
