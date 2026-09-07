import { expect, test } from "bun:test";
import { maybeWorkerSerialDiagnostic, WorkerSerialDiagnosticHistory } from "./worker-serial-diagnostics";
import { parseWorkerDiagnosticExport } from "./worker-diagnostic-export";
const previous = "worker_preparation_receipt schema=v1 origin=previous_boot status=valid interrupted=true source_hash=0123456789abcdef boot_ordinal=18446744073709551615 generation=7 sequence=3 uptime_ms=987 last_completed_step=1 current_step=2 outcome=started failure=none heap_free=1000 heap_largest=900 stack_free=unavailable redacted=true";
test("previous-boot receipt remains exact and survives current diagnostic churn and reconnect", () => {
  // Arrange
  const history = new WorkerSerialDiagnosticHistory();
  const receipt = maybeWorkerSerialDiagnostic(previous)!;
  history.observe(receipt);
  // Act
  for (let i = 0; i < 100; i++) history.observe({ category: "synthetic", stage: String(i) });
  history.clear();
  // Assert
  expect(history.values()).toEqual([receipt]);
  expect(receipt.boot_ordinal).toBe("18446744073709551615");
  expect(parseWorkerDiagnosticExport({ schema: "worker-diagnostic-export-v1", observations: history.values() }).observations).toEqual([receipt]);
});
test("diagnostic export revalidates existing closed producers and rejects attached secrets", () => {
  const receipt = maybeWorkerSerialDiagnostic("worker_admission schema=v1 stage=cleanup first_failure=readiness readiness=55 budget_reserved_ms=240000 budget_complete=true redacted=true")!;
  expect(parseWorkerDiagnosticExport({ schema: "worker-diagnostic-export-v1", observations: [receipt] }).observations).toEqual([receipt]);
  for (const invalid of [{ ...receipt, private: "secret" }, { ...receipt, first_failure: "private" }, { ...receipt, budget_reserved_ms: 240001 }]) expect(() => parseWorkerDiagnosticExport({ schema: "worker-diagnostic-export-v1", observations: [invalid] })).toThrow();
});
test("preparation grammar rejects inferred or corrupt payloads and overflow", () => {
  for (const invalid of [previous.replace("failure=none", "failure=asic_failed"), previous.replace("outcome=started", "outcome=failed"), previous.replace("failure=none", "failure=private"), previous.replace("status=valid interrupted=true", "status=corrupt"), previous.replace("18446744073709551615", "18446744073709551616"), previous.replace("generation=7", "generation=4294967296"), `${previous} private=secret`]) expect(maybeWorkerSerialDiagnostic(invalid)).toBeUndefined();
});

test("typed preparation failure exports the actual closed failure category", () => {
  const line = previous.replace("outcome=started", "outcome=failed").replace("failure=none", "failure=asic_failed");
  const receipt = maybeWorkerSerialDiagnostic(line)!;
  expect(receipt.failure).toBe("asic_failed");
  expect(parseWorkerDiagnosticExport({ schema: "worker-diagnostic-export-v1", observations: [receipt] }).observations).toEqual([receipt]);
});


test("late cancellation preserves a completed step without inventing an earlier failure", () => {
  const completed = previous.replace("last_completed_step=1", "last_completed_step=2");
  expect(maybeWorkerSerialDiagnostic(completed)).toBeUndefined();
  const cancelled = completed.replace("outcome=started", "outcome=failed").replace("failure=none", "failure=cancelled");
  expect(maybeWorkerSerialDiagnostic(cancelled)?.last_completed_step).toBe(2);
  expect(maybeWorkerSerialDiagnostic(cancelled.replace("last_completed_step=2", "last_completed_step=3"))).toBeUndefined();
});
