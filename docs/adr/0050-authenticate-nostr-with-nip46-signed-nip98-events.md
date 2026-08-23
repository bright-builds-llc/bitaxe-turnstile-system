# Authenticate Nostr with NIP-46-signed NIP-98 events

NIP-46 will provide remote-signer transport with only `sign_event:27235` permission, while login proof will be a fresh NIP-98 event bound to the exact URL, method, request-body hash, server nonce, and short time window. The service verifies and consumes the user-key signature once; relays, remote-signer identity, and an unverified `get_public_key` response are not Account Identity proof.
