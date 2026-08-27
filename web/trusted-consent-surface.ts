import type {
  AuthorityTrustInput,
  PoolOfferDisclosure,
  SignedPoolOfferSetInput,
  TrustedConsentReason,
  WorkChallengeInput,
} from "./headless-client.types";
import { verifyPoolOfferSet } from "./headless-pool-offer";
import { sha256Base64Url } from "./headless-values";

type LoadedChallenge = {
  challenge: Record<string, unknown>;
  issuer: string;
  jwks: { keys: AuthorityTrustInput["trustedKeys"] };
  material_confirmation?: {
    signed_pool_offers: unknown;
    disclosure_digest_sha256: unknown;
  };
};

const query = new URL(location.href).searchParams;
const state = required(query, "state");
const openerOrigin = required(query, "opener_origin");
const maybeStatus = document.querySelector("#status");
const maybeTerms = document.querySelector("#terms");

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (maybeStatus) maybeStatus.textContent = message;
  opener?.postMessage({
    type: "bwg_trusted_consent_result",
    state,
    maybeError: message,
  }, openerOrigin);
});

async function run(): Promise<void> {
  const challengeId = required(query, "challenge_id");
  const reason = trustedConsentReason(required(query, "reason"));
  const disclosureDigest = required(query, "disclosure_digest");
  const poolOfferSetSignatureDigest = required(query, "pool_offer_set_signature_digest");
  const loaded = await fetchJson<LoadedChallenge>(
    `/v0/challenges/${challengeId}/trusted-consent?pool_offer_set_signature_sha256=${poolOfferSetSignatureDigest}`,
  );
  const challenge = workChallenge(loaded.challenge);
  if (
    !Array.isArray(loaded.challenge.allowed_origins) ||
    !loaded.challenge.allowed_origins.includes(openerOrigin)
  ) {
    throw new Error("opener origin is not allowed for this Work Challenge");
  }
  const maybeMaterial = loaded.material_confirmation;
  if (reason === "material_pool_terms" && !maybeMaterial) {
    throw new Error("material Pool Offer confirmation is unavailable");
  }
  const signedPoolOfferSet = signedOffers(
    reason === "material_pool_terms"
      ? record(maybeMaterial, "material confirmation").signed_pool_offers
      : loaded.challenge.pool_offers,
  );
  const authorityTrust: AuthorityTrustInput = {
    issuer: loaded.issuer,
    trustedKeys: loaded.jwks.keys,
  };
  const verifiedOffers = await verifyPoolOfferSet(
    signedPoolOfferSet,
    challenge,
    authorityTrust,
  );
  if (!verifiedOffers.trustedConfirmationRequired) {
    throw new Error("Authority challenge does not require trusted confirmation");
  }
  const request = {
    reason,
    authorityOrigin: location.origin,
    challengeId,
    disclosureDigestSha256: disclosureDigest,
    poolOfferSetSignatureSha256: poolOfferSetSignatureDigest,
    expiresAtUnixSeconds: challenge.expiresAtUnixSeconds,
  };
  if (
    challenge.challengeId !== request.challengeId ||
    (reason === "material_pool_terms"
      ? requiredString(maybeMaterial?.disclosure_digest_sha256, "material disclosure digest")
      : challenge.trustedConsentDisclosureDigestSha256) !== request.disclosureDigestSha256 ||
    request.poolOfferSetSignatureSha256 !== await sha256Base64Url(signedPoolOfferSet.signature) ||
    (request.reason === "material_pool_terms" &&
      verifiedOffers.maybeMaterialReplacementDigestSha256 !== request.disclosureDigestSha256) ||
    (request.reason === "elevated_work" &&
      challenge.actionPolicy !== "account-creation.elevated.v1")
  ) {
    throw new Error("trusted surface terms do not match the opener request");
  }
  if (maybeTerms) {
    maybeTerms.textContent = JSON.stringify({
      challengeId,
      actionPolicy: challenge.actionPolicy,
      expectedHashes: challenge.expectedHashes,
      poolOffers: verifiedOffers.offers,
      expiresAtUnixSeconds: challenge.expiresAtUnixSeconds,
    }, null, 2);
  }
  if (maybeStatus) maybeStatus.textContent = "Touch and verify with an approved authenticator.";
  const begin = await postJson<Record<string, unknown>>(
    `/v0/challenges/${challengeId}/trusted-consent`,
    {
      pool_offer_set_signature_sha256: request.poolOfferSetSignatureSha256,
      reason: request.reason,
      authority_origin: request.authorityOrigin,
    },
  );
  if (begin.authority_disclosure_digest_sha256 !== request.disclosureDigestSha256) {
    throw new Error("Authority disclosure digest changed during confirmation");
  }
  const publicKeyEnvelope = record(begin.public_key, "WebAuthn public key envelope");
  const publicKey = decodeCreationOptions(record(publicKeyEnvelope.publicKey, "WebAuthn options"));
  const credential = await navigator.credentials.create({ publicKey });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("WebAuthn was cancelled");
  const ceremonyId = requiredString(begin.ceremony_id, "ceremony ID");
  const finished = await postJson<Record<string, unknown>>(
    `/v0/challenges/${challengeId}/trusted-consent/${ceremonyId}`,
    credentialJson(credential),
  );
  const receipt = requiredString(finished.trusted_consent_receipt, "Trusted Consent Receipt");
  if (maybeStatus) maybeStatus.textContent = "Trusted confirmation completed.";
  opener?.postMessage({
    type: "bwg_trusted_consent_result",
    state,
    maybeReceipt: receipt,
  }, openerOrigin);
}

