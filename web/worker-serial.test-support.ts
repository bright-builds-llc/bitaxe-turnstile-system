import {
  decodeBase64Url,
  encodeBase64Url,
  sha256Base64UrlBytes,
} from "./crypto-bytes";
import { canonicalJson } from "./headless-values";
import capabilityFixture from "../conformance/bwg-worker-deployment-trust-0.2/signed-capability.json";
import trustFixture from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import controllerFixture from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import possessionFixture from "../conformance/bwg-worker-possession-0.2/fixtures.json";
import {
  signWorkerLeaseAuthorization,
  verifyWorkerLeaseAuthorization,
  type WorkLeaseAuthorityTrust,
  type WorkerLeaseAuthorizationContext,
} from "./worker-lease-authorization";
import {
  parseWorkerLeaseGrant,
  parseWorkerLeaseRenewal,
  type WorkerLeaseGrant,
  type WorkerLeaseRenewal,
} from "./worker-controller";
import {
  WORKER_SERIAL_MANIFEST,
  WORKER_SERIAL_PROFILE,
  WorkerSerialFramer,
  exactSerialRecord,
  encodeWorkerSerialEnvelope,
  type WorkerSerialEnvelope,
} from "./worker-serial";
import {
  workerSerialTestRuntime,
  type WorkerSerialBrowserRuntime,
  type WorkerSerialPort,
} from "./webserial-worker-port";
import {
  createWebSerialWorkerController,
  type WebSerialWorkerControllerInput,
  type WorkerSerialInternalOptions,
} from "./webserial-worker-controller";

