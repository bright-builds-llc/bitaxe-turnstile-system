# Use WebSocket and Protobuf for Device Relay sessions

Reference Firmware will initiate an outbound WebSocket-over-TLS Relay Session and authenticate its Device Identity through signed challenge-response. Bounded Protobuf frames, sequencing, acknowledgements, and heartbeats support reconnect and resume, while consequential commands remain independently signed and expiry-bound; retained or replayed commands are never made valid by the transport itself.
