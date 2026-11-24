import { afterEach, expect, test } from "bun:test";
import { forgetSerialGrants } from "./gate-negatives-adapters";

afterEach(() => {
  delete (navigator as { serial?: unknown }).serial;
});

test("forgets every serial grant the site holds", async () => {
  // Arrange
  const forgotten: string[] = [];
  const port = (name: string) => ({ forget: async () => void forgotten.push(name) });
  const granted = [port("205"), port("601")];
  Object.defineProperty(navigator, "serial", { configurable: true, value: { getPorts: async () => granted } });
  // Act
  const count = await forgetSerialGrants();
  // Assert
  expect(count).toBe(2);
  expect(forgotten).toEqual(["205", "601"]);
});
