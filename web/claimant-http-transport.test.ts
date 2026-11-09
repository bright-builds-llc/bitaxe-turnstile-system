import { afterEach, expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import {
  CLAIMANT_PROOF_HEADER,
  createClaimantHttpTransport,
  type ClaimantHttpTransport,
} from "./claimant-http-transport";
import { sha256Base64UrlBytes } from "./crypto-bytes";
import type { AuthorityClientEvent } from "./headless-client.types";
import { prepareClaimantIdentity, type PreparedClaimantIdentity } from "./headless-key";

const AUTHORITY = "https://authority.example";
const CHALLENGE_ID = "chl_01";
const NOW = 1_000;
const context = { controlSessionBindingSha256: "binding_digest" } as const;

type Recorded = { url: string; method: string; headers: Headers; body: string };

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
});

function answering(...bodies: { status?: number; json: unknown }[]): Recorded[] {
  const requests: Recorded[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? new TextDecoder().decode(init.body as Uint8Array) : "",
    });
    const next = bodies.shift() ?? { json: {} };
    return new Response(JSON.stringify(next.json), { status: next.status ?? 200 });
  }, { preconnect: originalFetch.preconnect });
  return requests;
}

async function transportFor(): Promise<{ transport: ClaimantHttpTransport; identity: PreparedClaimantIdentity }> {
  const identity = await prepareClaimantIdentity({ maybeClock: () => NOW });
  const transport = createClaimantHttpTransport({
    authorityBaseUrl: AUTHORITY,
    challengeId: CHALLENGE_ID,
    claimantIdentity: identity,
    maybeNowUnixSeconds: () => NOW,
  });
  return { transport, identity };
}

/** Decodes a compact JWS after checking its ES256 signature against the Claimant key. */
async function verifiedProof(
  identity: PreparedClaimantIdentity,
  proof: string,
): Promise<{ header: Record<string, unknown>; payload: Record<string, unknown> }> {
  const [header = "", payload = "", signature = ""] = proof.split(".");
  const key = await crypto.subtle.importKey(
    "jwk",
    identity.claimantPublicJwk(),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!valid) throw new Error("claimant proof signature is invalid");
  const decode = (segment: string) => JSON.parse(Buffer.from(segment, "base64url").toString()) as Record<string, unknown>;
  return { header: decode(header), payload: decode(payload) };
}

function proofOf(request: Recorded | undefined): string {
  const maybeProof = request?.headers.get(CLAIMANT_PROOF_HEADER);
  if (!maybeProof) throw new Error("request carries no claimant proof");
  return maybeProof;
}

test("Start posts to the Work Session route with a signed proof bound to the request", async () => {
  // Arrange
  const { transport, identity } = await transportFor();
  const requests = answering({ json: fixtures.lease });

  // Act
  const grant = await transport.start("receipt_01", context);

  // Assert
  const url = `${AUTHORITY}/v0/challenges/${CHALLENGE_ID}/work-session/start`;
  expect(grant).toEqual(fixtures.lease as typeof grant);
  expect(requests[0]?.url).toBe(url);
  expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
    control_session_binding_sha256: "binding_digest",
    trusted_consent_receipt: "receipt_01",
  });
  const { header, payload } = await verifiedProof(identity, proofOf(requests[0]));
  expect(header).toMatchObject({ typ: "bwg-work-session-proof+jwt", alg: "ES256" });
  expect(payload).toMatchObject({
    htm: "POST",
    htu: url,
    iat: NOW,
    challenge_id: CHALLENGE_ID,
    request_sha256: await sha256Base64UrlBytes(new TextEncoder().encode(requests[0]?.body)),
  });
});

test("Start without a Worker Lease authorization context sends nothing", async () => {
  // Arrange
  const { transport } = await transportFor();
  const requests = answering();

  // Act
  const start = transport.start(undefined, undefined);

  // Assert
  await expect(start).rejects.toThrow("Worker Lease authorization context is required");
  expect(requests).toEqual([]);
});

test("Renew names the lease that Start granted", async () => {
  // Arrange
  const { transport } = await transportFor();
  const requests = answering({ json: fixtures.lease }, { json: fixtures.renewal });
  await transport.start(undefined, context);

  // Act
  const renewal = await transport.renewWorkerLease?.(context);

  // Assert
  expect(renewal).toEqual(fixtures.renewal as typeof renewal);
  expect(requests[1]?.url).toEndWith("/work-session/renew");
  expect(JSON.parse(requests[1]?.body ?? "")).toEqual({
    control_session_binding_sha256: "binding_digest",
    lease_id: fixtures.lease.leaseId,
  });
});

