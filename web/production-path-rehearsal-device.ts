/**
 * Real-time fake serial Worker for the production-path rehearsal (Ticket 06).
 *
 * Test support only, never part of `bwg-core`. It speaks Worker Serial 0.2 with the
 * fixture device identity and capability, verifies every grant and renewal against
 * the Gate's test Work Lease Authority, and hands mining to a local CPU miner
 * through `miner`, since a browser cannot open a Stratum connection.
 */
import capabilityFixture from "../conformance/bwg-worker-deployment-trust-0.2/signed-capability.json";
import trustFixture from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import signerVectors from "../conformance/bwg-worker-deployment-trust-0.2/authority-signer-vectors.json";
import possessionFixture from "../conformance/bwg-worker-possession-0.2/fixtures.json";
import { decodeBase64Url, encodeBase64Url, sha256Base64UrlBytes } from "./crypto-bytes";
import { canonicalJson } from "./headless-values";
import {
  workerSerialTestRuntime,
  type WorkerSerialBrowserRuntime,
  type WorkerSerialPort,
} from "./webserial-worker-port";
import type { WebSerialWorkerControllerInput, WorkerSerialInternalOptions } from "./webserial-worker-controller";
import {
  parseWorkerLeaseGrant,
  parseWorkerLeaseRenewal,
  type WorkerLeaseGrant,
} from "./worker-controller";
import {
  parseWorkLeaseAuthorityTrust,
  verifyWorkerLeaseAuthorization,
} from "./worker-lease-authorization";
import {
  WORKER_SERIAL_MANIFEST,
  WORKER_SERIAL_PROFILE,
  WorkerSerialFramer,
  encodeWorkerSerialEnvelope,
  type WorkerSerialEnvelope,
} from "./worker-serial";
import { fixtureIdentityKey } from "./worker-serial-identity.fixture";

const FIRMWARE_SOURCE_COMMIT = "a".repeat(40);
const APP_ELF_SHA256 = "b".repeat(64);
const DEVICE_FILTER = { usbVendorId: 0x303a, usbProductId: 0x1001 };
const HEARTBEAT_MILLISECONDS = 1_000;
// A real board confirms restoration after its stop and cooling (about 47 s on hardware); the fake
// stops mining at once and confirms past the 30 s ordinary command timeout.
const RESTORE_CONFIRMATION_MILLISECONDS = 35_000;

/** Where the fake device sends the grant's Stratum credentials, and when to stop. */
export type RehearsalMiner = {
  start(stratum: { endpoint: string; username: string; password: string }): Promise<void>;
  stop(): Promise<void>;
};

export type RehearsalDeviceLog = {
  commands: string[];
  renewals: number;
  restorationReason: string | undefined;
  maybeRestorationConfirmedAfterMilliseconds?: number;
  /** The last frames each way, for diagnosing a failed rehearsal. */
  trace: string[];
};

/** Builds Worker Serial input whose port is the fake device. */
export function rehearsalWorkerInput(input: {
  challengeId: string;
  retentionExpiryUnixSeconds: number;
  miner: RehearsalMiner;
}): { worker: WebSerialWorkerControllerInput; log: RehearsalDeviceLog } {
  const log: RehearsalDeviceLog = { commands: [], renewals: 0, restorationReason: undefined, trace: [] };
  const port = fakeDevicePort(input.miner, log);
  let locked = false;
  const runtime: WorkerSerialBrowserRuntime = {
    serial: { requestPort: async () => port, getPorts: async () => [] },
    foreground: () => true,
    pageOpen: () => true,
    userActivation: () => true,
    now: () => performance.now(),
    maybeAfter(milliseconds, listener) {
      const timer = setTimeout(listener, milliseconds);
      return () => clearTimeout(timer);
    },
    async acquireLock() {
      if (locked) throw new Error("rehearsal serial lock is held");
      locked = true;
      return () => {
        locked = false;
      };
    },
    subscribePageExit: () => () => undefined,
    every(milliseconds, listener) {
      const timer = setInterval(listener, milliseconds);
      return () => clearInterval(timer);
    },
  };
  let maybeFingerprint: string | undefined;
  const options: WorkerSerialInternalOptions = {
    runtime,
    continuity: {
      challengeBindingSha256: async () => "A".repeat(43),
      maybeExpectedFingerprint: async () => maybeFingerprint,
      async establish(value) {
        maybeFingerprint = value;
      },
      async clear() {
        maybeFingerprint = undefined;
      },
    },
  };
  const worker = {
    deviceFilter: DEVICE_FILTER,
    trustedUpdateKeys: trustFixture.updateAuthority.keys,
    continuityScope: {
      challengeId: input.challengeId,
      retentionExpiryUnixSeconds: input.retentionExpiryUnixSeconds,
    },
    expectedFirmwareSourceCommit: FIRMWARE_SOURCE_COMMIT,
    expectedAppElfSha256: APP_ELF_SHA256,
    [workerSerialTestRuntime]: options,
  };
  return { worker, log };
}

