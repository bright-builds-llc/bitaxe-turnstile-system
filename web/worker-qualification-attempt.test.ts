import { expect, test } from "bun:test";
import vectors from "../conformance/bwg-worker-controller-0.4/qualification-attempt-vectors.json";
import { parseWorkerLeaseGrant } from "./worker-controller";
import { parseWorkLeaseAuthorityTrust, verifyWorkerLeaseAuthorization } from "./worker-lease-authorization";
import { parseWorkerQualificationAttempt, parseWorkerQualificationLedger } from "./worker-qualification-attempt";
import { acceptancePurposeWindow, acceptanceMaximumActiveMilliseconds } from "./worker-acceptance-purpose";

for (const vector of vectors.vectors) test(`signed ${vector.purpose} qualification metadata survives parsing and rejects tampering`, async () => {
  // Arrange
  const trust = parseWorkLeaseAuthorityTrust(vectors.trust);
  const grant = parseWorkerLeaseGrant(vector.grant);
  const { authorization, ...request } = grant;
  const input = { operation: "start" as const, activeChallengeId: grant.challengeId, controlSessionBindingSha256: vector.input.controlSessionBindingSha256, request };
  // Act / Assert
  await expect(verifyWorkerLeaseAuthorization(authorization, input, trust)).resolves.toMatchObject({ sequence: BigInt(grant.qualificationAttempt!.ordinal) });
  const attempt = grant.qualificationAttempt!;
  for (const changed of [{ ...attempt, ordinal: attempt.ordinal + 1 }, { ...attempt, id: "AQAAAAAAAAAAAAAAAAAAAA" }, { ...attempt, purpose: "normal" as const, maximumActiveMilliseconds: 180000 as const, ordinal: 100 }]) await expect(verifyWorkerLeaseAuthorization(authorization, { ...input, request: { ...request, qualificationAttempt: changed } }, trust)).rejects.toThrow();
  expect(acceptanceMaximumActiveMilliseconds(grant)).toBe(attempt.maximumActiveMilliseconds);
  expect(acceptancePurposeWindow(grant)).toBe(({ diagnostic: -1, normal: 0, foreground_loss: 1, heartbeat_loss: 2 })[attempt.purpose]);
});
test("qualification attempt rejects dual modes and invalid bounds", () => {
  const base = vectors.vectors[0]!.grant;
  expect(() => parseWorkerLeaseGrant({ ...base, acceptanceCampaign: { id: "AAAAAAAAAAAAAAAAAAAAAA", window: 0, maximumActiveMilliseconds: 180000 } })).toThrow();
  for (const invalid of [{ ...base.qualificationAttempt, ordinal: 0 }, { ...base.qualificationAttempt, ordinal: 4294967296 }, { ...base.qualificationAttempt, id: "AAAAAAAAAAAAAAAAAAAAAB" }, { ...base.qualificationAttempt, maximumActiveMilliseconds: 180000 }, { ...base.qualificationAttempt, extra: "private" }]) expect(() => parseWorkerQualificationAttempt(invalid)).toThrow();
});
test("attempt ledger distinguishes ordinal exhaustion and rejects inconsistent progress", () => {
  const empty = { schema: "worker-qualification-ledger-v1", next_ordinal: 1, total_charged_ms: 0, pending: false, last_completed_ordinal: 0 };
  expect(parseWorkerQualificationLedger(empty).next_ordinal).toBe(1);
  expect(parseWorkerQualificationLedger({ ...empty, next_ordinal: 4294967296, last_completed_ordinal: 4294967295 }).next_ordinal).toBe(4294967296);
  for (const invalid of [{ ...empty, pending: true }, { ...empty, last_completed_ordinal: 1 }, { ...empty, total_charged_ms: Number.MAX_SAFE_INTEGER + 1 }, { ...empty, next_ordinal: 4294967297 }]) expect(() => parseWorkerQualificationLedger(invalid)).toThrow();
});

test("actual possessed browser adapter reviews the separate attempt ledger", async () => {
  const { serialHarness } = await import("./worker-serial.test-support");
  const h = await serialHarness();
  await h.controller.requestPermission();
  try {
    expect(await h.controller.qualificationAttemptReview()).toEqual({ schema: "worker-qualification-ledger-v1", next_ordinal: 1, total_charged_ms: 0, pending: false, last_completed_ordinal: 0 });
    expect(h.received.some(value => value.command === "qualification_attempt_review")).toBeTrue();
  } finally { await h.controller.close(); }
});
