const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export async function runCryptoConformance(vectors) {
  assertEqual(vectors.profile, "BWG/0.1", "unexpected_profile");
  assertEqual(vectors.algorithms.gate_pass_jws, "Ed25519", "unexpected_gate_pass_alg");
  assertEqual(vectors.algorithms.browser_dpop_jws, "ES256", "unexpected_dpop_alg");

  const overlapKeys = trustedKeys(vectors, "overlap");
  for (const gatePass of vectors.gate_passes) {
    const verified = await verifyGatePass(gatePass.compact_jws, overlapKeys);
    assertEqual(verified.kid, gatePass.kid, `${gatePass.id}:kid`);
    assertEqual(verified.claims.cnf.jkt, gatePass.claimant_jkt, `${gatePass.id}:jkt`);
    assertEqual(
      await accessTokenHash(gatePass.compact_jws),
      gatePass.access_token_hash,
      `${gatePass.id}:ath`,
    );
  }

  for (const rotationCase of vectors.rotation_cases) {
    const gatePass = requiredById(
      vectors.gate_passes,
      rotationCase.gate_pass_id,
      "missing_gate_pass",
    );
    const keys = trustedKeys(vectors, rotationCase.jwks_snapshot_id);
    const actual = await outcome(() => verifyGatePass(gatePass.compact_jws, keys));
    assertEqual(actual, rotationCase.expected, `${gatePass.id}:rotation`);
  }

  const authorityB = requiredById(vectors.authority_keys, "authority-b", "missing_authority_b");
  for (const negativeCase of vectors.algorithm_negative_cases) {
    const key = {
      ...authorityB,
      alg: negativeCase.key_alg_override ?? authorityB.alg,
    };
    const actual = await outcome(() => verifyGatePass(negativeCase.compact_jws, [key]));
    assertEqual(actual, negativeCase.expected_error, negativeCase.id);
  }

  const claimantJkt = await p256JwkThumbprint(vectors.claimant_public_jwk);
  assertEqual(claimantJkt, vectors.claimant_jkt, "claimant_jkt");
  const verifiedDpop = await verifyDpop(vectors.dpop.compact_jws, vectors.dpop.access_token);
  assertEqual(verifiedDpop.jkt, vectors.dpop.jkt, "dpop_jkt");
  assertEqual(verifiedDpop.ath, vectors.dpop.ath, "dpop_ath");

  const keyExtractability = await proveNonExtractableClaimantKey();

  return {
    gatePassesVerified: vectors.gate_passes.length,
    rotationCasesVerified: vectors.rotation_cases.length,
    algorithmFailuresVerified: vectors.algorithm_negative_cases.length,
    dpopVerified: true,
    ...keyExtractability,
  };
}

async function verifyGatePass(compactJws, keys) {
  const compact = parseCompactJws(compactJws);
  const header = decodeJson(compact.protectedHeader);
  assertEqual(header.typ, "bwg-gate-pass+jwt", "invalid_gate_pass_type");
  validateGatePassAlgorithm(header.alg);

  const maybeKey = keys.find((key) => key.kid === header.kid);
  if (!maybeKey) {
    throw new Error("unknown_kid");
  }
  validateAuthorityKey(maybeKey, header.alg);

  const cryptoKey = await crypto.subtle.importKey("jwk", maybeKey, "Ed25519", false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "Ed25519",
    cryptoKey,
    decodeBase64Url(compact.signature),
    textEncoder.encode(compact.signingInput),
  );
  if (!valid) {
    throw new Error("invalid_signature");
  }

  const claims = decodeJson(compact.payload);
  if (
    !nonEmptyStrings(
      claims.iss,
      claims.aud,
      claims.jti,
      claims.challenge_id,
      claims.action_reference,
      claims.cnf?.jkt,
    ) ||
    claims.bwg_version !== "BWG/0.1" ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.iat >= claims.exp
  ) {
    throw new Error("invalid_claimant_confirmation");
  }

  return { kid: header.kid, claims };
}

