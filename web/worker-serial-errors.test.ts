import { expect, test } from "bun:test";
import { serialFailure, serialFailureFor, workerSerialFailureCategory } from "./worker-serial-errors";
import { maybeWorkerSerialDiagnostic } from "./worker-serial-diagnostics";

test("serial failure observations exclude arbitrary error text and forged category objects", () => {
  // Arrange / Act / Assert
  expect(workerSerialFailureCategory(new Error("private transport endpoint"))).toBe("operation_failed");
  expect(workerSerialFailureCategory({ category: "private" })).toBe("operation_failed");
  expect(workerSerialFailureCategory(serialFailure("private"))).toBe("operation_failed");
  expect(workerSerialFailureCategory(serialFailureFor(new Error("private"), "read_failed"))).toBe("read_failed");
  expect(workerSerialFailureCategory(serialFailureFor(serialFailure("wire_bound"), "read_failed"))).toBe("wire_bound");
});

test("network startup observations admit only closed producer phases and error categories", () => {
  // Arrange
  const line = "wifi_startup_failure schema=v1 phase=driver error=no_memory redacted=true";
  // Act / Assert
  expect(maybeWorkerSerialDiagnostic(line)).toEqual({ category: "network_failure", authoritative: false, phase: "driver", error: "no_memory" });
  for (const invalid of [line.replace("phase=driver", "phase=private"), line.replace("error=no_memory", "error=private"), `${line} credential=private`]) {
    expect(maybeWorkerSerialDiagnostic(invalid)).toBeUndefined();
  }
});
