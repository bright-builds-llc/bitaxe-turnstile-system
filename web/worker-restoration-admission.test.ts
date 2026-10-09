import { expect, test } from "bun:test";
import { maybeRestorationAdmission } from "./worker-restoration-admission";
import { maybeWorkerSerialDiagnostic } from "./worker-serial-diagnostics";

const line = (stage: string, failure: string, readiness: number) =>
  `worker_admission schema=v1 stage=${stage} first_failure=${failure} readiness=${readiness} budget_reserved_ms=30000 budget_complete=false redacted=true`;
const parsed = (text: string) => { const value = maybeWorkerSerialDiagnostic(text); if (!value) throw new Error("fixture_diagnostic"); return value; };

test("a worker_admission diagnostic projects stage, first failure and readiness without budget fields", () => {
  // Arrange / Act
  const admission = maybeRestorationAdmission(parsed(line("cleanup", "preparation", 63)));
  // Assert
  expect(admission).toEqual({ stage: "cleanup", firstFailure: "preparation", readiness: 63 });
});

test.each(["idle", "admission", "readiness", "preparation", "pool_activation", "active", "cleanup", "complete"])("stage %s is admitted", stage => {
  // Arrange / Act / Assert
  expect(maybeRestorationAdmission(parsed(line(stage, "none", 0)))?.stage).toBe(stage);
});

test("readiness above the six-bit mask is not projected", () => {
  // Arrange / Act / Assert
  expect(maybeRestorationAdmission({ category: "worker_admission", authoritative: false, stage: "readiness", first_failure: "readiness", readiness: 64 })).toBeUndefined();
});

test("other diagnostic categories are not admission observations", () => {
  // Arrange / Act / Assert
  expect(maybeRestorationAdmission(parsed("session_failed"))).toBeUndefined();
  expect(maybeRestorationAdmission({ category: "worker_admission", authoritative: false, stage: "debug", first_failure: "none", readiness: 1 })).toBeUndefined();
});
