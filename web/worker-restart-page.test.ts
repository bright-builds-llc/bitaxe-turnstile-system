import { expect, test } from "bun:test";
import { createWorkerRestartPageOperations } from "./worker-restart-page";

test("page restart guard rejects a loaded or unconfigured page before a controller call", async () => {
  let invoked = false;
  const page = createWorkerRestartPageOperations({ enabled: () => false, idle: () => false, maybeController: () => ({
    qualificationRestart: async () => { invoked = true; throw new Error("unexpected"); }, qualificationRestartEvidence: () => undefined,
  }), before() {}, succeeded() {}, failed() {} });
  await expect(page.qualificationRestart({ requestNonce: "A".repeat(22), expectedBootOrdinal: 1 })).rejects.toThrow();
  expect(invoked).toBeFalse(); expect(page.exportRestartEvidence()).toBeUndefined();
});

test("page restart failure is preserved while marking its transport state unavailable", async () => {
  const failure = new Error("synthetic restart failure"); let marked = false;
  const page = createWorkerRestartPageOperations({ enabled: () => true, idle: () => true, maybeController: () => ({
    qualificationRestart: async () => { throw failure; }, qualificationRestartEvidence: () => undefined,
  }), before() {}, succeeded() {}, failed() { marked = true; } });
  await expect(page.qualificationRestart({ requestNonce: "A".repeat(22), expectedBootOrdinal: 1 })).rejects.toBe(failure);
  expect(marked).toBeTrue();
});
