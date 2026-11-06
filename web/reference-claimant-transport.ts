/**
 * Claimant HTTP transport for the reference account-creation page (Ticket 06).
 *
 * Reference-page code, not SDK API: Ticket 17 moves it into `bwg-core`. It signs
 * each Work Session, Pool Selection and Gate Pass request with the claimant key,
 * and reads progress and lifecycle from the Authority's event stream.
 */
import { encodeBase64Url, sha256Base64UrlBytes } from "./crypto-bytes";
import type {
  AuthorityClientEvent,
  ChallengeLifecycleState,
  HeadlessTransport,
  PoolSelectionInput,
} from "./headless-client.types";
import type { WorkerLeaseGrant, WorkerLeaseRenewal } from "./worker-controller";
import type { WorkerLeaseAuthorizationContext } from "./worker-lease-authorization";

export const CLAIMANT_PROOF_HEADER = "bwg-claimant-proof";

/** The claimant key, which the headless client holds once it exists. */
export type ProofSigner = {
  claimantKey(): string;
  sign(payload: Uint8Array): Promise<ArrayBuffer>;
};

/** Signs one claimant proof JWT of the given type over `payload`. */
export async function signClaimantJwt(
  signer: ProofSigner,
  type: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const header = { typ: type, alg: "ES256", jwk: JSON.parse(signer.claimantKey()) };
  const signingInput = `${jsonSegment(header)}.${jsonSegment(payload)}`;
  const signature = await signer.sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export type ClaimantTransportInput = {
  /** Authority public base URL; proofs name it even when the page proxies requests. */
  authorityBaseUrl: string;
  challengeId: string;
  signer: ProofSigner;
  maybeNowUnixSeconds?: () => number;
};

export type ClaimantTransport = HeadlessTransport & {
  selectPool(selection: PoolSelectionInput): Promise<void>;
  /** The active lease, so the page can schedule Renew on its cadence. */
  maybeActiveLease(): WorkerLeaseGrant | undefined;
};

export function createClaimantTransport(input: ClaimantTransportInput): ClaimantTransport {
  const now = input.maybeNowUnixSeconds ?? (() => Math.floor(Date.now() / 1000));
  const challengePath = `/v0/challenges/${encodeURIComponent(input.challengeId)}`;
  let maybeLease: WorkerLeaseGrant | undefined;

  async function workSession<T>(operation: string, body: Record<string, unknown>): Promise<T> {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const path = `${challengePath}/work-session/${operation}`;
    const proof = await signClaimantJwt(input.signer, "bwg-work-session-proof+jwt", {
      jti: `proof_${crypto.randomUUID().replaceAll("-", "")}`,
      htm: "POST",
      htu: `${input.authorityBaseUrl}${path}`,
      iat: now(),
      challenge_id: input.challengeId,
      request_sha256: await sha256Base64UrlBytes(bytes),
    });
    const response = await fetch(`${input.authorityBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", [CLAIMANT_PROOF_HEADER]: proof },
      body: bytes,
    });
    if (!response.ok) throw new Error(`Work Session ${operation} failed: ${response.status}`);
    return (await response.json()) as T;
  }

  function binding(maybeContext: WorkerLeaseAuthorizationContext | undefined): string {
    if (!maybeContext) throw new Error("Worker Lease authorization context is required");
    return maybeContext.controlSessionBindingSha256;
  }

  return {
    async selectPool(selection) {
      await workSession("pool-selection", {
        pool_offer_id: selection.poolOfferId,
        payout_destination_type: selection.payoutDestinationType,
        payout_destination: selection.payoutDestinationType === "bitcoin_mainnet_address"
          ? selection.bitcoinMainnetAddress
          : selection.beneficiaryId,
      });
    },
    maybeActiveLease: () => maybeLease,
    async start(maybeReceipt, maybeContext) {
      maybeLease = await workSession<WorkerLeaseGrant>("start", {
        control_session_binding_sha256: binding(maybeContext),
        ...(maybeReceipt ? { trusted_consent_receipt: maybeReceipt } : {}),
      });
      return maybeLease;
    },
    async resume(maybeContext) {
      maybeLease = await workSession<WorkerLeaseGrant>("resume", {
        control_session_binding_sha256: binding(maybeContext),
      });
      return maybeLease;
    },
    async renewWorkerLease(maybeContext) {
      if (!maybeLease) throw new Error("No active Worker Lease to renew");
      return await workSession<WorkerLeaseRenewal>("renew", {
        control_session_binding_sha256: binding(maybeContext),
        lease_id: maybeLease.leaseId,
      });
    },
    async pause() {
      await workSession("pause", { reason: "user_requested" });
      maybeLease = undefined;
    },
    async cancel() {
      await workSession("cancel", { confirm_progress_loss: true });
      maybeLease = undefined;
    },
    subscribeAuthorityEvents(listener) {
      const source = new EventSource(`${input.authorityBaseUrl}${challengePath}/events`);
      const deliver = (event: AuthorityClientEvent) => {
        void listener(event).catch((error: unknown) => console.error(error));
      };
      source.addEventListener("verified_progress", (message) => {
        deliver({
          type: "verified_progress",
          acceptedHashes: progressHashes(JSON.parse((message as MessageEvent<string>).data)),
        });
      });
      source.addEventListener("challenge_lifecycle", (message) => {
        deliver({
          type: "challenge_lifecycle",
          state: lifecycleState(JSON.parse((message as MessageEvent<string>).data)),
        });
      });
      return () => source.close();
    },
  };
}

function progressHashes(value: { verified_progress?: unknown }): string {
  if (typeof value.verified_progress !== "string") throw new Error("progress event is invalid");
  return value.verified_progress;
}

function lifecycleState(value: { state?: unknown }): ChallengeLifecycleState {
  const states = ["issued", "active", "satisfied", "pass_issued", "cancelled", "expired"];
  if (typeof value.state !== "string" || !states.includes(value.state)) {
    throw new Error("lifecycle event is invalid");
  }
  return value.state as ChallengeLifecycleState;
}

function jsonSegment(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}