function workChallenge(value: Record<string, unknown>): WorkChallengeInput {
  const workRequirement = record(value.work_requirement, "work requirement");
  return {
    challengeId: requiredString(value.challenge_id, "challenge ID"),
    actionPolicy: requiredString(value.action_policy, "action policy"),
    claimantKey: requiredString(value.claimant_key, "claimant key"),
    expectedHashes: requiredString(workRequirement.expected_hashes, "expected hashes"),
    expiresAtUnixSeconds: requiredNumber(value.expires_at_unix_seconds, "challenge expiry"),
    trustedConsentDisclosureDigestSha256: requiredString(
      value.trusted_consent_disclosure_digest_sha256,
      "trusted consent disclosure digest",
    ),
  };
}

function signedOffers(value: unknown): SignedPoolOfferSetInput {
  const wire = record(value, "signed Pool Offers");
  if (!Array.isArray(wire.offers)) throw new Error("signed Pool Offers are invalid");
  return {
    signature: requiredString(wire.signature, "Pool Offer signature"),
    offers: wire.offers.map(normalizeOffer),
  };
}

function normalizeOffer(value: unknown): PoolOfferDisclosure {
  const offer = record(value, "Pool Offer");
  const reward = record(offer.reward_policy, "Reward Policy");
  const payout = record(offer.payout_requirements, "Payout Requirements");
  if (!Array.isArray(payout.approved_beneficiaries)) {
    throw new Error("approved beneficiaries are invalid");
  }
  return {
    offerId: requiredString(offer.offer_id, "offer ID"),
    miningPool: normalizeComponent(offer.mining_pool),
    poolAdapter: normalizeComponent(offer.pool_adapter),
    miningTransport: exactString(offer.mining_transport, "stratum_v1", "mining transport"),
    endpoint: requiredString(offer.endpoint, "Pool endpoint"),
    rewardPolicy: {
      mode: exactString(reward.mode, "solo_direct_coinbase", "reward mode"),
      selectedDestinationBasisPoints: requiredNumber(
        reward.selected_destination_basis_points,
        "selected destination basis points",
      ),
      poolFeeBasisPoints: requiredNumber(reward.pool_fee_basis_points, "pool fee basis points"),
      serviceFeeBasisPoints: requiredNumber(
        reward.service_fee_basis_points,
        "service fee basis points",
      ),
      acceptedWorkCreatesRevenueClaim: exactBoolean(
        reward.accepted_work_creates_revenue_claim,
        false,
        "accepted-work revenue claim",
      ),
      createsCustodialBalance: exactBoolean(
        reward.creates_custodial_balance,
        false,
        "custodial balance",
      ),
      networkValidResult: exactString(
        reward.network_valid_result,
        "direct_coinbase_payout",
        "network-valid result",
      ),
    },
    payoutRequirements: {
      selectionRequired: exactBoolean(
        payout.selection_required,
        true,
        "payout selection requirement",
      ),
      ephemeralByDefault: exactBoolean(
        payout.ephemeral_by_default,
        true,
        "ephemeral payout default",
      ),
      acceptedDestinationTypes: acceptedDestinationTypes(payout.accepted_destination_types),
      approvedBeneficiaries: payout.approved_beneficiaries.map((candidate) => {
        const beneficiary = record(candidate, "approved beneficiary");
        return {
          beneficiaryId: requiredString(beneficiary.beneficiary_id, "beneficiary ID"),
          displayName: requiredString(beneficiary.display_name, "beneficiary display name"),
          termsUrl: requiredString(beneficiary.terms_url, "beneficiary terms URL"),
        };
      }),
    },
    privacyTermsUrl: requiredString(offer.privacy_terms_url, "privacy terms URL"),
    operatorTermsUrl: requiredString(offer.operator_terms_url, "operator terms URL"),
  };
}

