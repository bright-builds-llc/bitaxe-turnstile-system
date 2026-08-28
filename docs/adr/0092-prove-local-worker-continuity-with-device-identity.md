# Prove local Worker continuity with Device Identity possession

Local Transport Reacquisition will require an additive `bwg-worker-possession/0.1` fresh-nonce
signature by the Reference Firmware Device Identity before production control can start or resume.
Controller 0.2 and `bwg-worker-usb/0.1` remain unchanged compatibility profiles; production advances
to Controller 0.3 bound to `bwg-worker-usb/0.2`, whose control function admits only possession and
Controller frames. VID/PID, USB serial, enumeration identity, and their hashes remain admission
hints because a replacement device can clone them. This proves continuity without adding pairing,
accounts, persistent Control Grants, remote relay, or hardware-attestation claims.
