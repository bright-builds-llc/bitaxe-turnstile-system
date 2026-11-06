/**
 * Reference account-creation page (Ticket 06): `bwg-core/component` on the headless
 * SDK over direct Web Serial, with the Authority and Reference Relying Service
 * served from the page's own origin.
 *
 * The claimant HTTP transport and the 20-second Renew live here until Ticket 17
 * moves them into the SDK and the component.
 */
import type { BwgWorkGateElement } from "./bwg-work-gate";
import { encodeBase64Url, sha256Base64UrlBytes } from "./crypto-bytes";
import {
  connectWebSerialHeadlessClient,
  type AuthorityTrustInput,
  type HeadlessClient,
  type PoolOfferDisclosure,
  type WorkChallengeInput,
  type WorkerDisclosure,
} from "./headless-client";
import { prepareClaimantIdentity } from "./headless-key";
import {
  CLAIMANT_PROOF_HEADER,
  createClaimantTransport,
  signClaimantJwt,
  type ProofSigner,
} from "./reference-claimant-transport";
import type { WebSerialWorkerControllerInput } from "./webserial-worker-controller";

/** The page renews on the Authority's healthy-continuity cadence (`WORK_LEASE_RENEWAL_SECONDS`). */
export const RENEW_INTERVAL_MILLISECONDS = 20_000;

export type ReferencePageConfig = {
  /** The one origin serving the page, the Authority and the Reference Relying Service. */
  origin: string;
  authorityTrust: AuthorityTrustInput;
  workers: readonly WorkerDisclosure[];
  claimantWorkCeiling: string;
  clientSafetyCeiling: string;
  provenance: Parameters<BwgWorkGateElement["configure"]>[0]["provenance"];
};

export type ReferencePageEvent =
  | { type: "challenge_created"; challengeId: string; expiresAtUnixSeconds: number }
  | { type: "renewed" }
  | { type: "renew_failed"; message: string }
  | { type: "redeemed"; status: number; body: unknown };

export type ReferencePageInput = {
  config: ReferencePageConfig;
  gate: BwgWorkGateElement;
  payoutAddress: string;
  /** Production passes the real board's filter and trust; the rehearsal its fake device. */
  worker(scope: { challengeId: string; expiresAtUnixSeconds: number }): WebSerialWorkerControllerInput;
  maybeOnEvent?: (event: ReferencePageEvent) => void;
};

/** Runs from the user's "Connect Bitaxe over USB" gesture, then hands the session to the gate. */
export async function connectReferenceAccountPage(input: ReferencePageInput): Promise<HeadlessClient> {
  const { config } = input;
  const notify = input.maybeOnEvent ?? (() => undefined);
  const identity = await prepareClaimantIdentity({ maybeIssuanceWindowSeconds: 300 });
  const descriptor = await postJson(`${config.origin}/account-creation/challenge`, {
    claimant_key: identity.claimantKey(),
  });
  const challenge = challengeInput(descriptor);
  notify({
    type: "challenge_created",
    challengeId: challenge.challengeId,
    expiresAtUnixSeconds: challenge.expiresAtUnixSeconds,
  });
  let maybeClient: HeadlessClient | undefined;
  const signer: ProofSigner = {
    claimantKey: () => identity.claimantKey(),
    sign(payload) {
      if (!maybeClient) throw new Error("claimant client is not ready");
      return maybeClient.signClaimantProof(payload);
    },
  };
  const transport = createClaimantTransport({
    authorityBaseUrl: config.origin,
    challengeId: challenge.challengeId,
    signer,
  });
  const offers = poolOffers(descriptor);
  const selection = {
    poolOfferId: offers.offers[0]?.offerId ?? "",
    payoutDestinationType: "bitcoin_mainnet_address" as const,
    bitcoinMainnetAddress: input.payoutAddress,
  };
  const client = await connectWebSerialHeadlessClient({
    client: {
      challenge,
      claimantIdentity: identity,
      signedPoolOfferSet: offers,
      authorityTrust: config.authorityTrust,
      selection,
      workers: config.workers,
      claimantWorkCeiling: config.claimantWorkCeiling,
      clientSafetyCeiling: config.clientSafetyCeiling,
      transport,
    },
    worker: input.worker({
      challengeId: challenge.challengeId,
      expiresAtUnixSeconds: challenge.expiresAtUnixSeconds,
    }),
  });
  maybeClient = client;
  await transport.selectPool(selection);
  scheduleRenew(client, notify);
  const actionReference = stringField(descriptor, "action_reference");
  input.gate.configure({
    loadSession: async () => ({
      client,
      compatibleWorkerAvailable: true,
      redeem: () => redeem(config.origin, challenge.challengeId, actionReference, signer, notify),
    }),
    alternatives: [],
    provenance: config.provenance,
  });
  return client;
}

function scheduleRenew(client: HeadlessClient, notify: (event: ReferencePageEvent) => void): void {
  let running = false;
  let finished = false;
  const unsubscribe = client.subscribe((event) => {
    if (event.type !== "lifecycle") return;
    running = event.challengeState === "active" && event.controlState === "running";
    finished = ["satisfied", "pass_issued", "cancelled", "expired"].includes(event.challengeState);
    if (finished) {
      clearInterval(timer);
      unsubscribe();
    }
  });
  const timer = setInterval(() => {
    if (!running || finished) return;
    client.renewWorkerLease().then(
      () => notify({ type: "renewed" }),
      (error: unknown) => notify({ type: "renew_failed", message: String(error) }),
    );
  }, RENEW_INTERVAL_MILLISECONDS);
}