function normalizeComponent(value: unknown) {
  const component = record(value, "component identity");
  return {
    componentId: requiredString(component.component_id, "component ID"),
    displayName: requiredString(component.display_name, "component display name"),
    version: requiredString(component.version, "component version"),
    sourceUrl: requiredString(component.source_url, "component source URL"),
    license: requiredString(component.license, "component license"),
  };
}

function decodeCreationOptions(value: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  const rp = record(value.rp, "WebAuthn RP");
  const user = record(value.user, "WebAuthn user");
  if (!Array.isArray(value.pubKeyCredParams)) {
    throw new Error("WebAuthn algorithms are invalid");
  }
  const pubKeyCredParams = value.pubKeyCredParams.map((candidate) => {
    const parameter = record(candidate, "WebAuthn algorithm");
    if (parameter.type !== "public-key") throw new Error("WebAuthn credential type is invalid");
    return {
      type: "public-key" as const,
      alg: requiredNumber(parameter.alg, "WebAuthn algorithm ID"),
    };
  });
  const maybeExcludeCredentials = Array.isArray(value.excludeCredentials)
    ? value.excludeCredentials.map((candidate) => {
        const item = record(candidate, "excluded credential");
        if (item.type !== "public-key") throw new Error("excluded credential type is invalid");
        return {
          type: "public-key" as const,
          id: decodeBase64UrlBuffer(requiredString(item.id, "credential ID")),
        };
      })
    : undefined;
  const maybeTimeout = value.timeout === undefined
    ? undefined
    : requiredNumber(value.timeout, "WebAuthn timeout");
  const maybeAttestation = maybeAttestationPreference(value.attestation);
  const maybeAuthenticatorSelection = value.authenticatorSelection === undefined
    ? undefined
    : selectionCriteria(record(value.authenticatorSelection, "authenticator selection"));
  return {
    rp: {
      id: requiredString(rp.id, "WebAuthn RP ID"),
      name: requiredString(rp.name, "WebAuthn RP name"),
    },
    challenge: decodeBase64UrlBuffer(requiredString(value.challenge, "WebAuthn challenge")),
    user: {
      id: decodeBase64UrlBuffer(requiredString(user.id, "WebAuthn user ID")),
      name: requiredString(user.name, "WebAuthn user name"),
      displayName: requiredString(user.displayName, "WebAuthn display name"),
    },
    pubKeyCredParams,
    ...(maybeTimeout === undefined ? {} : { timeout: maybeTimeout }),
    ...(maybeAttestation === undefined ? {} : { attestation: maybeAttestation }),
    ...(maybeAuthenticatorSelection === undefined
      ? {}
      : { authenticatorSelection: maybeAuthenticatorSelection }),
    ...(maybeExcludeCredentials ? { excludeCredentials: maybeExcludeCredentials } : {}),
  };
}

