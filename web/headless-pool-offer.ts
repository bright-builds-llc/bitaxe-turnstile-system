import type {
  ApprovedBeneficiaryDisclosure,
  AuthorityTrustInput,
  OfferComponentDisclosure,
  PoolOfferDisclosure,
  PoolSelectionInput,
  SignedPoolOfferSetInput,
  WorkChallengeInput,
} from "./headless-client.types";
import { canonicalJson } from "./headless-values";

export async function verifyPoolOfferSet(
  signed: SignedPoolOfferSetInput,
  challenge: WorkChallengeInput,
  trust: AuthorityTrustInput,
): Promise<{
  authorityKeyId: string;
  offers: readonly PoolOfferDisclosure[];
  trustedConfirmationRequired: boolean;
}> {
  if (signed.offers.length === 0) throw new Error("Pool Offer set must not be empty");
  if (new Set(signed.offers.map((offer) => offer.offerId)).size !== signed.offers.length) {
    throw new Error("Pool Offer identities must be unique");
  }
  for (const offer of signed.offers) validatePoolOffer(offer);
  const compact = parseCompactJws(signed.signature);
  const header = objectRecord(decodeJson(compact.protectedHeader), "Pool Offer header");
  if (Object.hasOwn(header, "crit")) throw new Error("unsupported critical header");
  if (header.typ !== "bwg-pool-offer-set+jws" || header.alg !== "Ed25519") {
    throw new Error("invalid Pool Offer signature profile");
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new Error("invalid Pool Offer key ID");
  }
  const matchingKeys = trust.trustedKeys.filter((key) => key.kid === header.kid);
  if (matchingKeys.length !== 1) throw new Error("Pool Offer key is not uniquely trusted");
  const key = matchingKeys[0];
  if (
    !key ||
    key.kty !== "OKP" ||
    key.crv !== "Ed25519" ||
    key.alg !== "Ed25519" ||
    key.use !== "sig" ||
    JSON.stringify(key.key_ops) !== '["verify"]'
  ) {
    throw new Error("invalid Pool Offer verification key");
  }
  const cryptoKey = await crypto.subtle.importKey("jwk", key, "Ed25519", false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "Ed25519",
    cryptoKey,
    Uint8Array.from(decodeBase64Url(compact.signature)).buffer,
    new TextEncoder().encode(compact.signingInput),
  );
  if (!valid) throw new Error("invalid Pool Offer signature");

  const claims = objectRecord(decodeJson(compact.payload), "Pool Offer claims");
  if (
    claims.iss !== trust.issuer ||
    claims.challenge_id !== challenge.challengeId ||
    claims.action_policy !== challenge.actionPolicy ||
    claims.bwg_version !== "BWG/0.1"
  ) {
    throw new Error("signed Pool Offers do not match the Work Challenge");
  }
  const maybeTrustedConfirmationRequired = claims.trusted_confirmation_required;
  if (
    maybeTrustedConfirmationRequired !== undefined &&
    typeof maybeTrustedConfirmationRequired !== "boolean"
  ) {
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
    trustedConfirmationRequired: maybeTrustedConfirmationRequired === true,
  };
}

export async function selectPoolOffer(
  offers: readonly PoolOfferDisclosure[],
  selection: PoolSelectionInput,
): Promise<PoolOfferDisclosure> {
  const maybeOffer = offers.find((offer) => offer.offerId === selection.poolOfferId);
  if (!maybeOffer) throw new Error("selected Pool Offer is not approved");
  if (!maybeOffer.payoutRequirements.acceptedDestinationTypes.includes(selection.payoutDestinationType)) {
    throw new Error("selected payout type is not approved");
  }
  if (
    selection.payoutDestinationType === "approved_beneficiary" &&
    !maybeOffer.payoutRequirements.approvedBeneficiaries.some(
      (beneficiary) => beneficiary.beneficiaryId === selection.beneficiaryId,
    )
  ) {
    throw new Error("selected beneficiary is not approved");
  }
  if (
    selection.payoutDestinationType === "bitcoin_mainnet_address" &&
    !(await validMainnetAddress(selection.bitcoinMainnetAddress))
  ) {
    throw new Error("selected Bitcoin mainnet address is invalid");
  }
  return maybeOffer;
}

