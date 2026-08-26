import type { PreparedClaimantIdentity } from "./headless-key";

export type WorkChallengeInput = {
  challengeId: string;
  actionPolicy: string;
  claimantKey: string;
  expectedHashes: string;
  expiresAtUnixSeconds: number;
  trustedConsentDisclosureDigestSha256?: string;
};
export type WorkerDisclosure = {
  workerId: string;
  displayName: string;
  hashrateHs: string;
  maybePowerWatts?: number;
};

export type OfferComponentDisclosure = {
  componentId: string;
  displayName: string;
  version: string;
  sourceUrl: string;
  license: string;
};

export type ApprovedBeneficiaryDisclosure = {
  beneficiaryId: string;
  displayName: string;
  termsUrl: string;
};

export type RewardPolicyDisclosure = {
  mode: "solo_direct_coinbase";
  selectedDestinationBasisPoints: number;
  poolFeeBasisPoints: number;
  serviceFeeBasisPoints: number;
  acceptedWorkCreatesRevenueClaim: false;
  createsCustodialBalance: false;
  networkValidResult: "direct_coinbase_payout";
};

export type PayoutRequirementsDisclosure = {
  selectionRequired: true;
  ephemeralByDefault: true;
  acceptedDestinationTypes: readonly (
    | "bitcoin_mainnet_address"
    | "approved_beneficiary"
  )[];
  approvedBeneficiaries: readonly ApprovedBeneficiaryDisclosure[];
};

export type PoolOfferDisclosure = {
  offerId: string;
  miningPool: OfferComponentDisclosure;
  poolAdapter: OfferComponentDisclosure;
  miningTransport: "stratum_v1";
  endpoint: string;
  rewardPolicy: RewardPolicyDisclosure;
  payoutRequirements: PayoutRequirementsDisclosure;
  privacyTermsUrl: string;
  operatorTermsUrl: string;
};

export type SignedPoolOfferSetInput = {
  offers: readonly PoolOfferDisclosure[];
  signature: string;
};

export type AuthorityVerificationJwk = JsonWebKey & {
  kid: string;
  alg: "Ed25519";
  use: "sig";
  key_ops: readonly ["verify"];
};

export type AuthorityTrustInput = {
  issuer: string;
  trustedKeys: readonly AuthorityVerificationJwk[];
};

export type PoolSelectionInput =
  | {
      poolOfferId: string;
      payoutDestinationType: "bitcoin_mainnet_address";
      bitcoinMainnetAddress: string;
    }
  | {
      poolOfferId: string;
      payoutDestinationType: "approved_beneficiary";
      beneficiaryId: string;
    };

export type WorkConsentDisclosure = {
  challengeId: string;
  actionPolicy: string;
  expectedHashes: string;
  equivalentBinaryZeroWork: number;
  maybeDurationSeconds?: number;
  maybeEnergyWattHours?: number;
  poolOfferSetSignature: string;
  authorityIssuer: string;
  authorityKeyId: string;
  poolOffer: PoolOfferDisclosure;
  rewardPolicy: RewardPolicyDisclosure;
  payoutDestinationType: PoolSelectionInput["payoutDestinationType"];
  payoutDestination: string;
  workers: readonly WorkerDisclosure[];
  cancellationBehavior: "pause_preserves_progress_cancel_is_terminal";
  claimantWorkCeiling: string;
  clientSafetyCeiling: string;
  maybeTrustedConsentRequirement?: TrustedConsentRequirement;
};

export type WorkConsentReceipt = {
  disclosureDigestSha256: string;
  poolOfferSetSignature: string;
  maybeTrustedConsentReceipt?: string;
};

export type TrustedConsentReason = "elevated_work" | "material_pool_terms";

export type TrustedConsentRequirement = {
  reason: TrustedConsentReason;
  authorityOrigin: string;
};

export type TrustedConsentRequest = TrustedConsentRequirement & {
  challengeId: string;
  disclosureDigestSha256: string;
  poolOfferSetSignatureSha256: string;
  expiresAtUnixSeconds: number;
};

export type AuthorityClientEvent =
  | { type: "challenge_lifecycle"; state: ChallengeLifecycleState }
  | { type: "verified_progress"; acceptedHashes: string }
  | { type: "artifact_expiry"; expiresAtUnixSeconds: number };

export type HeadlessTransport = {
  start(maybeTrustedConsentReceipt?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  subscribeAuthorityEvents(listener: (event: AuthorityClientEvent) => Promise<void>): () => void;
};

export class ConsentRequiredError extends Error {
  constructor() {
    super("Work Consent is required before Start");
    this.name = "ConsentRequiredError";
  }
}

export class WorkCeilingExceededError extends Error {
  constructor() {
    super("Work Requirement exceeds a configured work ceiling");
    this.name = "WorkCeilingExceededError";
  }
}

export class TrustedConsentRequiredError extends Error {
  constructor() {
    super("Authority-origin WebAuthn confirmation is required before Start");
    this.name = "TrustedConsentRequiredError";
  }
}

export type HeadlessClientInput = {
  challenge: WorkChallengeInput;
  claimantIdentity: PreparedClaimantIdentity;
  signedPoolOfferSet: SignedPoolOfferSetInput;
  authorityTrust: AuthorityTrustInput;
  selection: PoolSelectionInput;
  workers: readonly WorkerDisclosure[];
  claimantWorkCeiling: string;
  clientSafetyCeiling: string;
  transport: HeadlessTransport;
  maybeNowUnixSeconds?: () => number;
  maybeRestoration?: {
    challengeState: "issued" | "active" | "satisfied" | "pass_issued";
  };
};

export type WorkControlState =
  | "awaiting_consent"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "expired";

export type ChallengeLifecycleState =
  | "issued"
  | "active"
  | "satisfied"
  | "pass_issued"
  | "cancelled"
  | "expired";

export type LifecycleEvent =
  | {
      type: "lifecycle";
      challengeState: "issued";
      controlState: "awaiting_consent" | "ready";
    }
  | {
      type: "lifecycle";
      challengeState: "active";
      controlState: "running" | "paused";
    }
  | {
      type: "lifecycle";
      challengeState: "satisfied" | "pass_issued";
      controlState: "completed";
    }
  | {
      type: "lifecycle";
      challengeState: "cancelled";
      controlState: "cancelled";
    }
  | {
      type: "lifecycle";
      challengeState: "expired";
      controlState: "expired";
    };

export type ActivityEstimateInput =
  | { status: "unavailable" }
  | { status: "active"; hashrateHs: string };

export type HeadlessEvent =
  | LifecycleEvent
  | {
      type: "verified_progress";
      verifiedProgress: string;
      workRequirement: string;
      satisfied: boolean;
    }
  | ({ type: "activity_estimate" } & ActivityEstimateInput);

export type HeadlessClient = {
  claimantPublicJwk(): JsonWebKey;
  signClaimantProof(payload: Uint8Array): Promise<ArrayBuffer>;
  disclosure(): WorkConsentDisclosure;
  trustedConsentRequest(): TrustedConsentRequest | undefined;
  grantConsent(
    maybeTrustedConsentReceipt?: string,
    maybeSignal?: AbortSignal,
  ): Promise<WorkConsentReceipt>;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  subscribe(listener: (event: HeadlessEvent) => void): () => void;
  reportActivityEstimate(activity: ActivityEstimateInput): void;
  close(): void;
};
