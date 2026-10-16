import { expect, test } from "bun:test";
import { WORKER_RESTORATION_RESPONSE_MILLISECONDS, WORKER_SHUTDOWN_BOUND_MILLISECONDS, WORKER_TERMINAL_SEQUENCE_MILLISECONDS } from "./worker-restoration-bound";

test("the shutdown bound is the firmware's 22,550 ms catalog-maximum tail", () => {
  // Arrange / Act / Assert
  expect(WORKER_SHUTDOWN_BOUND_MILLISECONDS).toBe(22_550);
});

test("the restoration deadline includes the 22,550 ms shutdown bound", () => {
  // Arrange
  const initiation = 3_000, cooling = 120_000, transport = 6_450;
  // Act
  const deadline = WORKER_RESTORATION_RESPONSE_MILLISECONDS;
  // Assert
  expect(deadline).toBe(initiation + 22_550 + cooling + transport);
});

test("the terminal sequence runs initiation, the shutdown bound and cooling", () => {
  // Arrange / Act / Assert
  expect(WORKER_TERMINAL_SEQUENCE_MILLISECONDS).toBe(3_000 + 22_550 + 120_000);
});