function validatePoolOffer(offer: PoolOfferDisclosure): void {
  if (
    offer.offerId.length === 0 ||
    !validComponent(offer.miningPool) ||
    !validComponent(offer.poolAdapter) ||
    offer.miningTransport !== "stratum_v1" ||
    !validStratumEndpoint(offer.endpoint) ||
    !offer.payoutRequirements.selectionRequired ||
    !offer.payoutRequirements.ephemeralByDefault ||
    offer.payoutRequirements.acceptedDestinationTypes.join(",") !==
      "bitcoin_mainnet_address,approved_beneficiary" ||
    !validHttpsUrl(offer.privacyTermsUrl) ||
    !validHttpsUrl(offer.operatorTermsUrl) ||
    !validBeneficiaries(offer.payoutRequirements.approvedBeneficiaries)
  ) {
    throw new Error("Pool Offer is invalid");
  }
  const rewardTotal =
    offer.rewardPolicy.selectedDestinationBasisPoints +
    offer.rewardPolicy.poolFeeBasisPoints +
    offer.rewardPolicy.serviceFeeBasisPoints;
  if (
    !validBasisPoints(offer.rewardPolicy.selectedDestinationBasisPoints) ||
    !validBasisPoints(offer.rewardPolicy.poolFeeBasisPoints) ||
    !validBasisPoints(offer.rewardPolicy.serviceFeeBasisPoints) ||
    rewardTotal !== 10_000 ||
    offer.rewardPolicy.mode !== "solo_direct_coinbase" ||
    offer.rewardPolicy.acceptedWorkCreatesRevenueClaim ||
    offer.rewardPolicy.createsCustodialBalance ||
    offer.rewardPolicy.networkValidResult !== "direct_coinbase_payout"
  ) {
    throw new Error("Reward Policy is invalid");
  }
}

function validBasisPoints(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 10_000;
}

function validComponent(component: OfferComponentDisclosure): boolean {
  return (
    component.componentId.length > 0 &&
    component.displayName.length > 0 &&
    component.version.length > 0 &&
    validHttpsUrl(component.sourceUrl) &&
    component.license.length > 0
  );
}

function validBeneficiaries(
  beneficiaries: readonly ApprovedBeneficiaryDisclosure[],
): boolean {
  const identifiers = new Set<string>();
  for (const beneficiary of beneficiaries) {
    if (
      !/^[a-z0-9_]{1,128}$/u.test(beneficiary.beneficiaryId) ||
      identifiers.has(beneficiary.beneficiaryId) ||
      beneficiary.displayName.length === 0 ||
      !validHttpsUrl(beneficiary.termsUrl)
    ) {
      return false;
    }
    identifiers.add(beneficiary.beneficiaryId);
  }
  return true;
}

function validHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function validStratumEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value);
    const port = Number.parseInt(parsed.port, 10);
    return (
      parsed.protocol === "stratum+tcp:" &&
      parsed.hostname.length > 0 &&
      parsed.port.length > 0 &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65_535 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

async function validMainnetAddress(address: string): Promise<boolean> {
  if (address.length < 14 || address.length > 90) return false;
  if (address.startsWith("1") || address.startsWith("3")) {
    return validBase58CheckMainnet(address);
  }
  return validSegwitMainnet(address);
}

async function validBase58CheckMainnet(address: string): Promise<boolean> {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let numeric = 0n;
  for (const character of address) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return false;
    numeric = numeric * 58n + BigInt(digit);
  }
  const decoded: number[] = [];
  while (numeric > 0n) {
    decoded.unshift(Number(numeric & 0xffn));
    numeric >>= 8n;
  }
  for (const character of address) {
    if (character !== "1") break;
    decoded.unshift(0);
  }
  if (decoded.length !== 25 || (decoded[0] !== 0x00 && decoded[0] !== 0x05)) return false;
  const payload = Uint8Array.from(decoded.slice(0, 21));
  const firstDigest = await crypto.subtle.digest("SHA-256", payload);
  const secondDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", firstDigest));
  return decoded.slice(21).every((byte, index) => byte === secondDigest[index]);
}

