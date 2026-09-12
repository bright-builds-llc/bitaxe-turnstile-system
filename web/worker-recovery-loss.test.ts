import { expect, test } from "bun:test";
import { WorkerRecoveryLoss } from "./worker-recovery-loss";

test("one-use loss journals before and after release and can transition to resume", async () => {
  // Arrange
  const owner = new WorkerRecoveryLoss(); owner.configure("loss");
  const calls: string[] = []; let closed = false;
  // Act
  await owner.cut({ prepareBoundary: () => { calls.push("prepare"); }, cleanupAfterFailure: async () => { throw new Error("unexpected_cleanup"); }, snapshot: () => ({ closed }), flush: async () => { calls.push("flush"); },
    disconnect: async () => { calls.push("cut"); return { schema: "worker-mining-interruption-v1", generation: 7, workDispatched: 1, workGateRemainingMs: 12000, ownershipReleased: true, controlRecordsSent: 0 }; },
    publishClosed: () => { closed = true; calls.push("publish"); },
    submit: async body => { expect(body.before).toEqual({ closed: false }); expect(body.after).toEqual({ closed: true }); calls.push("submit"); return { recovery_loss_saved: true }; },
  });
  // Assert
  expect(calls).toEqual(["prepare", "flush", "cut", "publish", "flush", "submit"]);
  expect(owner.armed).toBeFalse();
  expect(() => owner.configure("loss")).toThrow();
  expect(() => owner.configure("resume")).toThrow("recovery_loss_unsealed");
  owner.seal();
  owner.configure("resume"); expect(owner.armed).toBeFalse();
});

test("failed pre-loss flush consumes the arm without performing a disconnect", async () => {
  // Arrange
  const owner = new WorkerRecoveryLoss(); owner.configure("loss"); let cut = false, cleaned = false;
  // Act / Assert
  await expect(owner.cut({ prepareBoundary: () => {}, cleanupAfterFailure: async () => { cleaned = true; }, snapshot: () => ({}), flush: async () => { throw new Error("journal_failed"); },
    disconnect: async () => { cut = true; throw new Error("unexpected_cut"); }, publishClosed: () => {}, submit: async () => ({}) })).rejects.toThrow("journal_failed");
  expect(cut).toBeFalse(); expect(cleaned).toBeTrue(); expect(owner.armed).toBeFalse();
});

test("resume and legacy contexts cannot arm loss", () => {
  const owner = new WorkerRecoveryLoss(); owner.configure(undefined); expect(owner.armed).toBeFalse();
  owner.configure("resume"); expect(owner.armed).toBeFalse();
  expect(() => owner.configure("loss")).toThrow();
  expect(() => owner.configure("arbitrary")).toThrow();
});

test("a recovery page rejects a phase-less configuration instead of retaining an unexpected armed loss", () => {
  const owner = new WorkerRecoveryLoss(); owner.configure("loss");
  expect(() => owner.configure(undefined)).toThrow("recovery_phase_downgrade");
  expect(owner.armed).toBeTrue();
});

test("missing checkpoint cleans up even before polling begins and preserves cleanup errors", async () => {
  // Arrange
  const owner = new WorkerRecoveryLoss(); owner.configure("loss"); let cleaned = false;
  // Act
  const failed = owner.cut({ prepareBoundary: () => { throw new Error("checkpoint_missing"); },
    cleanupAfterFailure: async () => { cleaned = true; throw new Error("native_cleanup_failed"); },
    snapshot: () => ({}), flush: async () => { throw new Error("unexpected_flush"); },
    disconnect: async () => { throw new Error("unexpected_disconnect"); }, publishClosed: () => {}, submit: async () => ({}) });
  // Assert
  await expect(failed).rejects.toMatchObject({ errors: [expect.objectContaining({ message: "checkpoint_missing" }), expect.objectContaining({ message: "native_cleanup_failed" })] });
  expect(cleaned).toBeTrue(); expect(owner.armed).toBeFalse();
});
