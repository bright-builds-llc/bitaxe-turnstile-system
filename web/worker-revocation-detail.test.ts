import { expect, test } from "bun:test";
import { maybeValidatedDiagnostic, maybeWorkerSerialDiagnostic, WorkerSerialDiagnosticHistory } from "./worker-serial-diagnostics";

// Exact producer output from bitaxe-runtime's `the_detail_marker_is_a_closed_single_line`.
const busVoltage = "worker_revocation_detail schema=v1 generation=1 reason=unsafe_observation trigger=unsafe_sample fact=bus_voltage state=out_of_range value_milli=5512 age_ms=40 since_safe_ms=100 closed_ms=500 redacted=true";
const detail = (fields: string) => `worker_revocation_detail schema=v1 generation=3 reason=unsafe_observation ${fields} since_safe_ms=1001 closed_ms=68990 redacted=true`;

test("the firmware's unsafe-sample detail parses with its fact, value and age", () => {
  // Arrange / Act
  const parsed = maybeWorkerSerialDiagnostic(busVoltage);
  // Assert
  expect(parsed).toEqual({ category: "worker_revocation_detail", authoritative: false, generation: 1, reason: "unsafe_observation",
    trigger: "unsafe_sample", fact: "bus_voltage", state: "out_of_range", value_milli: 5512, age_ms: 40, since_safe_ms: 100, closed_ms: 500 });
});

test("a negative milli value is kept as a signed reading", () => {
  // Arrange / Act
  const parsed = maybeWorkerSerialDiagnostic(detail("trigger=unsafe_sample fact=current state=out_of_range value_milli=-50 age_ms=12"));
  // Assert
  expect(parsed?.value_milli).toBe(-50);
});

test("a silence or zero-fan trigger names no fact", () => {
  // Arrange / Act
  const silence = maybeWorkerSerialDiagnostic(detail("trigger=no_safe_sample fact=none state=none value_milli=unavailable age_ms=unavailable"));
  const namedFan = maybeWorkerSerialDiagnostic(detail("trigger=zero_fan fact=fan_rpm state=out_of_range value_milli=0 age_ms=10"));
  // Assert
  expect(silence?.trigger).toBe("no_safe_sample");
  expect(namedFan).toBeUndefined();
});

test("inconsistent fact, state and value combinations are dropped", () => {
  // Arrange
  const lines = [
    detail("trigger=unsafe_sample fact=none state=out_of_range value_milli=unavailable age_ms=unavailable"),
    detail("trigger=unsafe_sample fact=power state=none value_milli=unavailable age_ms=unavailable"),
    detail("trigger=no_safe_sample fact=none state=none value_milli=5 age_ms=unavailable"),
    detail("trigger=unsafe_sample fact=power state=unavailable value_milli=4000 age_ms=10"),
    detail("trigger=unsafe_sample fact=power state=out_of_range value_milli=2147483648 age_ms=10"),
  ];
  // Act / Assert
  expect(lines.map(maybeWorkerSerialDiagnostic)).toEqual([undefined, undefined, undefined, undefined, undefined]);
});

test("an exported detail is reconstructed only through its producer grammar", () => {
  // Arrange
  const parsed = maybeWorkerSerialDiagnostic(busVoltage)!;
  // Act / Assert
  expect(maybeValidatedDiagnostic(parsed)).toEqual(parsed);
  expect(maybeValidatedDiagnostic({ ...parsed, fact: "pool_url" })).toBeUndefined();
});

test("history keeps the latest revocation detail as one observation", () => {
  // Arrange
  const history = new WorkerSerialDiagnosticHistory();
  const later = busVoltage.replace("generation=1", "generation=2");
  // Act
  history.observe(maybeWorkerSerialDiagnostic(busVoltage)!);
  history.observe(maybeWorkerSerialDiagnostic(later)!);
  // Assert
  expect(history.values().filter(value => value.category === "worker_revocation_detail").map(value => value.generation)).toEqual([2]);
});
