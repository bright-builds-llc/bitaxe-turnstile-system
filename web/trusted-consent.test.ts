import { describe, expect, test } from "bun:test";

import {
  TrustedConsentRequiredError,
  createHeadlessClient,
  type HeadlessClientInput,
  type TrustedConsentRequest,
} from "./headless-client";
import { headlessInput, transportHarness } from "./headless-client.test-support";

describe("Authority-origin trusted consent", () => {
  test("Elevated work cannot record consent without an Authority receipt", async () => {
    // Arrange
    const harness = transportHarness();
    const elevated = await trustedInput(await headlessInput(harness.transport, {
      maybeClaimantWorkCeiling: "70368744177664",
    }));
    const client = await createHeadlessClient(elevated.input);

    // Act
    const consent = client.grantConsent();

    // Assert
    await expect(consent).rejects.toBeInstanceOf(TrustedConsentRequiredError);
    expect(client.trustedConsentRequest()?.reason).toBe("elevated_work");
    expect(harness.calls).toEqual([]);
  });

  test("a current UP-UV attested Authority receipt permits Elevated Start", async () => {
    // Arrange
    const harness = transportHarness();
    const elevated = await trustedInput(await headlessInput(harness.transport, {
      maybeClaimantWorkCeiling: "70368744177664",
    }));
    const client = await createHeadlessClient(elevated.input);
    const request = client.trustedConsentRequest();
    if (!request) throw new Error("Elevated work must publish a trusted-consent request");
    const receipt = await elevated.signReceipt(request);

    // Act
    const consent = await client.grantConsent(receipt);
    await client.start();

    // Assert
    expect(consent.maybeTrustedConsentReceipt).toBe(receipt);
    expect(harness.calls).toEqual(["start"]);
  });

  test("signed material Pool Offer changes also require trusted confirmation", async () => {
    // Arrange
    const harness = transportHarness();
    const changedTerms = await trustedInput(
      await headlessInput(harness.transport),
      { maybeElevated: false },
    );
    const client = await createHeadlessClient(changedTerms.input);

    // Act
    const consent = client.grantConsent();

    // Assert
    await expect(consent).rejects.toBeInstanceOf(TrustedConsentRequiredError);
    expect(client.trustedConsentRequest()?.reason).toBe("material_pool_terms");
  });

  test("an origin-mismatched receipt fails before Start", async () => {
    // Arrange
    const harness = transportHarness();
    const elevated = await trustedInput(await headlessInput(harness.transport, {
      maybeClaimantWorkCeiling: "70368744177664",
    }));
    const client = await createHeadlessClient(elevated.input);
    const request = requiredRequest(client.trustedConsentRequest());
    const receipt = await elevated.signReceipt(request, {
      maybeAuthorityOrigin: "https://evil.example",
    });

    // Act
    const consent = client.grantConsent(receipt);

    // Assert
    await expect(consent).rejects.toThrow(
      "trusted consent receipt does not match the disclosed work",
    );
    expect(harness.calls).toEqual([]);
  });

  test("a stale receipt fails before Start", async () => {
    // Arrange
    const harness = transportHarness();
    const elevated = await trustedInput(await headlessInput(harness.transport, {
      maybeClaimantWorkCeiling: "70368744177664",
    }));
    const client = await createHeadlessClient(elevated.input);
    const request = requiredRequest(client.trustedConsentRequest());
    const receipt = await elevated.signReceipt(request, { maybeExpiresAtUnixSeconds: 1_000 });

    // Act
    const consent = client.grantConsent(receipt);

    // Assert
    await expect(consent).rejects.toThrow("trusted consent receipt is stale");
    expect(harness.calls).toEqual([]);
  });

  test("a receipt without user presence fails before Start", async () => {
    // Arrange
    const harness = transportHarness();
    const elevated = await trustedInput(await headlessInput(harness.transport, {
      maybeClaimantWorkCeiling: "70368744177664",
    }));
    const client = await createHeadlessClient(elevated.input);
    const request = requiredRequest(client.trustedConsentRequest());
    const receipt = await elevated.signReceipt(request, {
      maybeWebauthn: {
        user_present: false,
        user_verified: true,
        attestation: "trusted_non_self",
      },
    });

    // Act
    const consent = client.grantConsent(receipt);

    // Assert
    await expect(consent).rejects.toThrow("lacks required WebAuthn assurances");
    expect(harness.calls).toEqual([]);
  });

  test("a receipt without user verification fails before Start", async () => {
    // Arrange
    const harness = transportHarness();
    const elevated = await trustedInput(await headlessInput(harness.transport, {
      maybeClaimantWorkCeiling: "70368744177664",
    }));
    const client = await createHeadlessClient(elevated.input);
    const request = requiredRequest(client.trustedConsentRequest());
    const receipt = await elevated.signReceipt(request, {
      maybeWebauthn: {
        user_present: true,
        user_verified: false,
        attestation: "trusted_non_self",
      },
    });

    // Act
    const consent = client.grantConsent(receipt);

    // Assert
    await expect(consent).rejects.toThrow("lacks required WebAuthn assurances");
    expect(harness.calls).toEqual([]);
  });

  test("a receipt without trusted non-self attestation fails before Start", async () => {
    // Arrange
    const harness = transportHarness();
    const elevated = await trustedInput(await headlessInput(harness.transport, {
      maybeClaimantWorkCeiling: "70368744177664",
    }));
    const client = await createHeadlessClient(elevated.input);
    const request = requiredRequest(client.trustedConsentRequest());
    const receipt = await elevated.signReceipt(request, {
      maybeWebauthn: {
        user_present: true,
        user_verified: true,
        attestation: "self",
      },
    });

    // Act
    const consent = client.grantConsent(receipt);

    // Assert
    await expect(consent).rejects.toThrow("lacks required WebAuthn assurances");
    expect(harness.calls).toEqual([]);
  });

  test("a receipt with the wrong JWS profile fails before Start", async () => {
    // Arrange
    const harness = transportHarness();
    const elevated = await trustedInput(await headlessInput(harness.transport, {
      maybeClaimantWorkCeiling: "70368744177664",
    }));
    const client = await createHeadlessClient(elevated.input);
    const request = requiredRequest(client.trustedConsentRequest());
    const receipt = await elevated.signReceipt(request, { maybeType: "bwg-gate-pass+jwt" });

    // Act
    const consent = client.grantConsent(receipt);

    // Assert
    await expect(consent).rejects.toThrow("invalid trusted consent receipt profile");
    expect(harness.calls).toEqual([]);
  });

  test("a receipt from an untrusted key fails before Start", async () => {
    // Arrange
    const harness = transportHarness();
    const elevated = await trustedInput(await headlessInput(harness.transport, {
      maybeClaimantWorkCeiling: "70368744177664",
    }));
    const client = await createHeadlessClient(elevated.input);
    const request = requiredRequest(client.trustedConsentRequest());
    const receipt = await elevated.signReceipt(request, { maybeKid: "untrusted-authority" });

    // Act
    const consent = client.grantConsent(receipt);

    // Assert
    await expect(consent).rejects.toThrow("key is not uniquely trusted");
    expect(harness.calls).toEqual([]);
  });

  test("a receipt matching an invalid JWK profile fails before Start", async () => {
    // Arrange
    const harness = transportHarness();
    const elevated = await trustedInput(await headlessInput(harness.transport, {
      maybeClaimantWorkCeiling: "70368744177664",
    }));
    const trustedKey = elevated.input.authorityTrust.trustedKeys[0];
    if (!trustedKey) throw new Error("trusted Authority key is missing");
    elevated.input.authorityTrust.trustedKeys = [
      trustedKey,
      { ...trustedKey, kid: "invalid-profile", kty: "EC" },
    ];
    const client = await createHeadlessClient(elevated.input);
    const request = requiredRequest(client.trustedConsentRequest());
    const receipt = await elevated.signReceipt(request, { maybeKid: "invalid-profile" });

    // Act
    const consent = client.grantConsent(receipt);

    // Assert
    await expect(consent).rejects.toThrow("invalid trusted consent verification key");
    expect(harness.calls).toEqual([]);
  });

  test("a receipt with a forged signature fails before Start", async () => {
    // Arrange
    const harness = transportHarness();
    const elevated = await trustedInput(await headlessInput(harness.transport, {
      maybeClaimantWorkCeiling: "70368744177664",
    }));
    const client = await createHeadlessClient(elevated.input);
    const request = requiredRequest(client.trustedConsentRequest());
    const receipt = await elevated.signReceipt(request);
    const [protectedHeader, payload, signature] = receipt.split(".");
    if (!protectedHeader || !payload || !signature) throw new Error("receipt fixture is malformed");
    const forged = `${protectedHeader}.${payload}.${signature.startsWith("A") ? "B" : "A"}${
      signature.slice(1)
    }`;

    // Act
    const consent = client.grantConsent(forged);

    // Assert
    await expect(consent).rejects.toThrow("invalid trusted consent receipt signature");
    expect(harness.calls).toEqual([]);
  });

  test("a receipt for another challenge fails before Start", async () => {
    // Arrange
    const harness = transportHarness();
    const elevated = await trustedInput(await headlessInput(harness.transport, {
      maybeClaimantWorkCeiling: "70368744177664",
    }));
    const client = await createHeadlessClient(elevated.input);
    const request = requiredRequest(client.trustedConsentRequest());
    const receipt = await elevated.signReceipt(request, {
      maybeChallengeId: "challenge_other_01",
    });

    // Act
    const consent = client.grantConsent(receipt);

    // Assert
    await expect(consent).rejects.toThrow("does not match the disclosed work");
    expect(harness.calls).toEqual([]);
  });

  test("a malformed compact receipt fails before Start", async () => {
    // Arrange
    const testCase = await receiptCase("not-a-jws");
    // Act / Assert
    await expect(testCase.consent).rejects.toThrow("receipt is malformed");
    expect(testCase.calls).toEqual([]);
  });

  test("invalid receipt base64url fails before Start", async () => {
    // Arrange
    const testCase = await receiptCase("!!.payload.signature");
    // Act / Assert
    await expect(testCase.consent).rejects.toThrow("receipt is malformed");
    expect(testCase.calls).toEqual([]);
  });

  test("invalid receipt JSON fails before Start", async () => {
    // Arrange
    const invalidHeader = encodeBase64Url(new TextEncoder().encode("not-json"));
    const testCase = await receiptCase(`${invalidHeader}.payload.signature`);
    // Act / Assert
    await expect(testCase.consent).rejects.toThrow("receipt is malformed");
    expect(testCase.calls).toEqual([]);
  });

  test("an unknown protected header fails before Start", async () => {
    // Arrange
    const testCase = await receiptCase({ maybeHeaderFields: { crit: ["future"] } });
    // Act / Assert
    await expect(testCase.consent).rejects.toThrow("header has unknown or missing fields");
    expect(testCase.calls).toEqual([]);
  });

  test("an unknown receipt claim fails before Start", async () => {
    // Arrange
    const testCase = await receiptCase({ maybeAdditionalClaims: { future: true } });
    // Act / Assert
    await expect(testCase.consent).rejects.toThrow("claims has unknown or missing fields");
    expect(testCase.calls).toEqual([]);
  });

  test("an issuer-mismatched receipt fails before Start", async () => {
    // Arrange
    const testCase = await receiptCase({ maybeIssuer: "https://other.example" });
    // Act / Assert
    await expect(testCase.consent).rejects.toThrow("does not match the disclosed work");
    expect(testCase.calls).toEqual([]);
  });

  test("an invalid receipt identifier fails before Start", async () => {
    // Arrange
    const testCase = await receiptCase({ maybeJti: "not-a-ceremony" });
    // Act / Assert
    await expect(testCase.consent).rejects.toThrow("does not match the disclosed work");
    expect(testCase.calls).toEqual([]);
  });

  test("a disclosure-mismatched receipt fails before Start", async () => {
    // Arrange
    const testCase = await receiptCase({ maybeDisclosureDigestSha256: "Z".repeat(43) });
    // Act / Assert
    await expect(testCase.consent).rejects.toThrow("does not match the disclosed work");
    expect(testCase.calls).toEqual([]);
  });

  test("a Pool Offer-mismatched receipt fails before Start", async () => {
    // Arrange
    const testCase = await receiptCase({ maybePoolOfferSetSignatureSha256: "Z".repeat(43) });
    // Act / Assert
    await expect(testCase.consent).rejects.toThrow("does not match the disclosed work");
    expect(testCase.calls).toEqual([]);
  });

  test("a reason-mismatched receipt fails before Start", async () => {
    // Arrange
    const testCase = await receiptCase({ maybeReason: "material_pool_terms" });
    // Act / Assert
    await expect(testCase.consent).rejects.toThrow("does not match the disclosed work");
    expect(testCase.calls).toEqual([]);
  });

  test("a future-issued receipt fails before Start", async () => {
    // Arrange
    const testCase = await receiptCase({ maybeIssuedAtUnixSeconds: 1_001 });
    // Act / Assert
    await expect(testCase.consent).rejects.toThrow("receipt is stale");
    expect(testCase.calls).toEqual([]);
  });

  test("a receipt whose expiry differs from the challenge fails before Start", async () => {
    // Arrange
    const testCase = await receiptCase({ maybeExpiresAtUnixSeconds: 1_500 });
    // Act / Assert
    await expect(testCase.consent).rejects.toThrow("receipt is stale");
    expect(testCase.calls).toEqual([]);
  });
});