async function redeem(
  origin: string,
  challengeId: string,
  actionReference: string,
  signer: ProofSigner,
  notify: (event: ReferencePageEvent) => void,
): Promise<{ message: string }> {
  const lookupUrl = `${origin}/v0/challenges/${encodeURIComponent(challengeId)}/gate-pass`;
  const issuanceProof = await signClaimantJwt(signer, "bwg-issuance-proof+jwt", {
    jti: proofId(),
    htm: "GET",
    htu: lookupUrl,
    iat: nowUnixSeconds(),
    challenge_id: challengeId,
  });
  const lookup = await fetch(lookupUrl, { headers: { [CLAIMANT_PROOF_HEADER]: issuanceProof } });
  if (!lookup.ok) throw new Error(`Gate Pass lookup failed: ${lookup.status}`);
  const gatePass = stringField(await lookup.json(), "gate_pass");
  const redemptionUrl = `${origin}/account-creation/redeem`;
  const dpopProof = await signClaimantJwt(signer, "dpop+jwt", {
    jti: proofId(),
    htm: "POST",
    htu: redemptionUrl,
    iat: nowUnixSeconds(),
    ath: await sha256Base64UrlBytes(new TextEncoder().encode(gatePass)),
  });
  const response = await fetch(redemptionUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gate_pass: gatePass, dpop_proof: dpopProof, action_reference: actionReference }),
  });
  const body: unknown = await response.json();
  notify({ type: "redeemed", status: response.status, body });
  if (!response.ok) throw new Error(`Gate Pass redemption failed: ${response.status}`);
  return { message: "Account creation authorized." };
}

type Json = Record<string, unknown>;

function challengeInput(descriptor: Json): WorkChallengeInput {
  const requirement = record(descriptor.work_requirement, "work_requirement");
  const expiresAt = descriptor.expires_at_unix_seconds;
  if (typeof expiresAt !== "number") throw new Error("challenge expiry is missing");
  return {
    challengeId: stringField(descriptor, "challenge_id"),
    actionPolicy: stringField(descriptor, "action_policy"),
    claimantKey: stringField(descriptor, "claimant_key"),
    expectedHashes: stringField(requirement, "expected_hashes"),
    expiresAtUnixSeconds: expiresAt,
  };
}

function poolOffers(descriptor: Json): { offers: PoolOfferDisclosure[]; signature: string } {
  const set = record(descriptor.pool_offers, "pool_offers");
  if (!Array.isArray(set.offers)) throw new Error("pool offers are missing");
  return {
    offers: set.offers.map((value) => poolOffer(record(value, "pool offer"))),
    signature: stringField(set, "signature"),
  };
}

function poolOffer(offer: Json): PoolOfferDisclosure {
  const reward = record(offer.reward_policy, "reward_policy");
  const payout = record(offer.payout_requirements, "payout_requirements");
  const beneficiaries = Array.isArray(payout.approved_beneficiaries) ? payout.approved_beneficiaries : [];
  return {
    offerId: stringField(offer, "offer_id"),
    miningPool: component(record(offer.mining_pool, "mining_pool")),
    poolAdapter: component(record(offer.pool_adapter, "pool_adapter")),
    miningTransport: stringField(offer, "mining_transport") as "stratum_v1",
    endpoint: stringField(offer, "endpoint"),
    rewardPolicy: {
      mode: stringField(reward, "mode") as "solo_direct_coinbase",
      selectedDestinationBasisPoints: Number(reward.selected_destination_basis_points),
      poolFeeBasisPoints: Number(reward.pool_fee_basis_points),
      serviceFeeBasisPoints: Number(reward.service_fee_basis_points),
      acceptedWorkCreatesRevenueClaim: reward.accepted_work_creates_revenue_claim as false,
      createsCustodialBalance: reward.creates_custodial_balance as false,
      networkValidResult: stringField(reward, "network_valid_result") as "direct_coinbase_payout",
    },
    payoutRequirements: {
      selectionRequired: payout.selection_required as true,
      ephemeralByDefault: payout.ephemeral_by_default as true,
      acceptedDestinationTypes: payout.accepted_destination_types as PoolOfferDisclosure["payoutRequirements"]["acceptedDestinationTypes"],
      approvedBeneficiaries: beneficiaries.map((value) => {
        const beneficiary = record(value, "beneficiary");
        return {
          beneficiaryId: stringField(beneficiary, "beneficiary_id"),
          displayName: stringField(beneficiary, "display_name"),
          termsUrl: stringField(beneficiary, "terms_url"),
        };
      }),
    },
    privacyTermsUrl: stringField(offer, "privacy_terms_url"),
    operatorTermsUrl: stringField(offer, "operator_terms_url"),
  };
}

function component(value: Json): PoolOfferDisclosure["miningPool"] {
  return {
    componentId: stringField(value, "component_id"),
    displayName: stringField(value, "display_name"),
    version: stringField(value, "version"),
    sourceUrl: stringField(value, "source_url"),
    license: stringField(value, "license"),
  };
}

async function postJson(url: string, body: unknown): Promise<Json> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return record(await response.json(), url);
}

function record(value: unknown, name: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} is invalid`);
  return value as Json;
}

function stringField(value: Json, name: string): string {
  const field = value[name];
  if (typeof field !== "string") throw new Error(`${name} is missing`);
  return field;
}

function proofId(): string {
  return `proof_${encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
