import { expect, test } from "bun:test";
import vectors from "../conformance/bwg-worker-controller-0.4/restoration-qualification-vectors.json";
import { decodeWorkerControllerSerialRequestFor } from "./worker-controller-serial-codec";
import { parseWorkerLeaseGrant, parseWorkerLeaseRenewal, WORKER_CONTROLLER_PROTOCOL_VERSION } from "./worker-controller";
import {
  createClockDiscontinuityNonce, parseAuthorizationRejectionReview, parseClockDiscontinuityStimulusAck, parseClockDiscontinuityStimulusReview,
  parseRestorationReplayArtifact, parseRestorationWindow, WorkerRestorationHighWater,
} from "./worker-restoration-qualification";
import { serialToken } from "./worker-serial";

const codec = { protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION, label: "Worker Controller 0.4", parseGrant: parseWorkerLeaseGrant, parseRenewal: parseWorkerLeaseRenewal };
const frame = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const grant = { protocolVersion: "bwg-worker-controller/0.4", leaseId: "lease_restoration_01", challengeId: "challenge_restoration", authorization: "synthetic",
  durationMilliseconds: 60000, renewAfterMilliseconds: 20000, stratum: { endpoint: "stratum+tcp://127.0.0.1:3333/", username: "synthetic-user", password: "synthetic-password" } };
const renewal = { protocolVersion: "bwg-worker-controller/0.4", leaseId: "lease_restoration_01", authorization: "synthetic", durationMilliseconds: 60000, renewAfterMilliseconds: 20000 };

test.each(vectors.requests.valid)("the codec admits the exact $name request", ({ request }) => {
  // Arrange / Act
  const decoded = decodeWorkerControllerSerialRequestFor(frame(request), codec);
  // Assert
  expect(decoded).toEqual(request as never);
});

test.each(vectors.requests.invalid)("the codec rejects a $name", ({ request }) => {
  // Arrange / Act / Assert
  expect(() => decodeWorkerControllerSerialRequestFor(frame(request), codec)).toThrow();
});

test("a stimulus acknowledgement must echo the exact request nonce", () => {
  // Arrange / Act
  const ack = parseClockDiscontinuityStimulusAck(vectors.stimulusAck.valid, vectors.stimulusAck.requestNonce);
  // Assert
  expect(ack).toEqual(vectors.stimulusAck.valid as never);
});

test.each(vectors.stimulusAck.invalid)("a stimulus acknowledgement with $name is rejected", ({ response }) => {
  // Arrange / Act / Assert
  expect(() => parseClockDiscontinuityStimulusAck(response, vectors.stimulusAck.requestNonce)).toThrow();
});

test("stimulus nonces are fresh canonical 16-byte base64url tokens", () => {
  // Arrange / Act
  const nonces = Array.from({ length: 32 }, createClockDiscontinuityNonce);
  // Assert
  expect(nonces.every(serialToken)).toBeTrue();
  expect(new Set(nonces).size).toBe(nonces.length);
});

test.each(vectors.stimulusReview.valid)("stimulus review state $state with $discontinuitiesDetected detections parses exactly", response => {
  // Arrange / Act / Assert
  expect(parseClockDiscontinuityStimulusReview(response)).toEqual(response as never);
});

test.each(vectors.stimulusReview.invalid)("a stimulus review with $name is rejected", ({ response }) => {
  // Arrange / Act / Assert
  expect(() => parseClockDiscontinuityStimulusReview(response)).toThrow();
});

test.each(vectors.rejectionReview.valid)("the rejection review for $name parses exactly", ({ response }) => {
  // Arrange / Act / Assert
  expect(parseAuthorizationRejectionReview(response)).toEqual(response as never);
});

test.each(vectors.rejectionReview.invalid)("a rejection review with $name is rejected", ({ response }) => {
  // Arrange / Act / Assert
  expect(() => parseAuthorizationRejectionReview(response)).toThrow();
});

