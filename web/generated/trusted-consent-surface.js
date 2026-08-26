// web/headless-values.ts
function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}
function encodeBase64Url(value) {
  let binary = "";
  for (const byte of value)
    binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

// web/headless-pool-offer.ts
async function verifyPoolOfferSet(signed, challenge, trust) {
  if (signed.offers.length === 0)
    throw new Error("Pool Offer set must not be empty");
  if (new Set(signed.offers.map((offer) => offer.offerId)).size !== signed.offers.length) {
    throw new Error("Pool Offer identities must be unique");
  }
  for (const offer of signed.offers)
    validatePoolOffer(offer);
  const compact = parseCompactJws(signed.signature);
  const header = objectRecord(decodeJson(compact.protectedHeader), "Pool Offer header");
  if (Object.hasOwn(header, "crit"))
    throw new Error("unsupported critical header");
  if (header.typ !== "bwg-pool-offer-set+jws" || header.alg !== "Ed25519") {
    throw new Error("invalid Pool Offer signature profile");
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new Error("invalid Pool Offer key ID");
  }
  const matchingKeys = trust.trustedKeys.filter((key2) => key2.kid === header.kid);
  if (matchingKeys.length !== 1)
    throw new Error("Pool Offer key is not uniquely trusted");
  const key = matchingKeys[0];
  if (!key || key.kty !== "OKP" || key.crv !== "Ed25519" || key.alg !== "Ed25519" || key.use !== "sig" || JSON.stringify(key.key_ops) !== '["verify"]') {
    throw new Error("invalid Pool Offer verification key");
  }
  const cryptoKey = await crypto.subtle.importKey("jwk", key, "Ed25519", false, ["verify"]);
  const valid = await crypto.subtle.verify("Ed25519", cryptoKey, Uint8Array.from(decodeBase64Url(compact.signature)).buffer, new TextEncoder().encode(compact.signingInput));
  if (!valid)
    throw new Error("invalid Pool Offer signature");
  const claims = objectRecord(decodeJson(compact.payload), "Pool Offer claims");
  if (claims.iss !== trust.issuer || claims.challenge_id !== challenge.challengeId || claims.action_policy !== challenge.actionPolicy || claims.bwg_version !== "BWG/0.1") {
    throw new Error("signed Pool Offers do not match the Work Challenge");
  }
  const maybeTrustedConfirmationRequired = claims.trusted_confirmation_required;
  if (maybeTrustedConfirmationRequired !== undefined && typeof maybeTrustedConfirmationRequired !== "boolean") {
    throw new Error("signed Pool Offer confirmation requirement is invalid");
  }
  const elevatedPolicy = challenge.actionPolicy === "account-creation.elevated.v1";
  if (elevatedPolicy && maybeTrustedConfirmationRequired !== true) {
    throw new Error("Elevated Pool Offers must require trusted confirmation");
  }
  if (canonicalJson(claims.offers) !== canonicalJson(signed.offers.map(poolOfferToWire))) {
    throw new Error("visible Pool Offers differ from signed claims");
  }
  return {
    authorityKeyId: header.kid,
    offers: signed.offers,
    trustedConfirmationRequired: maybeTrustedConfirmationRequired === true
  };
}
function validatePoolOffer(offer) {
  if (offer.offerId.length === 0 || !validComponent(offer.miningPool) || !validComponent(offer.poolAdapter) || offer.miningTransport !== "stratum_v1" || !validStratumEndpoint(offer.endpoint) || !offer.payoutRequirements.selectionRequired || !offer.payoutRequirements.ephemeralByDefault || offer.payoutRequirements.acceptedDestinationTypes.join(",") !== "bitcoin_mainnet_address,approved_beneficiary" || !validHttpsUrl(offer.privacyTermsUrl) || !validHttpsUrl(offer.operatorTermsUrl) || !validBeneficiaries(offer.payoutRequirements.approvedBeneficiaries)) {
    throw new Error("Pool Offer is invalid");
  }
  const rewardTotal = offer.rewardPolicy.selectedDestinationBasisPoints + offer.rewardPolicy.poolFeeBasisPoints + offer.rewardPolicy.serviceFeeBasisPoints;
  if (!validBasisPoints(offer.rewardPolicy.selectedDestinationBasisPoints) || !validBasisPoints(offer.rewardPolicy.poolFeeBasisPoints) || !validBasisPoints(offer.rewardPolicy.serviceFeeBasisPoints) || rewardTotal !== 1e4 || offer.rewardPolicy.mode !== "solo_direct_coinbase" || offer.rewardPolicy.acceptedWorkCreatesRevenueClaim || offer.rewardPolicy.createsCustodialBalance || offer.rewardPolicy.networkValidResult !== "direct_coinbase_payout") {
    throw new Error("Reward Policy is invalid");
  }
}
function validBasisPoints(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1e4;
}
function validComponent(component) {
  return component.componentId.length > 0 && component.displayName.length > 0 && component.version.length > 0 && validHttpsUrl(component.sourceUrl) && component.license.length > 0;
}
function validBeneficiaries(beneficiaries) {
  const identifiers = new Set;
  for (const beneficiary of beneficiaries) {
    if (!/^[a-z0-9_]{1,128}$/u.test(beneficiary.beneficiaryId) || identifiers.has(beneficiary.beneficiaryId) || beneficiary.displayName.length === 0 || !validHttpsUrl(beneficiary.termsUrl)) {
      return false;
    }
    identifiers.add(beneficiary.beneficiaryId);
  }
  return true;
}
function validHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0 && parsed.username.length === 0 && parsed.password.length === 0;
  } catch (error) {
    if (error instanceof TypeError)
      return false;
    throw error;
  }
}
function validStratumEndpoint(value) {
  try {
    const parsed = new URL(value);
    const port = Number.parseInt(parsed.port, 10);
    return parsed.protocol === "stratum+tcp:" && parsed.hostname.length > 0 && parsed.port.length > 0 && Number.isInteger(port) && port >= 1 && port <= 65535 && parsed.username.length === 0 && parsed.password.length === 0;
  } catch (error) {
    if (error instanceof TypeError)
      return false;
    throw error;
  }
}
function poolOfferToWire(offer) {
  return {
    offer_id: offer.offerId,
    mining_pool: componentToWire(offer.miningPool),
    pool_adapter: componentToWire(offer.poolAdapter),
    mining_transport: offer.miningTransport,
    endpoint: offer.endpoint,
    reward_policy: {
      mode: offer.rewardPolicy.mode,
      selected_destination_basis_points: offer.rewardPolicy.selectedDestinationBasisPoints,
      pool_fee_basis_points: offer.rewardPolicy.poolFeeBasisPoints,
      service_fee_basis_points: offer.rewardPolicy.serviceFeeBasisPoints,
      accepted_work_creates_revenue_claim: offer.rewardPolicy.acceptedWorkCreatesRevenueClaim,
      creates_custodial_balance: offer.rewardPolicy.createsCustodialBalance,
      network_valid_result: offer.rewardPolicy.networkValidResult
    },
    payout_requirements: {
      selection_required: offer.payoutRequirements.selectionRequired,
      ephemeral_by_default: offer.payoutRequirements.ephemeralByDefault,
      accepted_destination_types: offer.payoutRequirements.acceptedDestinationTypes,
      approved_beneficiaries: offer.payoutRequirements.approvedBeneficiaries.map((beneficiary) => ({
        beneficiary_id: beneficiary.beneficiaryId,
        display_name: beneficiary.displayName,
        terms_url: beneficiary.termsUrl
      }))
    },
    privacy_terms_url: offer.privacyTermsUrl,
    operator_terms_url: offer.operatorTermsUrl
  };
}
function componentToWire(component) {
  return {
    component_id: component.componentId,
    display_name: component.displayName,
    version: component.version,
    source_url: component.sourceUrl,
    license: component.license
  };
}
function parseCompactJws(compactJws) {
  const parts = compactJws.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("Pool Offer signature is malformed");
  }
  const [protectedHeader, payload, signature] = parts;
  if (!protectedHeader || !payload || !signature) {
    throw new Error("Pool Offer signature is malformed");
  }
  return {
    protectedHeader,
    payload,
    signature,
    signingInput: `${protectedHeader}.${payload}`
  };
}
function decodeJson(segment) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(segment)));
}
function objectRecord(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}
function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("invalid base64url encoding");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

