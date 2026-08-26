import {
  requestTrustedConsentWithPopup,
  verifyTrustedConsentReceipt,
} from "../../dist/headless/headless-client.js";

const result = document.querySelector("#result");
const details = document.querySelector("#details");
if (!(result instanceof HTMLOutputElement) || !(details instanceof HTMLElement)) {
  throw new Error("trusted-consent conformance output is missing");
}

try {
  const config = await (await fetch("https://authority.example/fixture/config")).json();
  const descriptor = config.descriptor;
  const request = {
    reason: "elevated_work",
    authorityOrigin: "https://authority.example",
    challengeId: descriptor.challenge_id,
    disclosureDigestSha256: descriptor.trusted_consent_disclosure_digest_sha256,
    poolOfferSetSignatureSha256: await sha256Base64Url(descriptor.pool_offers.signature),
    expiresAtUnixSeconds: descriptor.expires_at_unix_seconds,
  };
  const missing = await fetch("https://authority.example/fixture/start-lease", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEqual(missing.status, 403, "missing_receipt_gate");

  const receipt = await requestTrustedConsentWithPopup(request);
  console.log("trusted-consent: production-popup-complete");
  await verifyTrustedConsentReceipt(
    receipt,
    request,
    config.authorityTrust,
    Math.floor(Date.now() / 1000),
  );
  const admitted = await fetch("https://authority.example/fixture/start-lease", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maybe_trusted_consent_receipt: receipt }),
  });
  assertEqual(admitted.status, 204, "receipt_lease_gate");

  result.value = "passed";
  result.dataset.status = "passed";
  details.textContent = JSON.stringify({
    productionRoutes: ["begin", "finish"],
    browserReceiptVerification: true,
    leaseAdmission: ["missing-rejected", "receipt-accepted"],
  }, null, 2);
} catch (error) {
  console.error(error);
  result.value = "failed";
  result.dataset.status = "failed";
  details.textContent = error instanceof Error ? error.stack : String(error);
}

async function sha256Base64Url(value) {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )));
}

function encodeBase64Url(value) {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function assertEqual(actual, expected, name) {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, received ${actual}`);
}