type ReceiptOverrides = {
  maybeAuthorityOrigin?: string;
  maybeChallengeId?: string;
  maybeDisclosureDigestSha256?: string;
  maybeExpiresAtUnixSeconds?: number;
  maybeIssuer?: string;
  maybeIssuedAtUnixSeconds?: number;
  maybeJti?: string;
  maybeKid?: string;
  maybeAdditionalClaims?: Record<string, unknown>;
  maybeHeaderFields?: Record<string, unknown>;
  maybePoolOfferSetSignatureSha256?: string;
  maybeReason?: string;
  maybeType?: string;
  maybeWebauthn?: Record<string, unknown>;
};

async function receiptCase(
  receiptOrOverrides: string | ReceiptOverrides,
): Promise<{ consent: Promise<unknown>; calls: string[] }> {
  const harness = transportHarness();
  const elevated = await trustedInput(await headlessInput(harness.transport, {
    maybeClaimantWorkCeiling: "70368744177664",
  }));
  const client = await createHeadlessClient(elevated.input);
  const request = requiredRequest(client.trustedConsentRequest());
  const receipt = typeof receiptOrOverrides === "string"
    ? receiptOrOverrides
    : await elevated.signReceipt(request, receiptOrOverrides);
  return { consent: client.grantConsent(receipt), calls: harness.calls };
}

