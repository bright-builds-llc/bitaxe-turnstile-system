import fixture from "../conformance/bwg-0.1/headless-work-consent-vectors.json";

import {
  type AuthorityClientEvent,
  type AuthorityVerificationJwk,
  type HeadlessClientInput,
  type HeadlessTransport,
  type PoolOfferDisclosure,
  type PreparedClaimantIdentity,
  prepareClaimantIdentity,
} from "./headless-client";

const fixtureKey = fixture.authorityTrust.trustedKeys[0];
if (!fixtureKey) throw new Error("headless fixture Authority key is missing");
const authorityKey: AuthorityVerificationJwk = {
  kty: fixtureKey.kty,
  crv: fixtureKey.crv,
  x: fixtureKey.x,
  kid: fixtureKey.kid,
  alg: "Ed25519",
  use: "sig",
  key_ops: ["verify"],
};

export const challenge = {
  challengeId: fixture.challenge.challengeId,
  actionPolicy: fixture.challenge.actionPolicy,
  claimantKey: "",
  expectedHashes: fixture.challenge.expectedHashes,
  expiresAtUnixSeconds: fixture.challenge.expiresAtUnixSeconds,
};

export const workers = [
  {
    workerId: "worker_local_01",
    displayName: "Local Bitaxe",
    hashrateHs: "400000000000",
    maybePowerWatts: 15,
  },
];

export const poolOffer: PoolOfferDisclosure = {
  offerId: "pool_offer_hydra_solo_v1",
  miningPool: {
    componentId: "p2poolv2_hydra",
    displayName: "Hydra / P2Pool v2",
    version: "v0.12",
    sourceUrl: "https://github.com/p2poolv2/p2poolv2",
    license: "AGPL-3.0-or-later",
  },
  poolAdapter: {
    componentId: "bwg_reference_stratum_adapter",
    displayName: "BWG Reference Stratum V1 Adapter",
    version: "0.1.0",
    sourceUrl: "https://github.com/bright-builds-llc/bitaxe-turnstile-system",
    license: "MIT",
  },
  miningTransport: "stratum_v1",
  endpoint: "stratum+tcp://pool.example:3333/",
  rewardPolicy: {
    mode: "solo_direct_coinbase",
    selectedDestinationBasisPoints: 10_000,
    poolFeeBasisPoints: 0,
    serviceFeeBasisPoints: 0,
    acceptedWorkCreatesRevenueClaim: false,
    createsCustodialBalance: false,
    networkValidResult: "direct_coinbase_payout",
  },
  payoutRequirements: {
    selectionRequired: true,
    ephemeralByDefault: true,
    acceptedDestinationTypes: ["bitcoin_mainnet_address", "approved_beneficiary"],
    approvedBeneficiaries: [
      {
        beneficiaryId: "open_source_bitcoin_research",
        displayName: "Open-source Bitcoin research",
        termsUrl:
          "https://pool.example/beneficiaries/open-source-bitcoin-research",
      },
    ],
  },
  privacyTermsUrl: "https://authority.example/privacy",
  operatorTermsUrl: "https://authority.example/terms",
};

export function transportHarness(): {
  transport: HeadlessTransport;
  calls: string[];
  emitAuthority(event: AuthorityClientEvent): Promise<void>;
} {
  const calls: string[] = [];
  let maybeAuthorityListener: ((event: AuthorityClientEvent) => Promise<void>) | undefined;
  return {
    calls,
    transport: {
      start: async () => {
        calls.push("start");
      },
      pause: async () => {
        calls.push("pause");
      },
      resume: async () => {
        calls.push("resume");
      },
      cancel: async () => {
        calls.push("cancel");
      },
      subscribeAuthorityEvents(listener) {
        maybeAuthorityListener = listener;
        return () => {
          maybeAuthorityListener = undefined;
        };
      },
    },
    async emitAuthority(event) {
      if (!maybeAuthorityListener) throw new Error("Authority listener is not subscribed");
      await maybeAuthorityListener(event);
    },
  };
}

export async function headlessInput(
  transport: HeadlessTransport,
  options: {
    maybeClock?: () => number;
    maybeIdentity?: PreparedClaimantIdentity;
    maybeClaimantWorkCeiling?: string;
    maybeClientSafetyCeiling?: string;
    maybeRestoration?: {
      challengeState: "issued" | "active" | "satisfied" | "pass_issued";
    };
  } = {},
): Promise<HeadlessClientInput> {
  const claimantIdentity =
    options.maybeIdentity ??
    (await prepareClaimantIdentity({ maybeClock: options.maybeClock ?? (() => 1_000) }));
  return {
    challenge: { ...structuredClone(challenge), claimantKey: claimantIdentity.claimantKey() },
    claimantIdentity,
    signedPoolOfferSet: {
      offers: [structuredClone(poolOffer)],
      signature: fixture.signedPoolOfferSet.signature,
    },
    authorityTrust: {
      issuer: fixture.authorityTrust.issuer,
      trustedKeys: [structuredClone(authorityKey)],
    },
    selection: {
      poolOfferId: poolOffer.offerId,
      payoutDestinationType: "bitcoin_mainnet_address",
      bitcoinMainnetAddress: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
    },
    workers: structuredClone(workers),
    claimantWorkCeiling:
      options.maybeClaimantWorkCeiling ?? "17592186044416",
    clientSafetyCeiling:
      options.maybeClientSafetyCeiling ?? "70368744177664",
    transport,
    ...(options.maybeRestoration ? { maybeRestoration: options.maybeRestoration } : {}),
  };
}
