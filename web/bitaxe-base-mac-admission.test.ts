import { expect, test } from "bun:test";
import { baseMacAdmission, baseMacDigest, registeredBaseMacDigest } from "./bitaxe-base-mac-admission";

// Vectors from Python's hashlib over the Rust flash tool's format (`tools/flash/src/board_identity.rs`
// in bitaxe-esp-miner): SHA-256 of "bitaxe-board-base-mac-v1\n" and the MAC as lowercase colon hex.
const MAC_ONE = "02:00:00:00:a1:b1";
const MAC_ONE_DIGEST = "3c83711e28525fd6217b2645fa72a3043ecbb2952d4de81bc0a8d0b0342d733d";
const MAC_TWO = "02:00:00:00:a1:b2";
const MAC_TWO_DIGEST = "a7780c44e643e7659b14ab8227f71c3bb4577fd03a47f180d63243e47148db7f";

const registry = (boards: unknown[], schema = "bitaxe-board-registry-v1") => JSON.stringify({ schema, boards });

test("digests a base MAC as the Rust board registry does", async () => {
  expect(await baseMacDigest(MAC_ONE)).toBe(MAC_ONE_DIGEST);
});

test("digests an upper-case MAC as its lower-case form, since the registry parses octets", async () => {
  expect(await baseMacDigest(MAC_ONE.toUpperCase())).toBe(MAC_ONE_DIGEST);
});

test("refuses text that isn't six colon-separated octets", async () => {
  await expect(baseMacDigest("02:00:00:00:a1")).rejects.toThrow("base MAC");
});

test("admits the board whose MAC has the expected digest", async () => {
  expect(await baseMacAdmission(MAC_ONE_DIGEST)(MAC_ONE)).toBe(true);
});

test("refuses a board whose MAC has another digest", async () => {
  expect(await baseMacAdmission(MAC_ONE_DIGEST)(MAC_TWO)).toBe(false);
});

test("refuses an expected digest that isn't 64 lower-case hex digits", () => {
  expect(() => baseMacAdmission("not-a-digest")).toThrow("digest");
});

test("reads one board's digest from the registry", () => {
  // Arrange
  const text = registry([
    { board: "205", base_mac_sha256: MAC_TWO_DIGEST },
    { board: "601", base_mac_sha256: MAC_ONE_DIGEST },
  ]);

  // Act
  const digest = registeredBaseMacDigest(text, "601");

  // Assert
  expect(digest).toBe(MAC_ONE_DIGEST);
});

test("refuses a registry with another schema", () => {
  expect(() => registeredBaseMacDigest(registry([], "other"), "601")).toThrow("schema");
});

test("refuses a registry without the board", () => {
  expect(() => registeredBaseMacDigest(registry([{ board: "205", base_mac_sha256: MAC_TWO_DIGEST }]), "601")).toThrow("601");
});

test("refuses a registry that names the board twice", () => {
  // Arrange
  const text = registry([
    { board: "601", base_mac_sha256: MAC_ONE_DIGEST },
    { board: "601", base_mac_sha256: MAC_TWO_DIGEST },
  ]);

  // Act
  const read = () => registeredBaseMacDigest(text, "601");

  // Assert
  expect(read).toThrow("601");
});
