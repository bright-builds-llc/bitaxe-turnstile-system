import { parseFirmwareManifest, type FirmwareManifest } from "../web/bitaxe-firmware-package";
import { encodeBase64Url } from "../web/crypto-bytes";
import { canonicalJson } from "../web/headless-values";
import type { PrivateAuthority } from "./worker-development-authority-keys";

/** A manifest and its compact `bwg-firmware-manifest+jws`, as a firmware package carries them. */
export type SignedFirmwareManifest = { manifest: FirmwareManifest; signature: string };

/**
 * Signs an unsigned `bwg-reference-firmware/0.2` manifest with the Update Authority's active key,
 * as the Gate's package admission verifies it. The manifest is parsed as admission parses it before
 * the key is imported, so an inadmissible manifest is never signed.
 */
export async function signFirmwareManifest(
  input: unknown,
  updateAuthority: PrivateAuthority,
): Promise<SignedFirmwareManifest> {
  const manifest = parseFirmwareManifest(input);
  if (updateAuthority.role !== "update_authority") throw new Error("authority_role_invalid");
  const maybeKey = updateAuthority.keys.find((key) => key.kid === updateAuthority.activeKid);
  if (!maybeKey) throw new Error("active_key_missing");
  const privateKey = await crypto.subtle.importKey("jwk", maybeKey, "Ed25519", false, ["sign"]);
  const encoder = new TextEncoder();
  const header = canonicalJson({
    alg: "Ed25519",
    kid: updateAuthority.activeKid,
    typ: "bwg-firmware-manifest+jws",
  });
  const signingInput = `${encodeBase64Url(encoder.encode(header))}.${encodeBase64Url(
    encoder.encode(canonicalJson(manifest)),
  )}`;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    encoder.encode(signingInput).buffer,
  );
  return {
    manifest,
    signature: `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`,
  };
}