function validSegwitMainnet(address: string): boolean {
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return false;
  const normalized = address.toLowerCase();
  const separator = normalized.lastIndexOf("1");
  if (normalized.slice(0, separator) !== "bc" || separator < 1) return false;
  const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = [...normalized.slice(separator + 1)].map((character) => alphabet.indexOf(character));
  if (data.length < 7 || data.some((value) => value < 0)) return false;
  const witnessVersion = data[0];
  if (witnessVersion === undefined || witnessVersion > 16) return false;
  const checksum = bech32Polymod([...bech32Hrp("bc"), ...data]);
  if (checksum !== (witnessVersion === 0 ? 1 : 0x2bc830a3)) return false;
  const program = convertBits(data.slice(1, -6), 5, 8);
  if (!program || program.length < 2 || program.length > 40) return false;
  return witnessVersion !== 0 || program.length === 20 || program.length === 32;
}

function bech32Hrp(value: string): number[] {
  return [
    ...[...value].map((character) => character.charCodeAt(0) >> 5),
    0,
    ...[...value].map((character) => character.charCodeAt(0) & 31),
  ];
}

function bech32Polymod(values: readonly number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < generators.length; index += 1) {
      if ((top >>> index) & 1) checksum ^= generators[index] ?? 0;
    }
  }
  return checksum >>> 0;
}

function convertBits(
  values: readonly number[],
  fromBits: number,
  toBits: number,
): number[] | undefined {
  let accumulator = 0;
  let bitCount = 0;
  const result: number[] = [];
  const maximum = (1 << toBits) - 1;
  for (const value of values) {
    if (value < 0 || value >> fromBits !== 0) return undefined;
    accumulator = (accumulator << fromBits) | value;
    bitCount += fromBits;
    while (bitCount >= toBits) {
      bitCount -= toBits;
      result.push((accumulator >> bitCount) & maximum);
    }
  }
  if (bitCount >= fromBits || ((accumulator << (toBits - bitCount)) & maximum) !== 0) {
    return undefined;
  }
  return result;
}

function poolOfferToWire(offer: PoolOfferDisclosure): Record<string, unknown> {
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
      accepted_work_creates_revenue_claim:
        offer.rewardPolicy.acceptedWorkCreatesRevenueClaim,
      creates_custodial_balance: offer.rewardPolicy.createsCustodialBalance,
      network_valid_result: offer.rewardPolicy.networkValidResult,
    },
    payout_requirements: {
      selection_required: offer.payoutRequirements.selectionRequired,
      ephemeral_by_default: offer.payoutRequirements.ephemeralByDefault,
      accepted_destination_types: offer.payoutRequirements.acceptedDestinationTypes,
      approved_beneficiaries: offer.payoutRequirements.approvedBeneficiaries.map(
        (beneficiary) => ({
          beneficiary_id: beneficiary.beneficiaryId,
          display_name: beneficiary.displayName,
          terms_url: beneficiary.termsUrl,
        }),
      ),
    },
    privacy_terms_url: offer.privacyTermsUrl,
    operator_terms_url: offer.operatorTermsUrl,
  };
}

function componentToWire(component: OfferComponentDisclosure): Record<string, unknown> {
  return {
    component_id: component.componentId,
    display_name: component.displayName,
    version: component.version,
    source_url: component.sourceUrl,
    license: component.license,
  };
}

function parseCompactJws(compactJws: string): {
  protectedHeader: string;
  payload: string;
  signature: string;
  signingInput: string;
} {
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
    signingInput: `${protectedHeader}.${payload}`,
  };
}

function decodeJson(segment: string): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(segment)));
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url encoding");
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
