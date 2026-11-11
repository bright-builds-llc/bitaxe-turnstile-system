/**
 * The two digests ESP flash structures use: MD5, which the ROM stub reports for a flash
 * region and the partition table carries, and the ROM's `esp_rom_crc32_le`, which guards
 * `otadata` entries and NVS pages and items. WebCrypto has neither.
 */

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
  14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
  21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_CONSTANTS = Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0,
);

/** MD5 of `data` (RFC 1321) as 16 bytes. */
export function md5(data: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((data.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = data.byteLength * 8;
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 2 ** 32), true);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const words = new Array<number>(16);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(block + index * 4, true);
    let [a, b, c, d] = state as [number, number, number, number];
    for (let round = 0; round < 64; round += 1) {
      const [mixed, wordIndex] = md5Round(round, b, c, d);
      const rotated = (a + mixed + (MD5_CONSTANTS[round] ?? 0) + (words[wordIndex] ?? 0)) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft(rotated, MD5_SHIFTS[round] ?? 0)) >>> 0;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
  }
  const digest = new Uint8Array(16);
  const digestView = new DataView(digest.buffer);
  state.forEach((word, index) => digestView.setUint32(index * 4, word, true));
  return digest;
}

/** MD5 as lowercase hex, the form esptool-js reports a flash region's digest in. */
export function md5Hex(data: Uint8Array): string {
  return [...md5(data)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** ESP ROM `esp_rom_crc32_le(seed, data, length)`: reflected CRC-32, inverted on entry and exit. */
export function espCrc32Le(seed: number, data: Uint8Array): number {
  let crc = ~seed >>> 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function md5Round(round: number, b: number, c: number, d: number): [number, number] {
  if (round < 16) return [(b & c) | (~b & d), round];
  if (round < 32) return [(d & b) | (~d & c), (5 * round + 1) % 16];
  if (round < 48) return [b ^ c ^ d, (3 * round + 5) % 16];
  return [c ^ (b | ~d), (7 * round) % 16];
}

function rotateLeft(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}
