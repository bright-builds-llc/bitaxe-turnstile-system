import { expect, test } from "bun:test";
import vectors from "../conformance/bwg-worker-controller-0.4/restoration-qualification-vectors.json";
import { createWebSerialWorkerController, workerSerialQualificationHook, type WorkerSerialQualificationHook } from "./webserial-worker-controller";
import { serialHarness } from "./worker-serial.test-support";

type Request = Record<string, unknown>;
async function fixture(hook: Partial<WorkerSerialQualificationHook> | null = { allowClockDiscontinuityStimulus: true }) {
  const h = await serialHarness();
  const requests: Request[] = [];
  h.setCommandHandler(async request => {
    if (request.command === "clock_discontinuity_stimulus") {
      requests.push(request);
      const payload = request.payload as { requestNonce: string };
      return { ok: true, result: { ...vectors.stimulusAck.valid, requestNonce: payload.requestNonce } };
    }
    if (request.command === "clock_discontinuity_stimulus_review") { requests.push(request); return { ok: true, result: vectors.stimulusReview.valid[2] }; }
    if (request.command === "authorization_rejection_review") { requests.push(request); return { ok: true, result: vectors.rejectionReview.valid[1]?.response }; }
    if (request.command === "boot_review") { requests.push(request); return { ok: true, result: vectors.bootReview.valid[0] }; }
    return undefined;
  });
  const input = { ...h.input, [workerSerialQualificationHook]: { suppressHeartbeats: false, ...hook } };
  const controller = hook ? createWebSerialWorkerController(input) : h.controller;
  await controller.requestPermission();
  return { h, controller, requests };
}
async function started(f: Awaited<ReturnType<typeof fixture>>) {
  const context = await f.controller.prepareWorkerLeaseAuthorizationContext("start");
  await f.controller.startLease(await f.h.grant(context));
  return context;
}

test("the stimulus sends one fresh canonical nonce and returns the echoed acknowledgement", async () => {
  // Arrange
  const f = await fixture();
  try {
    await started(f);
    // Act
    const ack = await f.controller.clockDiscontinuityStimulus();
    // Assert
    expect(f.requests).toHaveLength(1);
    expect(Object.keys(f.requests[0]?.payload as object)).toEqual(["requestNonce"]);
    expect(ack.requestNonce).toBe((f.requests[0]?.payload as { requestNonce: string }).requestNonce);
    expect(ack).toMatchObject({ schema: "worker-clock-discontinuity-stimulus-v1", offsetMilliseconds: 1000, armedForMilliseconds: 2000 });
  } finally { await f.controller.close(); }
});

test("a stimulus acknowledgement for another nonce fails the session", async () => {
  // Arrange
  const f = await fixture();
  f.h.setCommandHandler(async request => request.command === "clock_discontinuity_stimulus" ? { ok: true, result: vectors.stimulusAck.valid } : undefined);
  try {
    await started(f);
    // Act / Assert
    await expect(f.controller.clockDiscontinuityStimulus()).rejects.toThrow();
  } finally { await f.controller.close().catch(() => undefined); }
});

test.each([
  ["without the explicit hook flag", { allowCoreDumpSelfTest: true }, true],
  ["without any qualification hook", null, true],
  ["without an active lease", { allowClockDiscontinuityStimulus: true }, false],
])("the stimulus is refused before any write %s", async (_name, hook, lease) => {
  // Arrange
  const f = await fixture(hook);
  try {
    if (lease) await started(f);
    const before = f.h.received.length;
    // Act / Assert
    await expect(f.controller.clockDiscontinuityStimulus()).rejects.toThrow();
    expect(f.h.received.length).toBe(before);
  } finally { await f.controller.close(); }
});

test("after a stimulus the active lease is never renewed by the Gate", async () => {
  // Arrange
  const f = await fixture();
  try {
    const context = await started(f);
    const renewal = await f.h.renewal(context);
    await f.controller.clockDiscontinuityStimulus();
    const before = f.h.received.length;
    // Act / Assert
    await expect(f.controller.renewLease(renewal)).rejects.toThrow();
    await expect(f.controller.clockDiscontinuityStimulus()).rejects.toThrow();
    expect(f.h.received.length).toBe(before);
  } finally { await f.controller.close(); }
});

const reviewCommands = { clockDiscontinuityStimulusReview: "clock_discontinuity_stimulus_review", authorizationRejectionReview: "authorization_rejection_review", bootReview: "boot_review" } as const;
test.each(["clockDiscontinuityStimulusReview", "authorizationRejectionReview", "bootReview"] as const)("%s proves fresh possession and sends exactly an empty payload", async method => {
  // Arrange
  const f = await fixture();
  try {
    const before = f.h.received.length;
    // Act
    const review = await f.controller[method]();
    // Assert
    expect(f.h.received.slice(before).map(value => value.command)).toEqual(["prove_possession", reviewCommands[method]]);
    expect(f.requests[0]?.payload).toEqual({});
    expect(review.schema).toMatch(/review-v1$/u);
  } finally { await f.controller.close(); }
});

test.each(["clockDiscontinuityStimulusReview", "authorizationRejectionReview", "bootReview"] as const)("%s is refused during an active lease", async method => {
  // Arrange
  const f = await fixture();
  try {
    await started(f);
    const before = f.h.received.length;
    // Act / Assert
    await expect(f.controller[method]()).rejects.toThrow();
    expect(f.h.received.length).toBe(before);
  } finally { await f.controller.close(); }
});

test("an unknown review field fails closed", async () => {
  // Arrange
  const f = await fixture();
  f.h.setCommandHandler(async request => request.command === "authorization_rejection_review" ? { ok: true, result: { ...vectors.rejectionReview.valid[0]?.response, keyId: "k" } } : undefined);
  try {
    // Act / Assert
    await expect(f.controller.authorizationRejectionReview()).rejects.toThrow();
  } finally { await f.controller.close().catch(() => undefined); }
});

test("a version 2 rejection review reaches the caller with its safe-stop reason", async () => {
  // Arrange
  const f = await fixture();
  const response = vectors.rejectionReviewV2.valid[4]?.response;
  f.h.setCommandHandler(async request => request.command === "authorization_rejection_review" ? { ok: true, result: response } : undefined);
  try {
    // Act
    const review = await f.controller.authorizationRejectionReview();
    // Assert
    expect(review).toEqual(response as never);
  } finally { await f.controller.close(); }
});
