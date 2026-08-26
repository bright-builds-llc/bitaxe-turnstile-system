import type {
  AuthorityTrustInput,
  TrustedConsentRequest,
} from "./headless-client.types";

const MAXIMUM_COMPACT_RECEIPT_LENGTH = 16_384;

/** Verifies one strict Authority receipt against the exact trusted-consent request. */
export async function verifyTrustedConsentReceipt(
  compactReceipt: string,
  request: TrustedConsentRequest,
  trust: AuthorityTrustInput,
  nowUnixSeconds: number,
): Promise<void> {
  const compact = parseCompactJws(compactReceipt);
  const header = objectRecord(decodeJson(compact.protectedHeader), "trusted consent header");
  assertExactKeys(header, ["alg", "kid", "typ"], "trusted consent header");
  if (
    header.typ !== "bwg-trusted-consent+jws" ||
    header.alg !== "Ed25519" ||
    typeof header.kid !== "string" ||
    header.kid.length === 0
  ) {
    throw new Error("invalid trusted consent receipt profile");
  }
  const matchingKeys = trust.trustedKeys.filter((key) => key.kid === header.kid);
  if (matchingKeys.length !== 1) throw new Error("trusted consent key is not uniquely trusted");
  const key = matchingKeys[0];
  if (
    !key ||
    key.kty !== "OKP" ||
    key.crv !== "Ed25519" ||
    key.alg !== "Ed25519" ||
    key.use !== "sig" ||
    JSON.stringify(key.key_ops) !== '["verify"]'
  ) {
    throw new Error("invalid trusted consent verification key");
  }
  const cryptoKey = await crypto.subtle.importKey("jwk", key, "Ed25519", false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "Ed25519",
    cryptoKey,
    Uint8Array.from(decodeBase64Url(compact.signature)).buffer,
    new TextEncoder().encode(compact.signingInput),
  );
  if (!valid) throw new Error("invalid trusted consent receipt signature");

  const claims = objectRecord(decodeJson(compact.payload), "trusted consent claims");
  const webauthn = objectRecord(claims.webauthn, "trusted consent WebAuthn result");
  assertExactKeys(claims, [
    "authority_origin",
    "bwg_version",
    "challenge_id",
    "disclosure_digest_sha256",
    "exp",
    "iat",
    "iss",
    "jti",
    "pool_offer_set_signature_sha256",
    "reason",
    "webauthn",
  ], "trusted consent claims");
  assertExactKeys(
    webauthn,
    ["attestation", "user_present", "user_verified"],
    "trusted consent WebAuthn result",
  );
  if (
    claims.iss !== trust.issuer ||
    typeof claims.jti !== "string" ||
    !/^ceremony_[A-Za-z0-9_]+$/u.test(claims.jti) ||
    claims.challenge_id !== request.challengeId ||
    claims.disclosure_digest_sha256 !== request.disclosureDigestSha256 ||
    claims.pool_offer_set_signature_sha256 !== request.poolOfferSetSignatureSha256 ||
    claims.reason !== request.reason ||
    claims.authority_origin !== request.authorityOrigin ||
    claims.bwg_version !== "BWG/0.1"
  ) {
    throw new Error("trusted consent receipt does not match the disclosed work");
  }
  if (
    webauthn.user_present !== true ||
    webauthn.user_verified !== true ||
    webauthn.attestation !== "trusted_non_self"
  ) {
    throw new Error("trusted consent receipt lacks required WebAuthn assurances");
  }
  if (
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    !Number.isSafeInteger(nowUnixSeconds) ||
    (claims.iat as number) > nowUnixSeconds ||
    (claims.iat as number) >= (claims.exp as number) ||
    (claims.exp as number) <= nowUnixSeconds ||
    (claims.exp as number) !== request.expiresAtUnixSeconds
  ) {
    throw new Error("trusted consent receipt is stale or outside the challenge lifetime");
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function parseCompactJws(value: string): {
  protectedHeader: string;
  payload: string;
  signature: string;
  signingInput: string;
} {
  if (value.length > MAXIMUM_COMPACT_RECEIPT_LENGTH) {
    throw new Error("trusted consent receipt is malformed");
  }
  const [protectedHeader, payload, signature, extra] = value.split(".");
  if (!protectedHeader || !payload || !signature || extra !== undefined) {
    throw new Error("trusted consent receipt is malformed");
  }
  return {
    protectedHeader,
    payload,
    signature,
    signingInput: `${protectedHeader}.${payload}`,
  };
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
  } catch (error) {
    if (error instanceof Error) throw new Error("trusted consent receipt is malformed");
    throw error;
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("trusted consent receipt is malformed");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch (error) {
    if (error instanceof DOMException) throw new Error("trusted consent receipt is malformed");
    throw error;
  }
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