function maybeAttestationPreference(
  value: unknown,
): AttestationConveyancePreference | undefined {
  if (value === undefined) return undefined;
  if (value === "direct" || value === "enterprise" || value === "indirect" || value === "none") {
    return value;
  }
  throw new Error("WebAuthn attestation preference is invalid");
}

function selectionCriteria(value: Record<string, unknown>): AuthenticatorSelectionCriteria {
  const maybeAttachment = value.authenticatorAttachment;
  const maybeResidentKey = value.residentKey;
  const maybeUserVerification = value.userVerification;
  if (
    maybeAttachment !== undefined &&
    maybeAttachment !== "cross-platform" &&
    maybeAttachment !== "platform"
  ) {
    throw new Error("authenticator attachment is invalid");
  }
  const maybeParsedResidentKey = maybeResidentKey === undefined
    ? undefined
    : preference(maybeResidentKey, "resident-key");
  const maybeParsedUserVerification = maybeUserVerification === undefined
    ? undefined
    : preference(maybeUserVerification, "user-verification");
  return {
    ...(maybeAttachment === undefined ? {} : { authenticatorAttachment: maybeAttachment }),
    ...(maybeParsedResidentKey === undefined ? {} : { residentKey: maybeParsedResidentKey }),
    ...(maybeParsedUserVerification === undefined
      ? {}
      : { userVerification: maybeParsedUserVerification }),
  };
}

function preference(
  value: unknown,
  label: string,
): ResidentKeyRequirement | UserVerificationRequirement {
  if (value === "discouraged" || value === "preferred" || value === "required") return value;
  throw new Error(`${label} preference is invalid`);
}

function credentialJson(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response;
  if (!(response instanceof AuthenticatorAttestationResponse)) {
    throw new Error("WebAuthn registration response is invalid");
  }
  return {
    id: credential.id,
    rawId: encodeBase64Url(new Uint8Array(credential.rawId)),
    type: credential.type,
    response: {
      attestationObject: encodeBase64Url(new Uint8Array(response.attestationObject)),
      clientDataJSON: encodeBase64Url(new Uint8Array(response.clientDataJSON)),
    },
  };
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

function required(parameters: URLSearchParams, name: string): string {
  const maybeValue = parameters.get(name);
  if (!maybeValue) throw new Error(`missing ${name}`);
  return maybeValue;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function trustedConsentReason(value: string): TrustedConsentReason {
  if (value === "elevated_work" || value === "material_pool_terms") return value;
  throw new Error("trusted consent reason is invalid");
}

function exactString<const TValue extends string>(
  value: unknown,
  expected: TValue,
  label: string,
): TValue {
  if (value !== expected) throw new Error(`${label} is invalid`);
  return expected;
}

function exactBoolean<const TValue extends boolean>(
  value: unknown,
  expected: TValue,
  label: string,
): TValue {
  if (value !== expected) throw new Error(`${label} is invalid`);
  return expected;
}

function acceptedDestinationTypes(
  value: unknown,
): readonly ["bitcoin_mainnet_address", "approved_beneficiary"] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] !== "bitcoin_mainnet_address" ||
    value[1] !== "approved_beneficiary"
  ) {
    throw new Error("accepted destination types are invalid");
  }
  return ["bitcoin_mainnet_address", "approved_beneficiary"];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("base64url value is malformed");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function decodeBase64UrlBuffer(value: string): ArrayBuffer {
  const bytes = decodeBase64Url(value);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function encodeBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
