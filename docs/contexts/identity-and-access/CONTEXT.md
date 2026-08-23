# Identity and Access

This context describes persistent passwordless account identities and the credentials used to authenticate them. It does not define Claimants or Device Identities.

## Language

**Account Identity**:
A stable internal principal to which authenticators, Control Grants, and account data may be attached.
_Avoid_: Email address, Nostr public key, passkey, Device Identity

**Authenticator**:
A linked means of proving control of an Account Identity, such as a passkey, an email-code channel, or a Nostr remote signer.
_Avoid_: Account Identity, password, profile

**Nostr Authenticator**:
A verified Nostr user public key proven through a fresh user-key signature over a one-time HTTP-auth challenge.
_Avoid_: Relay identity, remote-signer key, unverified `get_public_key` result

**Authentication Assurance**:
The confidence assigned to an authentication event, with email code providing basic assurance and passkey or fresh NIP-46 signing providing strong assurance.
_Avoid_: Account role, authorization grant, permanent trust

**Step-Up Authentication**:
Fresh authentication at the assurance required for a sensitive account or device-control operation.
_Avoid_: Ordinary session refresh, password prompt

**Recovery Code**:
A one-time user-held secret whose salted hash is stored and which, together with a verified email channel, may enroll a replacement strong Authenticator.
_Avoid_: Password, staff override, reusable backup code
