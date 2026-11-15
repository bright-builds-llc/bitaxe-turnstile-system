/**
 * The base-MAC match ADR-0112 requires before any write on the owner's boards. The 205 and the
 * 601 present identical USB descriptors, so the factory base MAC is the only thing that tells them
 * apart. Boards are registered by digest, never by MAC, in the owner's private registry
 * (`bitaxe-board-registry-v1`, written by the Rust flash tool in bitaxe-esp-miner), and the digest
 * here is that tool's: SHA-256 of `bitaxe-board-base-mac-v1`, a newline, and the MAC as lower-case
 * colon-separated hex. Nothing here logs a MAC or a digest.
 */

const DIGEST_DOMAIN = "bitaxe-board-base-mac-v1";
const REGISTRY_SCHEMA = "bitaxe-board-registry-v1";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const OCTET_PATTERN = /^[0-9a-f]{2}$/iu;

/** The registry digest of a base MAC such as esptool-js's `readMac` reports. */
export async function baseMacDigest(baseMac: string): Promise<string> {
  const octets = baseMac.split(":");
  if (octets.length !== 6 || !octets.every((octet) => OCTET_PATTERN.test(octet))) {
    throw new Error("the base MAC is not six colon-separated octets");
  }
  const text = `${DIGEST_DOMAIN}\n${octets.join(":").toLowerCase()}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The onboarding's `maybeAdmitBaseMac`: admits only the board whose MAC has `expectedDigest`. */
export function baseMacAdmission(expectedDigest: string): (baseMac: string) => Promise<boolean> {
  if (!DIGEST_PATTERN.test(expectedDigest)) throw new Error("the expected base-MAC digest is not 64 lower-case hex digits");
  return async (baseMac) => (await baseMacDigest(baseMac)) === expectedDigest;
}

/** One board's digest from the registry's text, for the server that configures a sitting's page. */
export function registeredBaseMacDigest(registryText: string, board: string): string {
  const registry = JSON.parse(registryText) as { schema?: unknown; boards?: unknown };
  if (registry.schema !== REGISTRY_SCHEMA || !Array.isArray(registry.boards)) {
    throw new Error(`the board registry's schema is not ${REGISTRY_SCHEMA}`);
  }
  const entries = registry.boards.filter(
    (entry): entry is { board: string; base_mac_sha256: unknown } =>
      typeof entry === "object" && entry !== null && (entry as { board?: unknown }).board === board,
  );
  const [entry] = entries;
  if (entries.length !== 1 || !entry) throw new Error(`the board registry must name board ${board} exactly once`);
  const digest = entry.base_mac_sha256;
  if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
    throw new Error(`board ${board}'s registered digest is not 64 lower-case hex digits`);
  }
  return digest;
}