/** Public RFC 8032 vector identity; fixture-only signer, never production deployment material. */
async function fixtureIdentityKey() {
  const hex =
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  const bytes = Uint8Array.from(hex.match(/../gu) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
  return crypto.subtle.importKey("pkcs8", bytes, "Ed25519", false, ["sign"]);
}
export async function serialHarness(
  maybeChallengeId: string = controllerFixture.lease.challengeId,
) {
  const identityKey = await fixtureIdentityKey();
  const keyBytes = decodeBase64Url(
    possessionFixture.fixtureIdentity.publicJwk.x,
    43,
    "fixture key",
  );
  const deviceKeyHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", keyBytes.slice().buffer),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const preservation = {
    schema: "worker-preservation-v1",
    settings_sha256: "1".repeat(64),
    authorization_high_water_sha256: "2".repeat(64),
    device_identity_sha256: deviceKeyHash,
    mine_on_boot: false,
  };
  const leaseKeys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const publicKey = await crypto.subtle.exportKey("jwk", leaseKeys.publicKey);
  const trust: WorkLeaseAuthorityTrust = {
    profile: "bwg-worker-deployment-trust/0.2",
    issuer: "fixture-lease",
    audience: "bwg-worker-controller/0.4",
    role: "work_lease_authority",
    keys: [
      {
        kid: "fixture-lease",
        kty: "OKP",
        crv: "Ed25519",
        x: String(publicKey.x),
        alg: "Ed25519",
        use: "sig",
        key_ops: ["verify"],
      },
    ],
  };
  let now = 0,
    opened = 0,
    closed = 0,
    sequence = 0,
    session = "",
    deviceLastHeartbeat = 0;
  let foreground = true,
    locked = false,
    active = false,
    admitted = false,
    binding = "",
    authorizationSequence = 0;
  let reason = "reboot",
    dropHeartbeats = false,
    holdStart = false,
    holdRestore = false,
    delayedPermission = false;
  let maybePermission: ((port: WorkerSerialPort) => void) | undefined;
  let maybeOutput: ReadableStreamDefaultController<Uint8Array> | undefined;
  let maybeReadable: ReadableStream<Uint8Array> | null = null;
  let maybeWritable: WritableStream<Uint8Array> | null = null;
  let maybeStoredFingerprint: string | undefined;
  const callbacks = new Set<() => void>();
  const deadlines = new Set<{ at: number; call: () => void }>();
  let maybeDelayedRestore: Record<string, unknown> | undefined;
  const hidden = new Set<() => void>();
  const received: { kind: string; command?: string }[] = [];
  let maybeLease: WorkerLeaseGrant | undefined;
  const send = (
    kind: WorkerSerialEnvelope["kind"],
    payload: Record<string, unknown>,
    ack = false,
  ) => {
    if (!maybeOutput) return;
    const frame = encodeWorkerSerialEnvelope({
      profile: WORKER_SERIAL_PROFILE,
      kind,
      sessionId: session,
      sequence: ack ? 0 : ++sequence,
      payload,
    });
    // Exercise the production incremental reader with boundaries inside JSON strings.
    const split = Math.floor(frame.length / 2);
    maybeOutput.enqueue(frame.slice(0, split));
    maybeOutput.enqueue(frame.slice(split));
  };
  const status = () =>
    active && maybeLease
      ? {
        protocolVersion: "bwg-worker-controller/0.4",
        preservation,
        state: "mining",
        monotonicMilliseconds: now,
        lease: {
          leaseId: maybeLease.leaseId,
          challengeId: maybeLease.challengeId,
          renewAtMonotonicMilliseconds:
            now + maybeLease.renewAfterMilliseconds,
          expiresAtMonotonicMilliseconds:
            now + maybeLease.durationMilliseconds,
        },
        restoration: { status: "pending" },
      }
      : {
        protocolVersion: "bwg-worker-controller/0.4",
        preservation,
        state: "baseline",
        monotonicMilliseconds: now,
        restoration: { status: "confirmed", reason },
      };
  const reply = (request: Record<string, unknown>, result: unknown) =>
    send("control", {
      protocolVersion: request.protocolVersion,
      requestId: request.requestId,
      ok: true,
      result,
    });
  async function handle(frame: WorkerSerialEnvelope) {
    received.push({
      kind: frame.kind,
      ...(typeof frame.payload.command === "string"
        ? { command: frame.payload.command }
        : {}),
    });
    if (frame.kind === "session" && frame.payload.op === "hello") {
      session = encodeBase64Url(new Uint8Array(16).fill(opened));
      sequence = 0;
      admitted = false;
      send(
        "session",
        {
          op: "hello_ack",
          hostNonce: frame.payload.hostNonce,
          deviceNonce: encodeBase64Url(new Uint8Array(32).fill(9)),
          serialManifest: WORKER_SERIAL_MANIFEST,
          firmwareSourceCommit: "a".repeat(40),
          appElfSha256: "b".repeat(64),
        },
        true,
      );
      return;
    }
    if (frame.kind === "heartbeat") return;
    if (frame.kind === "session" && frame.payload.op === "close") {
      active = false;
      admitted = false;
      return;
    }
    const request = frame.payload;
    if (request.command === "prove_possession") {
      const claims = {
        ...(request.payload as object),
        profile: "bwg-worker-possession-proof/0.2",
        firmwareSourceCommit: "a".repeat(40),
        appElfSha256: "b".repeat(64),
        deviceIdentityJwk: possessionFixture.fixtureIdentity.publicJwk,
      };
      const header = encodeBase64Url(
        new TextEncoder().encode(
          canonicalJson({ alg: "Ed25519", typ: "bwg-worker-possession+jws" }),
        ),
      );
      const payload = encodeBase64Url(
        new TextEncoder().encode(canonicalJson(claims)),
      );
      const signature = await crypto.subtle.sign(
        "Ed25519",
        identityKey,
        new TextEncoder().encode(`${header}.${payload}`),
      );
      const response = {
        profile: "bwg-worker-possession/0.2",
        requestId: request.requestId,
        ok: true,
        result: {
          claims,
          compactJws: `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`,
        },
      };
      binding = await sha256Base64UrlBytes(
        new TextEncoder().encode(
          canonicalJson({
            profile: "bwg-worker-control-session/0.2",
            request,
            response,
          }),
        ),
      );
      admitted = true;
      send("control", response);
      return;
    }
    if (request.command === "discover") {
      reply(request, capabilityFixture);
      return;
    }
    if (!admitted) throw new Error("fixture requires possession");
    if (request.command === "start_lease") {
      const grant = parseWorkerLeaseGrant(request.payload);
      const { authorization, ...unsigned } = grant;
      await verifyWorkerLeaseAuthorization(
        authorization,
        {
          operation: "start",
          activeChallengeId: grant.challengeId,
          controlSessionBindingSha256: binding,
          request: unsigned,
        },
        trust,
      );
      maybeLease = grant;
      active = true;
      if (holdStart) return;
      reply(request, status());
      return;
    }
    if (request.command === "renew_lease") {
      const renewal = parseWorkerLeaseRenewal(request.payload);
      const { authorization, ...unsigned } = renewal;
      if (!maybeLease) throw new Error("fixture lease missing");
      await verifyWorkerLeaseAuthorization(
        authorization,
        {
          operation: "renew",
          activeChallengeId: maybeLease.challengeId,
          controlSessionBindingSha256: binding,
          request: unsigned,
        },
        trust,
      );
      maybeLease = { ...maybeLease, ...renewal };
      reply(request, status());
      return;
    }
    if (request.command === "transport_probe") {
      if (active) throw new Error("probe during lease");
      const payload = exactSerialRecord(request.payload, ["padding", "responsePaddingBytes"]);
      if (typeof payload.padding !== "string" || !Number.isSafeInteger(payload.responsePaddingBytes)) throw new Error("fixture probe payload");
      reply(request, { padding: payload.padding.padEnd(Number(payload.responsePaddingBytes), "x") });
      return;
    }
    if (["pause", "cancel", "restore"].includes(String(request.command))) {
      active = false;
      reason =
        request.command === "pause"
          ? "paused"
          : request.command === "cancel"
            ? "cancelled"
            : String((request.payload as { reason: string }).reason);
      if (holdRestore) {
        maybeDelayedRestore = request;
        return;
      }
    }
    reply(request, status());
  }
  const port: WorkerSerialPort = {
    get readable() {
      return maybeReadable;
    },
    get writable() {
      return maybeWritable;
    },
    getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
    async open() {
      opened++;
      const framer = new WorkerSerialFramer();
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
          for (const frame of framer.push(bytes)) await handle(frame);
        },
      });
    },
    async close() {
      closed++;
      maybeOutput = undefined;
      maybeReadable = null;
      maybeWritable = null;
    },
  };
  const runtime: WorkerSerialBrowserRuntime = {
    serial: {
      async requestPort() {
        if (delayedPermission)
          return new Promise<WorkerSerialPort>((resolve) => {
            maybePermission = resolve;
          });
        return port;
      },
    },
    foreground: () => foreground,
    userActivation: () => true,
    now: () => now,
    maybeAfter(milliseconds, call) {
      const deadline = { at: now + milliseconds, call };
      deadlines.add(deadline);
      return () => {
        deadlines.delete(deadline);
      };
    },
    async acquireLock() {
      if (locked) throw new Error("fixture lock held");
      locked = true;
      return () => {
        locked = false;
      };
    },
    subscribeForegroundLoss(listener) {
      hidden.add(listener);
      return () => hidden.delete(listener);
    },
    every(_ms, listener) {
      callbacks.add(listener);
      return () => callbacks.delete(listener);
    },
  };
  const options: WorkerSerialInternalOptions = {
    runtime,
    continuity: {
      async challengeBindingSha256() {
        return "A".repeat(43);
      },
      async maybeExpectedFingerprint() {
        return maybeStoredFingerprint;
      },
      async establish(value) {
        maybeStoredFingerprint = value;
      },
      async clear() {
        maybeStoredFingerprint = undefined;
      },
    },
  };
  const input: WebSerialWorkerControllerInput & {
    [workerSerialTestRuntime]: WorkerSerialInternalOptions;
  } = {
    deviceFilter: { usbVendorId: 0x303a, usbProductId: 0x1001 },
    trustedUpdateKeys: trustFixture.updateAuthority.keys,
    continuityScope: {
      challengeId: maybeChallengeId,
      retentionExpiryUnixSeconds: 2_000_000_000,
    },
    expectedFirmwareSourceCommit: "a".repeat(40),
    expectedAppElfSha256: "b".repeat(64),
    [workerSerialTestRuntime]: options,
  };
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    input,
    controller: createWebSerialWorkerController(input),
    received,
    counts: () => ({ opened, closed, locked, active }),
    async advance(milliseconds: number) {
      for (let elapsed = 0; elapsed < milliseconds; elapsed += 100) {
        now += Math.min(100, milliseconds - elapsed);
        if (admitted && !dropHeartbeats && now - deviceLastHeartbeat >= 1000) {
          deviceLastHeartbeat = now;
          send("heartbeat", {});
        }
        for (const callback of callbacks) callback();
        for (const deadline of deadlines)
          if (now >= deadline.at) {
            deadlines.delete(deadline);
            deadline.call();
          }
        await flush();
      }
    },
    async hide() {
      foreground = false;
      for (const callback of hidden) callback();
      await flush();
    },
    show() {
      foreground = true;
    },
    dropHeartbeats() {
      dropHeartbeats = true;
    },
    alterPreservation(
      field:
        | "settings_sha256"
        | "authorization_high_water_sha256"
        | "device_identity_sha256",
    ) {
      preservation[field] = "f".repeat(64);
    },
    holdStart() {
      holdStart = true;
    },
    holdRestore() {
      holdRestore = true;
    },
    completeRestore() {
      if (!maybeDelayedRestore) throw new Error("restore_not_pending");
      const request = maybeDelayedRestore;
      maybeDelayedRestore = undefined;
      holdRestore = false;
      reply(request, status());
    },
    delayPermission() {
      delayedPermission = true;
    },
    grantPermission() {
      delayedPermission = false;
      maybePermission?.(port);
    },
    jumpWhileUnconnected(milliseconds: number) {
      now += milliseconds;
    },
    async grant(
      context: WorkerLeaseAuthorizationContext,
    ): Promise<WorkerLeaseGrant> {
      const { authorization: _authorization, ...request } =
        parseWorkerLeaseGrant({
          ...controllerFixture.lease,
          challengeId: maybeChallengeId,
        });
      const authorization = await signWorkerLeaseAuthorization({
        input: {
          operation: "start",
          activeChallengeId: request.challengeId,
          controlSessionBindingSha256: context.controlSessionBindingSha256,
          request,
        },
        sequence: String(++authorizationSequence),
        kid: "fixture-lease",
        issuer: trust.issuer,
        audience: trust.audience,
        privateKey: leaseKeys.privateKey,
      });
      return { ...request, authorization };
    },
    async renewal(
      context: WorkerLeaseAuthorizationContext,
    ): Promise<WorkerLeaseRenewal> {
      const { authorization: _authorization, ...request } =
        parseWorkerLeaseRenewal(controllerFixture.renewal);
      const authorization = await signWorkerLeaseAuthorization({
        input: {
          operation: "renew",
          activeChallengeId: maybeChallengeId,
          controlSessionBindingSha256: context.controlSessionBindingSha256,
          request,
        },
        sequence: String(++authorizationSequence),
        kid: "fixture-lease",
        issuer: trust.issuer,
        audience: trust.audience,
        privateKey: leaseKeys.privateKey,
      });
      return { ...request, authorization };
    },
  };
}