test("Renew after Pause is refused without a request", async () => {
  // Arrange
  const { transport } = await transportFor();
  const requests = answering({ json: fixtures.lease }, { json: {} });
  await transport.start(undefined, context);
  await transport.pause();

  // Act
  const renewal = transport.renewWorkerLease?.(context);

  // Assert
  await expect(renewal).rejects.toThrow("No active Worker Lease to renew");
  expect(requests.map((request) => request.url.split("/").at(-1))).toEqual(["start", "pause"]);
});

test("an Authority refusal rejects with the Work Session operation and status", async () => {
  // Arrange
  const { transport } = await transportFor();
  answering({ status: 409, json: { error: "lifecycle transition is forbidden" } });

  // Act
  const resume = transport.resume(context);

  // Assert
  await expect(resume).rejects.toThrow("Work Session resume failed: 409");
});

test("Pool Selection sends the selected offer and payout destination", async () => {
  // Arrange
  const { transport } = await transportFor();
  const requests = answering();

  // Act
  await transport.selectPool({
    poolOfferId: "offer_01",
    payoutDestinationType: "approved_beneficiary",
    beneficiaryId: "beneficiary_01",
  });

  // Assert
  expect(requests[0]?.url).toEndWith("/work-session/pool-selection");
  expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
    pool_offer_id: "offer_01",
    payout_destination_type: "approved_beneficiary",
    payout_destination: "beneficiary_01",
  });
});

test("the Gate Pass lookup carries a Claimant Issuance Proof and returns the pass", async () => {
  // Arrange
  const { transport, identity } = await transportFor();
  const requests = answering({ json: { status: "issued", gate_pass: "gate.pass.jws" } });

  // Act
  const gatePass = await transport.gatePass();

  // Assert
  const url = `${AUTHORITY}/v0/challenges/${CHALLENGE_ID}/gate-pass`;
  expect(gatePass).toBe("gate.pass.jws");
  expect(requests[0]).toMatchObject({ url, method: "GET" });
  const { header, payload } = await verifiedProof(identity, proofOf(requests[0]));
  expect(header.typ).toBe("bwg-issuance-proof+jwt");
  expect(payload).toMatchObject({ htm: "GET", htu: url, iat: NOW, challenge_id: CHALLENGE_ID });
});

test("a pending Gate Pass lookup is refused", async () => {
  // Arrange
  const { transport } = await transportFor();
  answering({ json: { status: "pending" } });

  // Act
  const lookup = transport.gatePass();

  // Assert
  await expect(lookup).rejects.toThrow("Gate Pass is not issued");
});

test("the Gate Pass DPoP proof binds the redemption request and the pass", async () => {
  // Arrange
  const { transport, identity } = await transportFor();
  const request = { method: "POST", url: "https://rp.example/account-creation/redeem" };

  // Act
  const proof = await transport.gatePassDpopProof("gate.pass.jws", request);

  // Assert
  const { header, payload } = await verifiedProof(identity, proof);
  expect(header.typ).toBe("dpop+jwt");
  expect(payload).toMatchObject({
    htm: "POST",
    htu: request.url,
    iat: NOW,
    ath: await sha256Base64UrlBytes(new TextEncoder().encode("gate.pass.jws")),
  });
});

test("Authority events arrive as Verified Progress and lifecycle until unsubscribed", async () => {
  // Arrange
  const { transport } = await transportFor();
  const sources: FakeEventSource[] = [];
  globalThis.EventSource = class extends FakeEventSource {
    constructor(url: string) {
      super(url);
      sources.push(this);
    }
  } as unknown as typeof EventSource;
  const events: AuthorityClientEvent[] = [];
  const unsubscribe = transport.subscribeAuthorityEvents(async (event) => {
    events.push(event);
  });

  // Act
  sources[0]?.dispatch("verified_progress", { verified_progress: "42" });
  sources[0]?.dispatch("challenge_lifecycle", { state: "satisfied" });
  unsubscribe();

  // Assert
  expect(sources[0]?.url).toBe(`${AUTHORITY}/v0/challenges/${CHALLENGE_ID}/events`);
  expect(events).toEqual([
    { type: "verified_progress", acceptedHashes: "42" },
    { type: "challenge_lifecycle", state: "satisfied" },
  ]);
  expect(sources[0]?.closed).toBe(true);
});

class FakeEventSource extends EventTarget {
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  dispatch(type: string, data: unknown): void {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close(): void {
    this.closed = true;
  }
}