function fakeDevicePort(miner: RehearsalMiner, log: RehearsalDeviceLog): WorkerSerialPort {
  const leaseTrust = parseWorkLeaseAuthorityTrust(signerVectors.trust);
  let maybeOutput: ReadableStreamDefaultController<Uint8Array> | undefined;
  let maybeReadable: ReadableStream<Uint8Array> | null = null;
  let maybeWritable: WritableStream<Uint8Array> | null = null;
  let maybeHeartbeat: ReturnType<typeof setInterval> | undefined;
  let framer = new WorkerSerialFramer();
  let session = "";
  let sequence = 0;
  let sessions = 0;
  let received = 0;
  let helloSeen = false;
  let admitted = false;
  let binding = "";
  let maybeLease: (WorkerLeaseGrant & { startedAt: number }) | undefined;
  let restorationReason = "reboot";
  let deviceIdentitySha256 = "";

  const now = () => Math.floor(performance.now());
  // Encoding is async, so frames go out one at a time to keep their sequence order.
  let outgoing: Promise<void> = Promise.resolve();
  function send(kind: WorkerSerialEnvelope["kind"], payload: Record<string, unknown>, ack = false) {
    outgoing = outgoing.then(async () => {
      if (!maybeOutput) return;
      if (kind !== "heartbeat") trace(`out ${kind} ${String(payload.op ?? payload.requestId ?? "")} seq=${sequence + 1}`);
      const frame = await encodeWorkerSerialEnvelope({
        profile: WORKER_SERIAL_PROFILE,
        kind,
        sessionId: session,
        sequence: ack ? 0 : ++sequence,
        payload,
      });
      maybeOutput?.enqueue(frame);
    });
    return outgoing;
  }
  // A start or renew reply reads the same clock reading its deadlines count from.
  function status(at = now()) {
    const base = {
      protocolVersion: "bwg-worker-controller/0.4",
      preservation: {
        schema: "worker-preservation-v1",
        settings_sha256: "1".repeat(64),
        authorization_high_water_sha256: "2".repeat(64),
        device_identity_sha256: deviceIdentitySha256,
        mine_on_boot: false,
      },
      monotonicMilliseconds: at,
    };
    if (!maybeLease) {
      return { ...base, state: "baseline", restoration: { status: "confirmed", reason: restorationReason } };
    }
    return {
      ...base,
      state: "mining",
      lease: {
        leaseId: maybeLease.leaseId,
        challengeId: maybeLease.challengeId,
        renewAtMonotonicMilliseconds: maybeLease.startedAt + maybeLease.renewAfterMilliseconds,
        expiresAtMonotonicMilliseconds: maybeLease.startedAt + maybeLease.durationMilliseconds,
      },
      restoration: { status: "pending" },
    };
  }
  async function reply(request: Record<string, unknown>, result: unknown) {
    await send("control", { protocolVersion: request.protocolVersion, requestId: request.requestId, ok: true, result });
  }
  async function reject(request: Record<string, unknown>, message: string) {
    await send("control", {
      protocolVersion: request.protocolVersion,
      requestId: request.requestId,
      ok: false,
      error: { code: "command_rejected", message },
    });
  }
  async function stopMining(reason: string) {
    if (maybeLease) await miner.stop();
    maybeLease = undefined;
    restorationReason = reason;
    log.restorationReason = reason;
  }
  async function hello(frame: WorkerSerialEnvelope) {
    session = encodeBase64Url(new Uint8Array(16).fill(++sessions));
    sequence = 0;
    admitted = false;
    await send("session", {
      op: "hello_ack",
      hostNonce: frame.payload.hostNonce,
      deviceNonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      serialManifest: WORKER_SERIAL_MANIFEST,
      firmwareSourceCommit: FIRMWARE_SOURCE_COMMIT,
      appElfSha256: APP_ELF_SHA256,
      receiveWindowBytes: 2048,
      receivedBytes: 0,
    }, true);
  }
  async function provePossession(request: Record<string, unknown>) {
    const claims = {
      ...(request.payload as object),
      profile: "bwg-worker-possession-proof/0.2",
      firmwareSourceCommit: FIRMWARE_SOURCE_COMMIT,
      appElfSha256: APP_ELF_SHA256,
      deviceIdentityJwk: possessionFixture.fixtureIdentity.publicJwk,
    };
    const header = encodeBase64Url(new TextEncoder().encode(canonicalJson({ alg: "Ed25519", typ: "bwg-worker-possession+jws" })));
    const payload = encodeBase64Url(new TextEncoder().encode(canonicalJson(claims)));
    const signature = await crypto.subtle.sign("Ed25519", await fixtureIdentityKey(), new TextEncoder().encode(`${header}.${payload}`));
    const response = {
      profile: "bwg-worker-possession/0.2",
      requestId: request.requestId,
      ok: true,
      result: { claims, compactJws: `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}` },
    };
    binding = await sha256Base64UrlBytes(new TextEncoder().encode(canonicalJson({
      profile: "bwg-worker-control-session/0.2",
      request,
      response,
    })));
    admitted = true;
    await send("control", response);
  }
  async function startLease(request: Record<string, unknown>) {
    const grant = parseWorkerLeaseGrant(request.payload);
    const { authorization, ...unsigned } = grant;
    try {
      await verifyWorkerLeaseAuthorization(authorization, {
        operation: "start",
        activeChallengeId: grant.challengeId,
        controlSessionBindingSha256: binding,
        request: unsigned,
      }, leaseTrust);
    } catch {
      await reject(request, "authentication_failed");
      return;
    }
    if (!("username" in grant.stratum)) {
      await reject(request, "unsupported_transport");
      return;
    }
    await miner.start(grant.stratum);
    const startedAt = now();
    maybeLease = { ...grant, startedAt };
    await reply(request, status(startedAt));
  }
  async function renewLease(request: Record<string, unknown>) {
    const renewal = parseWorkerLeaseRenewal(request.payload);
    const { authorization, ...unsigned } = renewal;
    if (!maybeLease) {
      await reject(request, "no_active_lease");
      return;
    }
    try {
      await verifyWorkerLeaseAuthorization(authorization, {
        operation: "renew",
        activeChallengeId: maybeLease.challengeId,
        controlSessionBindingSha256: binding,
        request: unsigned,
      }, leaseTrust);
    } catch {
      await reject(request, "authentication_failed");
      return;
    }
    const startedAt = now();
    maybeLease = { ...maybeLease, ...renewal, startedAt };
    log.renewals += 1;
    await reply(request, status(startedAt));
  }
  async function restore(request: Record<string, unknown>) {
    const requestedAt = now();
    await stopMining(String((request.payload as { reason: string }).reason));
    // Frames keep flowing while the confirmation waits, as heartbeats do on the board.
    setTimeout(() => {
      log.maybeRestorationConfirmedAfterMilliseconds = now() - requestedAt;
      void reply(request, status());
    }, RESTORE_CONFIRMATION_MILLISECONDS);
  }
  function trace(entry: string) {
    log.trace.push(`${now()} ${entry}`);
    if (log.trace.length > 40) log.trace.shift();
  }
  async function handle(frame: WorkerSerialEnvelope) {
    trace(`in ${frame.kind} ${String(frame.payload.op ?? frame.payload.command ?? "")} seq=${frame.sequence}`);
    if (frame.kind === "session" && frame.payload.op === "hello") return await hello(frame);
    if (frame.kind === "heartbeat") return;
    if (frame.kind === "session" && frame.payload.op === "close") {
      admitted = false;
      return;
    }
    const request = frame.payload;
    const command = String(request.command);
    log.commands.push(command);
    if (command === "prove_possession") return await provePossession(request);
    if (command === "discover") return await reply(request, capabilityFixture);
    if (!admitted) return await reject(request, "possession_required");
    if (command === "start_lease") return await startLease(request);
    if (command === "renew_lease") return await renewLease(request);
    if (command === "pause") await stopMining("paused");
    if (command === "cancel") await stopMining("cancelled");
    if (command === "restore") return await restore(request);
    await reply(request, status());
  }
  return {
    get readable() {
      return maybeReadable;
    },
    get writable() {
      return maybeWritable;
    },
    getInfo: () => DEVICE_FILTER,
    async open() {
      deviceIdentitySha256 ||= await deviceIdentityDigest();
      framer = new WorkerSerialFramer();
      received = 0;
      helloSeen = false;
      maybeReadable = new ReadableStream({
        start(controller) {
          maybeOutput = controller;
        },
        cancel() {
          maybeOutput = undefined;
        },
      });
      maybeWritable = new WritableStream({
        async write(bytes) {
          if (helloSeen) {
            received += bytes.length;
            await send("session", { op: "receive_credit", receivedBytes: received });
          }
          for (const frame of await framer.push(bytes)) {
            if (frame.kind === "session" && frame.payload.op === "hello") helloSeen = true;
            await handle(frame);
          }
        },
      });
      maybeHeartbeat = setInterval(() => {
        if (admitted) void send("heartbeat", {});
      }, HEARTBEAT_MILLISECONDS);
    },
    async close() {
      trace("close");
      clearInterval(maybeHeartbeat);
      if (maybeLease) await stopMining("lost_continuity");
      maybeOutput = undefined;
      maybeReadable = null;
      maybeWritable = null;
    },
  };
}

/** The preservation record names the fixture identity key's SHA-256, in hex. */
async function deviceIdentityDigest(): Promise<string> {
  const keyBytes = decodeBase64Url(possessionFixture.fixtureIdentity.publicJwk.x, 43, "fixture key");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", keyBytes.slice().buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