// web/trusted-consent-surface.ts
var query = new URL(location.href).searchParams;
var state = required(query, "state");
var openerOrigin = required(query, "opener_origin");
var maybeStatus = document.querySelector("#status");
var maybeTerms = document.querySelector("#terms");
run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (maybeStatus)
    maybeStatus.textContent = message;
  opener?.postMessage({
    type: "bwg_trusted_consent_result",
    state,
    maybeError: message
  }, openerOrigin);
});
async function run() {
  const challengeId = required(query, "challenge_id");
  const loaded = await fetchJson(`/v0/challenges/${challengeId}/trusted-consent`);
  const challenge = workChallenge(loaded.challenge);
  if (!Array.isArray(loaded.challenge.allowed_origins) || !loaded.challenge.allowed_origins.includes(openerOrigin)) {
    throw new Error("opener origin is not allowed for this Work Challenge");
  }
  const signedPoolOfferSet = signedOffers(loaded.challenge.pool_offers);
  const authorityTrust = {
    issuer: loaded.issuer,
    trustedKeys: loaded.jwks.keys
  };
  const verifiedOffers = await verifyPoolOfferSet(signedPoolOfferSet, challenge, authorityTrust);
  if (!verifiedOffers.trustedConfirmationRequired) {
    throw new Error("Authority challenge does not require trusted confirmation");
  }
  const request = {
    reason: trustedConsentReason(required(query, "reason")),
    authorityOrigin: location.origin,
    challengeId,
    disclosureDigestSha256: required(query, "disclosure_digest"),
    poolOfferSetSignatureSha256: required(query, "pool_offer_set_signature_digest"),
    expiresAtUnixSeconds: challenge.expiresAtUnixSeconds
  };
  if (challenge.challengeId !== request.challengeId || challenge.trustedConsentDisclosureDigestSha256 !== request.disclosureDigestSha256 || request.poolOfferSetSignatureSha256 !== await sha256Base64Url(signedPoolOfferSet.signature) || request.reason !== (challenge.actionPolicy === "account-creation.elevated.v1" ? "elevated_work" : "material_pool_terms")) {
    throw new Error("trusted surface terms do not match the opener request");
  }
  if (maybeTerms) {
    maybeTerms.textContent = JSON.stringify({
      challengeId,
      actionPolicy: challenge.actionPolicy,
      expectedHashes: challenge.expectedHashes,
      poolOffers: verifiedOffers.offers,
      expiresAtUnixSeconds: challenge.expiresAtUnixSeconds
    }, null, 2);
  }
  if (maybeStatus)
    maybeStatus.textContent = "Touch and verify with an approved authenticator.";
  const begin = await postJson(`/v0/challenges/${challengeId}/trusted-consent`, {
    pool_offer_set_signature_sha256: request.poolOfferSetSignatureSha256,
    reason: request.reason,
    authority_origin: request.authorityOrigin
  });
  if (begin.authority_disclosure_digest_sha256 !== request.disclosureDigestSha256) {
    throw new Error("Authority disclosure digest changed during confirmation");
  }
  const publicKeyEnvelope = record(begin.public_key, "WebAuthn public key envelope");
  const publicKey = decodeCreationOptions(record(publicKeyEnvelope.publicKey, "WebAuthn options"));
  const credential = await navigator.credentials.create({ publicKey });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("WebAuthn was cancelled");
  const ceremonyId = requiredString(begin.ceremony_id, "ceremony ID");
  const finished = await postJson(`/v0/challenges/${challengeId}/trusted-consent/${ceremonyId}`, credentialJson(credential));
  const receipt = requiredString(finished.trusted_consent_receipt, "Trusted Consent Receipt");
  if (maybeStatus)
    maybeStatus.textContent = "Trusted confirmation completed.";
  opener?.postMessage({
    type: "bwg_trusted_consent_result",
    state,
    maybeReceipt: receipt
  }, openerOrigin);
}
function workChallenge(value) {
  const workRequirement = record(value.work_requirement, "work requirement");
  return {
    challengeId: requiredString(value.challenge_id, "challenge ID"),
    actionPolicy: requiredString(value.action_policy, "action policy"),
    claimantKey: requiredString(value.claimant_key, "claimant key"),
    expectedHashes: requiredString(workRequirement.expected_hashes, "expected hashes"),
    expiresAtUnixSeconds: requiredNumber(value.expires_at_unix_seconds, "challenge expiry"),
    trustedConsentDisclosureDigestSha256: requiredString(value.trusted_consent_disclosure_digest_sha256, "trusted consent disclosure digest")
  };
}
function signedOffers(value) {
  const wire = record(value, "signed Pool Offers");
  if (!Array.isArray(wire.offers))
    throw new Error("signed Pool Offers are invalid");
  return {
    signature: requiredString(wire.signature, "Pool Offer signature"),
    offers: wire.offers.map(normalizeOffer)
  };
}
function normalizeOffer(value) {
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
      selectedDestinationBasisPoints: requiredNumber(reward.selected_destination_basis_points, "selected destination basis points"),
      poolFeeBasisPoints: requiredNumber(reward.pool_fee_basis_points, "pool fee basis points"),
      serviceFeeBasisPoints: requiredNumber(reward.service_fee_basis_points, "service fee basis points"),
      acceptedWorkCreatesRevenueClaim: exactBoolean(reward.accepted_work_creates_revenue_claim, false, "accepted-work revenue claim"),
      createsCustodialBalance: exactBoolean(reward.creates_custodial_balance, false, "custodial balance"),
      networkValidResult: exactString(reward.network_valid_result, "direct_coinbase_payout", "network-valid result")
    },
    payoutRequirements: {
      selectionRequired: exactBoolean(payout.selection_required, true, "payout selection requirement"),
      ephemeralByDefault: exactBoolean(payout.ephemeral_by_default, true, "ephemeral payout default"),
      acceptedDestinationTypes: acceptedDestinationTypes(payout.accepted_destination_types),
      approvedBeneficiaries: payout.approved_beneficiaries.map((candidate) => {
        const beneficiary = record(candidate, "approved beneficiary");
        return {
          beneficiaryId: requiredString(beneficiary.beneficiary_id, "beneficiary ID"),
          displayName: requiredString(beneficiary.display_name, "beneficiary display name"),
          termsUrl: requiredString(beneficiary.terms_url, "beneficiary terms URL")
        };
      })
    },
    privacyTermsUrl: requiredString(offer.privacy_terms_url, "privacy terms URL"),
    operatorTermsUrl: requiredString(offer.operator_terms_url, "operator terms URL")
  };
}
function normalizeComponent(value) {
  const component = record(value, "component identity");
  return {
    componentId: requiredString(component.component_id, "component ID"),
    displayName: requiredString(component.display_name, "component display name"),
    version: requiredString(component.version, "component version"),
    sourceUrl: requiredString(component.source_url, "component source URL"),
    license: requiredString(component.license, "component license")
  };
}
function decodeCreationOptions(value) {
  const rp = record(value.rp, "WebAuthn RP");
  const user = record(value.user, "WebAuthn user");
  if (!Array.isArray(value.pubKeyCredParams)) {
    throw new Error("WebAuthn algorithms are invalid");
  }
  const pubKeyCredParams = value.pubKeyCredParams.map((candidate) => {
    const parameter = record(candidate, "WebAuthn algorithm");
    if (parameter.type !== "public-key")
      throw new Error("WebAuthn credential type is invalid");
    return {
      type: "public-key",
      alg: requiredNumber(parameter.alg, "WebAuthn algorithm ID")
    };
  });
  const maybeExcludeCredentials = Array.isArray(value.excludeCredentials) ? value.excludeCredentials.map((candidate) => {
    const item = record(candidate, "excluded credential");
    if (item.type !== "public-key")
      throw new Error("excluded credential type is invalid");
    return {
      type: "public-key",
      id: decodeBase64UrlBuffer(requiredString(item.id, "credential ID"))
    };
  }) : undefined;
  const maybeTimeout = value.timeout === undefined ? undefined : requiredNumber(value.timeout, "WebAuthn timeout");
  const maybeAttestation = maybeAttestationPreference(value.attestation);
  const maybeAuthenticatorSelection = value.authenticatorSelection === undefined ? undefined : selectionCriteria(record(value.authenticatorSelection, "authenticator selection"));
  return {
    rp: {
      id: requiredString(rp.id, "WebAuthn RP ID"),
      name: requiredString(rp.name, "WebAuthn RP name")
    },
    challenge: decodeBase64UrlBuffer(requiredString(value.challenge, "WebAuthn challenge")),
    user: {
      id: decodeBase64UrlBuffer(requiredString(user.id, "WebAuthn user ID")),
      name: requiredString(user.name, "WebAuthn user name"),
      displayName: requiredString(user.displayName, "WebAuthn display name")
    },
    pubKeyCredParams,
    ...maybeTimeout === undefined ? {} : { timeout: maybeTimeout },
    ...maybeAttestation === undefined ? {} : { attestation: maybeAttestation },
    ...maybeAuthenticatorSelection === undefined ? {} : { authenticatorSelection: maybeAuthenticatorSelection },
    ...maybeExcludeCredentials ? { excludeCredentials: maybeExcludeCredentials } : {}
  };
}
function maybeAttestationPreference(value) {
  if (value === undefined)
    return;
  if (value === "direct" || value === "enterprise" || value === "indirect" || value === "none") {
    return value;
  }
  throw new Error("WebAuthn attestation preference is invalid");
}
function selectionCriteria(value) {
  const maybeAttachment = value.authenticatorAttachment;
  const maybeResidentKey = value.residentKey;
  const maybeUserVerification = value.userVerification;
  if (maybeAttachment !== undefined && maybeAttachment !== "cross-platform" && maybeAttachment !== "platform") {
    throw new Error("authenticator attachment is invalid");
  }
  const maybeParsedResidentKey = maybeResidentKey === undefined ? undefined : preference(maybeResidentKey, "resident-key");
  const maybeParsedUserVerification = maybeUserVerification === undefined ? undefined : preference(maybeUserVerification, "user-verification");
  return {
    ...maybeAttachment === undefined ? {} : { authenticatorAttachment: maybeAttachment },
    ...maybeParsedResidentKey === undefined ? {} : { residentKey: maybeParsedResidentKey },
    ...maybeParsedUserVerification === undefined ? {} : { userVerification: maybeParsedUserVerification }
  };
}
function preference(value, label) {
  if (value === "discouraged" || value === "preferred" || value === "required")
    return value;
  throw new Error(`${label} preference is invalid`);
}
function credentialJson(credential) {
  const response = credential.response;
  if (!(response instanceof AuthenticatorAttestationResponse)) {
    throw new Error("WebAuthn registration response is invalid");
  }
  return {
    id: credential.id,
    rawId: encodeBase64Url2(new Uint8Array(credential.rawId)),
    type: credential.type,
    response: {
      attestationObject: encodeBase64Url2(new Uint8Array(response.attestationObject)),
      clientDataJSON: encodeBase64Url2(new Uint8Array(response.clientDataJSON))
    }
  };
}
async function fetchJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok)
    throw new Error(await response.text());
  return response.json();
}
async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok)
    throw new Error(await response.text());
  return response.json();
}
function required(parameters, name) {
  const maybeValue = parameters.get(name);
  if (!maybeValue)
    throw new Error(`missing ${name}`);
  return maybeValue;
}
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
function trustedConsentReason(value) {
  if (value === "elevated_work" || value === "material_pool_terms")
    return value;
  throw new Error("trusted consent reason is invalid");
}
function exactString(value, expected, label) {
  if (value !== expected)
    throw new Error(`${label} is invalid`);
  return expected;
}
function exactBoolean(value, expected, label) {
  if (value !== expected)
    throw new Error(`${label} is invalid`);
  return expected;
}
function acceptedDestinationTypes(value) {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== "bitcoin_mainnet_address" || value[1] !== "approved_beneficiary") {
    throw new Error("accepted destination types are invalid");
  }
  return ["bitcoin_mainnet_address", "approved_beneficiary"];
}
function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} is invalid`);
  return value;
}
function requiredNumber(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
function decodeBase64Url2(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value))
    throw new Error("base64url value is malformed");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
function decodeBase64UrlBuffer(value) {
  const bytes = decodeBase64Url2(value);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
function encodeBase64Url2(value) {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
