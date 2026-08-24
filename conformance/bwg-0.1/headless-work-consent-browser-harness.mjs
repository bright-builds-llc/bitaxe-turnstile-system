import {
  createHeadlessClient,
  prepareClaimantIdentity,
  restoreClaimantIdentity,
} from "../../dist/headless/headless-client.js";

const maybeResult = document.querySelector("#result");
const maybeDetails = document.querySelector("#details");

if (!(maybeResult instanceof HTMLOutputElement) || !(maybeDetails instanceof HTMLElement)) {
  throw new Error("headless conformance output elements are missing");
}

try {
  const response = await fetch("./headless-work-consent-vectors.json");
  const vector = await response.json();
  const calls = [];
  const events = [];
  let maybeAuthorityListener;
  const clock = () => 1_000;
  const identity = await prepareClaimantIdentity({ maybeClock: clock });
  const transport = {
    start: async () => calls.push("start"),
    pause: async () => calls.push("pause"),
    resume: async () => calls.push("resume"),
    cancel: async () => calls.push("cancel"),
    subscribeAuthorityEvents(listener) {
      maybeAuthorityListener = listener;
      return () => {
        maybeAuthorityListener = undefined;
      };
    },
  };
  const client = await createHeadlessClient({
    ...vector,
    challenge: { ...vector.challenge, claimantKey: identity.claimantKey() },
    claimantIdentity: identity,
    transport,
  });
  client.subscribe((event) => events.push(event));
  const disclosure = client.disclosure();
  await expectRejection(() => client.start(), "Work Consent is required before Start");
  assertEqual(calls.length, 0, "work_started_before_consent");
  assertEqual(disclosure.expectedHashes, vector.challenge.expectedHashes, "work_requirement");
  assertEqual(disclosure.poolOffer.offerId, vector.selection.poolOfferId, "pool_offer");
  assertEqual(disclosure.poolOffer.miningPool.license, "AGPL-3.0-only", "pool_license");
  assertEqual(disclosure.poolOffer.poolAdapter.license, "MIT", "adapter_license");
  assertEqual(Object.hasOwn(client.claimantPublicJwk(), "d"), false, "private_key_exposed");

  const receipt = await client.grantConsent();
  await client.start();
  await maybeAuthorityListener({ type: "verified_progress", acceptedHashes: "4295032833" });
  client.reportActivityEstimate({ status: "active", hashrateHs: "400000000000" });
  await client.pause();
  client.close();

  const restoredIdentity = await restoreClaimantIdentity(identity.keyId(), { maybeClock: clock });
  const restoredClient = await createHeadlessClient({
    ...vector,
    challenge: { ...vector.challenge, claimantKey: restoredIdentity.claimantKey() },
    claimantIdentity: restoredIdentity,
    transport,
    maybeRestoration: { challengeState: "active" },
  });
  restoredClient.subscribe((event) => events.push(event));
  await restoredClient.resume();
  await restoredClient.cancel();
  const restoredProof = await restoredClient.signClaimantProof(new Uint8Array([1]));
  const corruptIdentity = await prepareClaimantIdentity({ maybeClock: clock });
  await replaceClaimantRecord({
    keyId: corruptIdentity.keyId(),
    retentionExpiry: 2_000,
  });
  await expectRejection(
    () => restoreClaimantIdentity(corruptIdentity.keyId(), { maybeClock: clock }),
    "Stored Claimant key is invalid",
  );
  assertEqual(await claimantRecordExists(corruptIdentity.keyId()), false, "corrupt_key_deleted");
  const crossFieldIdentity = await prepareClaimantIdentity({ maybeClock: clock });
  const crossFieldRecord = await claimantRecord(crossFieldIdentity.keyId());
  if (!crossFieldRecord) throw new Error("cross-field fixture key is missing");
  crossFieldRecord.maybeConsentBinding = {
    challengeId: "challenge_other",
    receipt: {
      disclosureDigestSha256: "digest",
      poolOfferSetSignature: "signature",
    },
  };
  await replaceClaimantRecord(crossFieldRecord);
  await expectRejection(
    () => restoreClaimantIdentity(crossFieldIdentity.keyId(), { maybeClock: clock }),
    "Stored Claimant key is invalid",
  );
  assertEqual(
    await claimantRecordExists(crossFieldIdentity.keyId()),
    false,
    "cross_field_key_deleted",
  );

  assertEqual(receipt.disclosureDigestSha256.length, 43, "consent_digest");
  assertEqual(calls.join(","), "start,pause,resume,cancel", "control_mapping");
  assertEqual(restoredProof.byteLength > 0, true, "restored_claimant_key");
  assertEqual(
    events.filter((event) => event.type === "verified_progress").length,
    1,
    "verified_progress_source",
  );
  assertEqual(
    events.filter((event) => event.type === "activity_estimate").length,
    1,
    "activity_estimate_separation",
  );
  if (/private|credential|action_reference|payoutDestination/.test(JSON.stringify(events))) {
    throw new Error("event_privacy");
  }

  maybeResult.value = "passed";
  maybeResult.dataset.status = "passed";
  maybeDetails.textContent = JSON.stringify(
    {
      profile: vector.profile,
      disclosureDigestSha256: receipt.disclosureDigestSha256,
      controls: calls,
      lifecycleEvents: events.filter((event) => event.type === "lifecycle"),
    },
    null,
    2,
  );
} catch (error) {
  maybeResult.value = "failed";
  maybeResult.dataset.status = "failed";
  maybeDetails.textContent = error instanceof Error ? error.stack : String(error);
}

function assertEqual(actual, expected, name) {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, received ${actual}`);
}

async function expectRejection(operation, message) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && error.message === message) return;
    throw error;
  }
  throw new Error("operation unexpectedly succeeded");
}

async function replaceClaimantRecord(record) {
  const database = await openClaimantDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("claimant_keys", "readwrite");
    transaction.objectStore("claimant_keys").put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function claimantRecordExists(keyId) {
  return (await claimantRecord(keyId)) !== undefined;
}

async function claimantRecord(keyId) {
  const database = await openClaimantDatabase();
  const result = await new Promise((resolve, reject) => {
    const request = database.transaction("claimant_keys", "readonly")
      .objectStore("claimant_keys")
      .get(keyId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return result;
}

function openClaimantDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("bwg-headless", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