test.each([
  ["a 60,000/20,000 Start with one renewal", { grant, renewals: [renewal] }],
  ["a 60,000/20,000 Start without renewal", { grant, renewals: [] }],
  ["an explicitly Conservative Start", { grant: { ...grant, hardwareProfile: "conservative" }, renewals: [] }],
  ["the 30,000/10,000 expiry Start", { grant: { ...grant, durationMilliseconds: 30000, renewAfterMilliseconds: 10000 }, renewals: [] }],
])("restoration mode admits %s", (_name, input) => {
  // Arrange / Act
  const window = parseRestorationWindow(input);
  // Assert
  expect(window.grant.leaseId).toBe(grant.leaseId);
});

const attempt = { schema: "worker-qualification-attempt-v1", id: "AQEBAQEBAQEBAQEBAQEBAQ", ordinal: 1, purpose: "normal", maximumActiveMilliseconds: 180000 };
const campaign = { id: "AAAAAAAAAAAAAAAAAAAAAA", window: 0, maximumActiveMilliseconds: 180000 };
const soakAllowance = { schema: "worker-soak-allowance-v1", id: "AwMDAwMDAwMDAwMDAwMDAw", ordinal: 1, maximumActiveMilliseconds: 619050 };
test.each([
  ["a qualification attempt", { grant: { ...grant, qualificationAttempt: attempt }, renewals: [] }],
  ["an acceptance campaign", { grant: { ...grant, acceptanceCampaign: campaign }, renewals: [] }],
  ["a soak allowance", { grant: { ...grant, hardwareProfile: "upstream-default", soakAllowance }, renewals: [] }],
  ["another lease window", { grant: { ...grant, durationMilliseconds: 45000 }, renewals: [] }],
  ["a renewal on the expiry lease", { grant: { ...grant, durationMilliseconds: 30000, renewAfterMilliseconds: 10000 }, renewals: [renewal] }],
  ["two renewals", { grant, renewals: [renewal, renewal] }],
  ["a renewal for another lease", { grant, renewals: [{ ...renewal, leaseId: "lease_other" }] }],
  ["a short renewal", { grant, renewals: [{ ...renewal, durationMilliseconds: 30000, renewAfterMilliseconds: 10000 }] }],
  ["an unknown field", { grant, renewals: [], extra: true }],
])("restoration mode refuses %s", (_name, input) => {
  // Arrange / Act / Assert
  expect(() => parseRestorationWindow(input)).toThrow();
});

test("a replay artifact is a previously signed Start or renewal, unchanged", () => {
  // Arrange / Act
  const start = parseRestorationReplayArtifact({ operation: "start", grant });
  const renew = parseRestorationReplayArtifact({ operation: "renew", renewal });
  // Assert
  expect(start).toEqual({ operation: "start", grant: parseWorkerLeaseGrant(grant) });
  expect(renew).toEqual({ operation: "renew", renewal: parseWorkerLeaseRenewal(renewal) });
  for (const invalid of [{ operation: "start", renewal }, { operation: "renew", grant }, { operation: "pause" }, { operation: "start", grant, extra: 1 }]) expect(() => parseRestorationReplayArtifact(invalid)).toThrow();
});

test("high-water continuity exposes change epochs, never digests", () => {
  // Arrange
  const highWater = new WorkerRestorationHighWater();
  // Act
  highWater.observe({ authorization_high_water_sha256: "1".repeat(64) });
  highWater.observe({ authorization_high_water_sha256: "2".repeat(64) });
  highWater.observe({ authorization_high_water_sha256: "2".repeat(64) });
  // Assert
  expect(highWater.epoch).toBe(2);
  expect(highWater.compare("2".repeat(64))).toEqual({ fingerprintMatchesLatestObservation: true, fingerprintFirstObservedEpoch: 2 });
  expect(highWater.compare("1".repeat(64))).toEqual({ fingerprintMatchesLatestObservation: false, fingerprintFirstObservedEpoch: 1 });
  expect(highWater.compare("3".repeat(64))).toEqual({ fingerprintMatchesLatestObservation: false, fingerprintFirstObservedEpoch: null });
});
