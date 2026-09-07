import { expect, test } from "bun:test";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook, type WorkerSerialQualificationHook } from "./webserial-worker-controller";
import { workerSerialFailureCategory, type WorkerSerialFailureCategory } from "./worker-serial-errors";
import type { WorkerSerialDiagnostic } from "./worker-serial-diagnostics";

test("ordinary signed Start retains correlated rejection and closed diagnostic through cleanup", async () => {
  // Arrange
  const h = await serialHarness();
  const failures: WorkerSerialFailureCategory[] = [];
  const diagnostics: WorkerSerialDiagnostic[] = [];
  const hook: WorkerSerialQualificationHook = { suppressHeartbeats: false, maybeObserveSerialFailure: value => failures.push(value), maybeObserveDiagnostic: value => diagnostics.push(value) };
  Object.assign(h.input, { [workerSerialQualificationHook]: hook });
  const controller = createWebSerialWorkerController(h.input);
  await controller.requestPermission();
  const grant = await h.grant(await controller.prepareWorkerLeaseAuthorizationContext("start"));
  h.rejectStart("session_failed");
  // Act
  const category = await controller.startLease(grant).then(() => "unexpected_success", workerSerialFailureCategory);
  await controller.close();
  // Assert
  expect(category).toBe("command_rejected");
  expect(failures[0]).toBe("command_rejected");
  expect(diagnostics).toContainEqual({ category: "control_failure", authoritative: false, error: "session_failed" });
  expect(h.counts()).toMatchObject({ active: false, closed: 1, locked: false });
});
