# Separate Device Identity from account control

A Device Identity will exist independently of user accounts and will be managed through revocable Control Grants. V1 exposes one Owner Grant with explicit revocation and transfer; transfer requires current-owner approval or a new local Pairing Ceremony, while a local factory reset rotates the Device Identity and invalidates all prior grants without exposing the device private key to the backend.
