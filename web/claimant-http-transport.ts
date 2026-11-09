/**
 * Claimant HTTP transport: the headless client's `HeadlessTransport` over an Authority's claimant
 * routes. Work Session and Pool Selection requests carry a Work Session proof, the Gate Pass lookup
 * an Issuance Proof, and progress and lifecycle arrive on the challenge's event stream. Every proof
 * is signed with the Claimant key the challenge is bound to.
 */
import { encodeBase64Url, sha256Base64UrlBytes } from "./crypto-bytes";
import type {
  AuthorityClientEvent,
  ChallengeLifecycleState,
  HeadlessTransport,
  PoolSelectionInput,
} from "./headless-client.types";
import { claimantIdentityAccess, type PreparedClaimantIdentity } from "./headless-key";
import type { WorkerLeaseGrant, WorkerLeaseRenewal } from "./worker-controller";
import type { WorkerLeaseAuthorizationContext } from "./worker-lease-authorization";

export const CLAIMANT_PROOF_HEADER = "bwg-claimant-proof";

export type ClaimantHttpTransportInput = {
  /** Authority public base URL; proofs name it even when the page proxies requests. */
  authorityBaseUrl: string;
  challengeId: string;
  claimantIdentity: PreparedClaimantIdentity;
  maybeNowUnixSeconds?: () => number;
};

export type GatePassRequest = { method: string; url: string };

export type ClaimantHttpTransport = HeadlessTransport & {
  selectPool(selection: PoolSelectionInput): Promise<void>;
  /** Reads the issued Gate Pass; call it once the challenge is `pass_issued`. */
  gatePass(): Promise<string>;
  /** A DPoP proof that presents `gatePass` in exactly one request to the Relying Service. */
  gatePassDpopProof(gatePass: string, request: GatePassRequest): Promise<string>;
};

export function createClaimantHttpTransport(input: ClaimantHttpTransportInput): ClaimantHttpTransport {
  const now = input.maybeNowUnixSeconds ?? (() => Math.floor(Date.now() / 1000));
  const challengePath = `/v0/challenges/${encodeURIComponent(input.challengeId)}`;
  const sign = (type: string, payload: Record<string, unknown>) =>
    signClaimantJwt(input.claimantIdentity, type, { jti: proofId(), iat: now(), ...payload });
  let maybeLease: WorkerLeaseGrant | undefined;

  async function workSession<T>(operation: string, body: Record<string, unknown>): Promise<T> {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const url = `${input.authorityBaseUrl}${challengePath}/work-session/${operation}`;
    const proof = await sign("bwg-work-session-proof+jwt", {
      htm: "POST",
      htu: url,
      challenge_id: input.challengeId,
      request_sha256: await sha256Base64UrlBytes(bytes),
    });
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [CLAIMANT_PROOF_HEADER]: proof },
      body: bytes,
    });
    if (!response.ok) throw new Error(`Work Session ${operation} failed: ${response.status}`);
    return (await response.json()) as T;
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
        deliver({ type: "verified_progress", acceptedHashes: progressHashes(eventData(message)) });
      });
      source.addEventListener("challenge_lifecycle", (message) => {
        deliver({ type: "challenge_lifecycle", state: lifecycleState(eventData(message)) });
      });
      return () => source.close();
    },
    async gatePass() {
      const url = `${input.authorityBaseUrl}${challengePath}/gate-pass`;
      const proof = await sign("bwg-issuance-proof+jwt", {
        htm: "GET",
        htu: url,
        challenge_id: input.challengeId,
      });
      const response = await fetch(url, { headers: { [CLAIMANT_PROOF_HEADER]: proof } });
      if (!response.ok) throw new Error(`Gate Pass lookup failed: ${response.status}`);
      const body = (await response.json()) as { gate_pass?: unknown };
      if (typeof body.gate_pass !== "string") throw new Error("Gate Pass is not issued");
      return body.gate_pass;
    },
    async gatePassDpopProof(gatePass, request) {
      return await sign("dpop+jwt", {
        htm: request.method,
        htu: request.url,
        ath: await sha256Base64UrlBytes(new TextEncoder().encode(gatePass)),
      });
    },
  };
}

async function signClaimantJwt(
  identity: PreparedClaimantIdentity,
  type: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const header = { typ: type, alg: "ES256", jwk: JSON.parse(identity.claimantKey()) };
  const signingInput = `${jsonSegment(header)}.${jsonSegment(payload)}`;
  const signature = await identity[claimantIdentityAccess]().sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function binding(maybeContext: WorkerLeaseAuthorizationContext | undefined): string {
  if (!maybeContext) throw new Error("Worker Lease authorization context is required");
  return maybeContext.controlSessionBindingSha256;
}

function eventData(message: Event): Record<string, unknown> {
  return JSON.parse((message as MessageEvent<string>).data) as Record<string, unknown>;
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

function proofId(): string {
  return `proof_${encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
}

function jsonSegment(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}
