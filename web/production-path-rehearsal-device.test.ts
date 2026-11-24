import { afterEach, expect, test } from "bun:test";
import controllerFixture from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import signerVectors from "../conformance/bwg-worker-deployment-trust-0.2/authority-signer-vectors.json";
import { decodeBase64Url } from "./crypto-bytes";
import { rehearsalWorkerInput, type RehearsalDeviceLog } from "./production-path-rehearsal-device";
import { createWebSerialWorkerController } from "./webserial-worker-controller";
import { parseWorkerLeaseGrant, type WorkerLeaseGrant } from "./worker-controller";
import { signWorkerLeaseAuthorization } from "./worker-lease-authorization";

const CHALLENGE_ID = "challenge_00000000000000000000000000000021";
const PKCS8_ED25519_SEED_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** The fake board behind the production Web Serial controller, with a device clock the test moves. */
async function admittedBoard() {
  let deviceClockOffset = 0;
  const minerStarts: unknown[] = [];
  const { worker, log } = rehearsalWorkerInput({
    miner: {
      start: async (stratum) => {
        minerStarts.push(stratum);
      },
      stop: async () => undefined,
    },
    maybeDeviceClock: () => Math.floor(performance.now()) + deviceClockOffset,
    maybeRestoreConfirmationMilliseconds: 10,
    acquireLock: async () => () => undefined,
  });
  const controller = createWebSerialWorkerController({
    ...worker,
    continuityScope: { challengeId: CHALLENGE_ID, retentionExpiryUnixSeconds: Math.floor(Date.now() / 1000) + 600 },
  });
  closers.push(() => controller.close());
  await controller.requestPermission();
  const context = await controller.prepareWorkerLeaseAuthorizationContext("start");
  return {
    controller,
    log,
    minerStarts,
    binding: context.controlSessionBindingSha256,
    advanceDeviceClock(milliseconds: number) {
      deviceClockOffset += milliseconds;
    },
  };
}

/** A Start grant signed by the rehearsal's test Work Lease Authority for `binding`. */
async function signedGrant(binding: string): Promise<WorkerLeaseGrant> {
  const { authorization: _unused, ...request } = parseWorkerLeaseGrant({ ...controllerFixture.lease, challengeId: CHALLENGE_ID });
  const seed = decodeBase64Url(signerVectors.seedBase64Url, 43, "test seed");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from([...PKCS8_ED25519_SEED_PREFIX, ...seed]),
    "Ed25519",
    false,
    ["sign"],
  );
  const authorization = await signWorkerLeaseAuthorization({
    input: { operation: "start", activeChallengeId: CHALLENGE_ID, controlSessionBindingSha256: binding, request },
    sequence: "1",
    kid: signerVectors.trust.keys[0]!.kid,
    issuer: signerVectors.trust.issuer,
    audience: signerVectors.trust.audience,
    privateKey,
  });
  return { ...request, authorization };
}

function deviceOutcome(log: RehearsalDeviceLog) {
  return { leasesStarted: log.leasesStarted, startRejections: log.startRejections };
}

test("refuses a Start once the unused possession context is 60 s old", async () => {
  // Arrange
  const board = await admittedBoard();
  const grant = await signedGrant(board.binding);
  board.advanceDeviceClock(60_000);

  // Act
  const outcome = await board.controller.startLease(grant).then(() => "started", () => "refused");

  // Assert
  expect({ outcome, ...deviceOutcome(board.log), minerStarts: board.minerStarts.length })
    .toEqual({ outcome: "refused", leasesStarted: 0, startRejections: ["admission_required"], minerStarts: 0 });
});

test("starts while the unused possession context is under 60 s old", async () => {
  // Arrange
  const board = await admittedBoard();
  const grant = await signedGrant(board.binding);
  board.advanceDeviceClock(59_000);

  // Act
  const status = await board.controller.startLease(grant);

  // Assert
  expect({ state: status.state, ...deviceOutcome(board.log) })
    .toEqual({ state: "mining", leasesStarted: 1, startRejections: [] });
});

test("refuses a Start granted to another control session", async () => {
  // Arrange
  const board = await admittedBoard();
  const grant = await signedGrant("A".repeat(43));

  // Act
  const outcome = await board.controller.startLease(grant).then(() => "started", () => "refused");

  // Assert
  expect({ outcome, ...deviceOutcome(board.log) })
    .toEqual({ outcome: "refused", leasesStarted: 0, startRejections: ["authentication_failed"] });
});
