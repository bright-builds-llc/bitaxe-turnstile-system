/** Encodes bounded protocol bytes as unpadded base64url. */
export function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Decodes a caller-bounded, unpadded base64url segment or throws the boundary error. */
export function decodeBase64Url(
  value: string,
  maximumCharacters: number,
  errorMessage: string,
): Uint8Array {
  if (
    value.length === 0 ||
    value.length > maximumCharacters ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error(errorMessage);
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

/** Returns the SHA-256 digest of an immutable byte snapshot as base64url. */
export async function sha256Base64UrlBytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value.slice().buffer);
  return encodeBase64Url(new Uint8Array(digest));
}
