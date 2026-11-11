/** Bytes of an app slot the browser reads to find its `esp_app_desc_t`. */
export const APP_DESCRIPTOR_READ_BYTES = 0x100;

const IMAGE_MAGIC = 0xe9;
/** `esp_image_header_t` (24 bytes) plus the first segment header (8 bytes). */
const DESCRIPTOR_OFFSET = 32;
const DESCRIPTOR_MAGIC = 0xabcd5432;

/** The name and version an ESP-IDF app image states about itself. */
export type AppDescriptor = { projectName: string; version: string };

/**
 * Reads the `esp_app_desc_t` at the start of an app slot, or `undefined` when the slot holds no
 * image. Stock ESP-Miner has no Worker Serial, so this is how the browser learns what it runs.
 */
export function maybeAppDescriptor(slotStart: Uint8Array): AppDescriptor | undefined {
  if (slotStart.byteLength < APP_DESCRIPTOR_READ_BYTES) throw new Error("app image read is incomplete");
  if (slotStart[0] !== IMAGE_MAGIC) return undefined;
  const view = new DataView(slotStart.buffer, slotStart.byteOffset + DESCRIPTOR_OFFSET, 80);
  if (view.getUint32(0, true) !== DESCRIPTOR_MAGIC) return undefined;
  return {
    version: cString(slotStart.subarray(DESCRIPTOR_OFFSET + 16, DESCRIPTOR_OFFSET + 48)),
    projectName: cString(slotStart.subarray(DESCRIPTOR_OFFSET + 48, DESCRIPTOR_OFFSET + 80)),
  };
}

/**
 * The semantic version in an ESP-Miner version string such as `v2.10.1`, which the onboarding
 * contract carries as `2.10.1`. A `git describe` suffix is refused: the browser can't tell
 * which build that is, so it doesn't install over it.
 */
export function semanticFirmwareVersion(version: string): string {
  const match = /^v?(\d+\.\d+\.\d+)$/u.exec(version);
  if (!match?.[1]) throw new Error("running firmware version is not a release version");
  return match[1];
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end === -1 ? bytes.length : end));
}
