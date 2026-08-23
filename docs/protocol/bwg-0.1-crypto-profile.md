# BWG/0.1 Cryptographic Profile

This development profile fixes the cryptographic choices needed by Gate Pass and Redemption implementations. Changing these choices requires a new BWG major version once `BWG/1` is stable.

## Mandatory algorithms

| Purpose | JOSE `alg` | WebCrypto operation | Rationale |
| --- | --- | --- | --- |
| Gate Authority compact JWS signature | `Ed25519` | `Ed25519` | Fully specifies the curve selected by ADR 0023 and RFC 9864. |
| Claimant DPoP proof | `ES256` | ECDSA with P-256 and SHA-256 | Fully specified in JOSE, required by this profile, and supported by browser WebCrypto. |
| Claimant Issuance Proof | `ES256` | ECDSA with P-256 and SHA-256 | Reuses the challenge-bound Claimant key for read-only issuance recovery without making the Gate Pass a lookup credential. |
| Claimant Outcome Proof | `ES256` | ECDSA with P-256 and SHA-256 | Authenticates bounded read-only retrieval of an existing Redemption Record and outcome. |
| Claimant JWK thumbprint (`cnf.jkt`) | SHA-256 | `digest("SHA-256", ...)` | Required by RFC 7638 and RFC 9449. |
| Gate Pass access-token hash (`ath`) | SHA-256 | `digest("SHA-256", ...)` | Required by RFC 9449 over the ASCII compact Gate Pass value. |

The former polymorphic `EdDSA` JOSE identifier is rejected because RFC 9864 deprecated it in favor of the fully specified `Ed25519` identifier. The profile also rejects `none`, every symmetric MAC algorithm, unknown algorithms, and any mismatch between a protected-header algorithm and its JWK metadata before attempting signature verification.

## Gate Pass JWS

- Compact serialization is required.
- The protected `typ` is `bwg-gate-pass+jwt`.
- The protected `alg` is exactly `Ed25519`.
- The protected `kid` selects only an explicitly trusted configured or discovered Authority JWKS key.
- Authority JWKs use `kty: OKP`, `crv: Ed25519`, `alg: Ed25519`, `use: sig`, and `key_ops: [verify]`.
- No critical JOSE extensions are defined in `BWG/0.1`; a protected `crit` header therefore fails closed.
- The payload carries issuer, audience, issue/expiry time, unique pass identity, Work Challenge, Protected Action Type, immutable Action Policy revision, Action Reference, protocol version, and Claimant-key binding through `cnf.jkt`.
- Token-provided key URLs or arbitrary Authority keys do not become trusted inputs.

## Browser DPoP key

The Claimant generates a fresh P-256 signing key through WebCrypto with `extractable` set to `false`. WebCrypto keeps the private `CryptoKey` non-extractable while making the public key exportable for its JWK. The DPoP protected header contains only that public JWK, uses `typ: dpop+jwt` and `alg: ES256`, and never contains the private `d` member.

The Claimant key confirmation is the base64url-without-padding SHA-256 digest of this RFC 7638 canonical object:

```json
{"crv":"P-256","kty":"EC","x":"<x>","y":"<y>"}
```

The DPoP `ath` claim is the base64url-without-padding SHA-256 digest of the ASCII compact Gate Pass. Later Redemption validation must additionally enforce method, URI, time window, unique proof identity, replay state, exact Action Reference, and atomic pass consumption.

If the DPoP public JWK includes optional `alg` metadata, it must be exactly `ES256`. Redemption compares the thumbprint verified from the DPoP public JWK directly with the `cnf.jkt` recovered from the verified Gate Pass; independently valid but differently bound artifacts fail closed.

## Claimant Issuance Proof

Issuance Lookup uses a dedicated compact JWS with protected `typ: bwg-issuance-proof+jwt`, `alg: ES256`, and the Claimant public JWK. Its payload requires unique `jti`, `iat`, `htm: GET`, the exact public lookup URI in `htu`, and the Work Challenge ID. The Authority verifies the signature, request binding, 60-second freshness window, challenge-bound JWK thumbprint, and durable one-time proof identity before returning only the existing issuance state.

## Claimant Outcome Proof

Outcome Lookup uses a distinct compact JWS with protected `typ: bwg-outcome-proof+jwt`, `alg: ES256`, and the Claimant public JWK. Its payload requires unique `jti`, `iat`, `htm: GET`, the exact public lookup URI in `htu`, and the Action Reference. The Relying Service verifies signature, request binding, 60-second freshness, Redemption-key thumbprint, public lookup retention, and durable one-time proof identity before returning only the existing record and outcome.

## JWKS rotation

An Authority publishes stable, case-sensitive `kid` values. During a rotation overlap, verifiers accept both the outgoing and incoming public keys. After the published overlap ends, the outgoing key is removed from the accepted JWKS snapshot and a pass naming it fails with `unknown_kid`; key retirement never causes a verifier to try unrelated keys.

## Executable evidence

`conformance/bwg-0.1/crypto-vectors.json` is the shared fixture. Rust and WebCrypto verify the same Gate Pass, DPoP, key-confirmation, access-token hash, algorithm-failure, and rotation cases. The browser harness at `conformance/bwg-0.1/crypto-browser.html` additionally proves that the Claimant private key cannot be exported while its public JWK remains available.

Run the continuous checks with:

```text
bun run test
```

## Normative sources

- RFC 7515: JSON Web Signature
- RFC 7638: JSON Web Key Thumbprint
- RFC 8037: Ed25519 JWK representation and source test keys
- RFC 8725: JWT algorithm allow-list and substitution defenses
- RFC 9449: DPoP proof, `cnf.jkt`, and `ath`
- RFC 9864: fully specified `Ed25519` JOSE identifier and deprecated `EdDSA`
- Web Cryptography Level 2: P-256 and Ed25519 key generation, import, signing, verification, and extractability