async function trustedInput(
  input: HeadlessClientInput,
  options: { maybeElevated?: boolean } = {},
): Promise<{
  input: HeadlessClientInput;
  signReceipt(request: TrustedConsentRequest, maybeOverrides?: ReceiptOverrides): Promise<string>;
}> {
  const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const kid = "trusted-consent-test-authority";
  if (options.maybeElevated !== false) {
    input.challenge.actionPolicy = "account-creation.elevated.v1";
    input.challenge.expectedHashes = "70368744177664";
  }
  input.challenge.trustedConsentDisclosureDigestSha256 = "A".repeat(43);
  const [, encodedPayload] = input.signedPoolOfferSet.signature.split(".");
  if (!encodedPayload) throw new Error("test Pool Offer signature is malformed");
  const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload))) as Record<
    string,
    unknown
  >;
  claims.action_policy = input.challenge.actionPolicy;
  claims.trusted_confirmation_required = true;
  input.authorityTrust.trustedKeys = [{
    ...publicJwk,
    kid,
    alg: "Ed25519",
    use: "sig",
    key_ops: ["verify"],
  }];
  input.signedPoolOfferSet.signature = await signJws(
    "bwg-pool-offer-set+jws",
    kid,
    claims,
    keyPair.privateKey,
  );
  return {
    input,
    signReceipt: (request, maybeOverrides = {}) => signJws(
      maybeOverrides.maybeType ?? "bwg-trusted-consent+jws",
      maybeOverrides.maybeKid ?? kid,
      {
        iss: maybeOverrides.maybeIssuer ?? input.authorityTrust.issuer,
        jti: maybeOverrides.maybeJti ?? "ceremony_browser_receipt_01",
        challenge_id: maybeOverrides.maybeChallengeId ?? request.challengeId,
        disclosure_digest_sha256:
          maybeOverrides.maybeDisclosureDigestSha256 ?? request.disclosureDigestSha256,
        pool_offer_set_signature_sha256:
          maybeOverrides.maybePoolOfferSetSignatureSha256 ?? request.poolOfferSetSignatureSha256,
        reason: maybeOverrides.maybeReason ?? request.reason,
        authority_origin: maybeOverrides.maybeAuthorityOrigin ?? request.authorityOrigin,
        webauthn: maybeOverrides.maybeWebauthn ?? {
          user_present: true,
          user_verified: true,
          attestation: "trusted_non_self",
        },
        iat: maybeOverrides.maybeIssuedAtUnixSeconds ?? 1_000,
        exp: maybeOverrides.maybeExpiresAtUnixSeconds ?? request.expiresAtUnixSeconds,
        bwg_version: "BWG/0.1",
        ...maybeOverrides.maybeAdditionalClaims,
      },
      keyPair.privateKey,
      maybeOverrides.maybeHeaderFields,
    ),
  };
}

function requiredRequest(
  maybeRequest: TrustedConsentRequest | undefined,
): TrustedConsentRequest {
  if (!maybeRequest) throw new Error("trusted-consent request is missing");
  return maybeRequest;
}

async function signJws(
  type: string,
  kid: string,
  claims: Record<string, unknown>,
  privateKey: CryptoKey,
  maybeHeaderFields: Record<string, unknown> = {},
): Promise<string> {
  const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({
    alg: "Ed25519",
    kid,
    typ: type,
    ...maybeHeaderFields,
  })));
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function encodeBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