async function verifyDpop(compactJws, accessToken) {
  const compact = parseCompactJws(compactJws);
  const header = decodeJson(compact.protectedHeader);
  assertEqual(header.typ, "dpop+jwt", "invalid_dpop_type");
  assertEqual(header.alg, "ES256", "unknown_algorithm");
  validateP256PublicJwk(header.jwk);

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    header.jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    decodeBase64Url(compact.signature),
    textEncoder.encode(compact.signingInput),
  );
  if (!valid) {
    throw new Error("invalid_signature");
  }

  const claims = decodeJson(compact.payload);
  if (
    !nonEmptyStrings(claims.jti, claims.htm, claims.htu, claims.ath) ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat <= 0
  ) {
    throw new Error("invalid_dpop_claims");
  }
  const ath = await accessTokenHash(accessToken);
  assertEqual(claims.ath, ath, "access_token_hash_mismatch");

  return { ath, jkt: await p256JwkThumbprint(header.jwk) };
}

async function proveNonExtractableClaimantKey() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  assertEqual(keyPair.privateKey.extractable, false, "private_key_extractable");
  assertEqual(keyPair.publicKey.extractable, true, "public_key_not_extractable");

  let privateExportRejected = false;
  try {
    await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  } catch (error) {
    if (error.name !== "InvalidAccessError") {
      throw error;
    }
    privateExportRejected = true;
  }
  assertEqual(privateExportRejected, true, "private_key_export_succeeded");

  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  assertEqual(Object.hasOwn(publicJwk, "d"), false, "public_jwk_contains_private_key");

  return {
    claimantPrivateKeyExtractable: keyPair.privateKey.extractable,
    claimantPublicKeyExtractable: keyPair.publicKey.extractable,
  };
}

async function p256JwkThumbprint(jwk) {
  validateP256PublicJwk(jwk);
  const canonical = JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y });
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(canonical));
  return encodeBase64Url(new Uint8Array(digest));
}

async function accessTokenHash(accessToken) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(accessToken));
  return encodeBase64Url(new Uint8Array(digest));
}

function validateGatePassAlgorithm(algorithm) {
  if (algorithm === "Ed25519") return;
  if (algorithm === "none") throw new Error("unsecured_algorithm");
  if (["HS256", "HS384", "HS512"].includes(algorithm)) {
    throw new Error("symmetric_algorithm");
  }
  if (algorithm === "EdDSA") throw new Error("deprecated_algorithm");
  throw new Error("unknown_algorithm");
}

function validateAuthorityKey(key, algorithm) {
  if (key.alg !== algorithm) throw new Error("algorithm_key_mismatch");
  if (
    key.kty !== "OKP" ||
    key.crv !== "Ed25519" ||
    key.use !== "sig" ||
    JSON.stringify(key.key_ops) !== '["verify"]'
  ) {
    throw new Error("invalid_authority_key");
  }
}

function validateP256PublicJwk(jwk) {
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || Object.hasOwn(jwk, "d")) {
    throw new Error("invalid_claimant_key");
  }
  if (decodeBase64Url(jwk.x).length !== 32 || decodeBase64Url(jwk.y).length !== 32) {
    throw new Error("invalid_claimant_key");
  }
}

function trustedKeys(vectors, snapshotId) {
  const snapshot = requiredById(vectors.jwks_snapshots, snapshotId, "missing_jwks_snapshot");
  return vectors.authority_keys.filter((key) => snapshot.accepted_kids.includes(key.kid));
}

function requiredById(values, id, errorCode) {
  const maybeValue = values.find((value) => value.id === id || value.kid === id);
  if (!maybeValue) throw new Error(errorCode);
  return maybeValue;
}

async function outcome(operation) {
  try {
    await operation();
    return "valid";
  } catch (error) {
    return error.message;
  }
}

function parseCompactJws(value) {
  const segments = value.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new Error("malformed_jws");
  }
  const [protectedHeader, payload, signature] = segments;
  return {
    protectedHeader,
    payload,
    signature,
    signingInput: `${protectedHeader}.${payload}`,
  };
}

function decodeJson(value) {
  return JSON.parse(textDecoder.decode(decodeBase64Url(value)));
}

function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function assertEqual(actual, expected, code) {
  if (actual !== expected) {
    throw new Error(`${code}: expected ${expected}, received ${actual}`);
  }
}

function nonEmptyStrings(...values) {
  return values.every((value) => typeof value === "string" && value.length > 0);
}
