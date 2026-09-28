/** Public RFC 8032 vector identity; fixture-only signer, never production deployment material. */
export async function fixtureIdentityKey() {
  const hex =
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  const bytes = Uint8Array.from(hex.match(/../gu) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
  return crypto.subtle.importKey("pkcs8", bytes, "Ed25519", false, ["sign"]);
}
