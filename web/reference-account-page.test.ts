import { expect, test } from "bun:test";
import { connectFailureMessage } from "./reference-account-page";
import { serialFailure } from "./worker-serial-errors";

test("a refused connect while another tab holds the Bitaxe says what to do", () => {
  // Arrange
  const refused = serialFailure("already_owned");

  // Act
  const message = connectFailureMessage(refused);

  // Assert
  expect(message).toBe("Another tab of this site is already connected to a Bitaxe. Finish or close that tab, then connect again.");
});

test("any other connect failure keeps its own message", () => {
  // Arrange
  const failure = new Error("Worker Serial admission_failed");

  // Act
  const message = connectFailureMessage(failure);

  // Assert
  expect(message).toBe("Worker Serial admission_failed");
});
