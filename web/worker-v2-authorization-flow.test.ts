import { expect, test } from "bun:test";
import { createWorkerAcceptanceAuthorization } from "./worker-acceptance-authorization";
import { createWorkerV2PageOperations } from "./worker-v2-page";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";
import type { WorkerLeaseAuthorizationContext } from "./worker-lease-authorization";
import type { WorkerLeaseGrant } from "./worker-controller";
import { v2Idle, v2Input } from "./worker-v2-serial.fixture";

test("reviewed possession reaches observer, fixture, signing and Start without another proof", async () => {
  // Arrange: production cache flow, page operations, serial protocol and real signature verification.
  const h = await serialHarness();
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false, stratumV2Pair: { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64), scope: "share" } } });
  const controller = createWebSerialWorkerController(h.input); await controller.requestPermission();
  h.setNoiseHandler(async () => v2Idle("share"));
  h.setTelemetryEndpoint({ schema: "worker-telemetry-endpoint-v1", ipv4: v2Idle().observation.stationIpv4, httpPort: 80, observedAtUs: 200, bootOrdinal: 1, generation: 7 });
  let maybeReviewed: WorkerLeaseAuthorizationContext | undefined, maybeGrant: WorkerLeaseGrant | undefined;
  const order: string[] = []; let fixtureReady = false, loaded = false;
  const authorization = createWorkerAcceptanceAuthorization({
    requireStartScope() {}, maybeReviewedContext: () => maybeReviewed, reviewedContext: value => { maybeReviewed = value; },
    prove: () => controller.prepareWorkerLeaseAuthorizationContext("start"), showBinding() {}, state: () => ({}),
    attemptReview: () => controller.qualificationAttemptReview(), budgetReview: id => controller.acceptanceBudgetReview(id),
    async local(path, body) {
      order.push(path);
      if (path === "/budget-review-context") return { mode: "iterative", nonce: "review-nonce" };
      if (path === "/budget-review") return { budget_review_saved: true };
      if (path !== "/authorization-context" || !fixtureReady) throw Error("issuance_before_fixture");
      if (!("controlSessionBindingSha256" in body) || typeof body.controlSessionBindingSha256 !== "string") throw Error("missing_binding");
      maybeGrant = await h.grant({ controlSessionBindingSha256: body.controlSessionBindingSha256 }, { stratum: v2Input.stratum, qualificationAttempt: { schema: "worker-qualification-attempt-v1", id: v2Input.attemptId, ordinal: 18, purpose: "normal", maximumActiveMilliseconds: 180000 } });
      return { issued: true };
    },
  });
  const page = createWorkerV2PageOperations({ maybeReviewedBinding: () => maybeReviewed?.controlSessionBindingSha256,
    serializeRead: run => run(), changed() {}, phase: () => "candidate", scope: () => "share", connected: () => true,
    idle: () => !loaded, controller: () => controller, maybePreservation: () => undefined });
  try {
    await expect(page.stratumV2TelemetryEndpoint()).rejects.toThrow("v2_observer_possession_required");
    // Act: budget review caches the proof; observer and fixture readiness consume no new proof.
    await authorization.submitBudgetReview();
    const reviewedProofCount = h.received.filter(row => row.command === "prove_possession").length;
    const endpoint = await page.stratumV2TelemetryEndpoint(); order.push("observer_handshake");
    const binding = endpoint.controlSessionBindingSha256;
    await page.stratumV2Status("share", null, binding); fixtureReady = true; order.push("fixture_ready");
    await page.stratumV2Status("share", null, binding);
    const signedContext = await authorization.prepareStartAuthorization();
    expect(signedContext.controlSessionBindingSha256).toBe(binding); expect(maybeReviewed).toBeUndefined();
    if (!maybeGrant) throw Error("grant_not_issued"); loaded = true;
    await page.stratumV2Status("share", null, binding);
    expect((await controller.startLease(maybeGrant)).state).toBe("mining");
    // Assert: the production cache flow never refreshed possession between review and issuance.
    expect(h.received.filter(row => row.command === "prove_possession")).toHaveLength(reviewedProofCount);
    expect(order).toEqual(["/budget-review-context", "/budget-review", "observer_handshake", "fixture_ready", "/authorization-context"]);
    expect(h.received.some(row => row.command === "telemetry_cadence_arm")).toBeFalse();
  } finally { await controller.close(); }
});
