import {
  createWorkerPossessionChallenge,
} from "/dist/worker-possession/worker-possession-entry.js";

const fixtures = await fetch("./fixtures.json").then(async (response) => {
  if (!response.ok) throw new Error("possession fixture is unavailable");
  return response.json();
});
const output = document.getElementById("result");
const details = document.getElementById("details");
if (!(output instanceof HTMLOutputElement) || !(details instanceof HTMLPreElement)) {
  throw new Error("possession browser output is unavailable");
}

try {
  const request = fixtures.initialAdmission.request;
  const challenge = createWorkerPossessionChallenge({
    requestId: request.requestId,
    ...request.payload,
  });
  const verified = await challenge.verify(fixtures.initialAdmission.response);
  if (verified.deviceIdentityFingerprint !== fixtures.fixtureIdentity.fingerprintSha256) {
    throw new Error("possession fingerprint mismatch");
  }
  try {
    await challenge.verify(fixtures.initialAdmission.response);
    throw new Error("possession replay was accepted");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Worker possession proof is invalid") {
      throw error;
    }
  }
  const weakKeyChallenge = createWorkerPossessionChallenge({
    requestId: request.requestId,
    ...request.payload,
  });
  try {
    await weakKeyChallenge.verify(fixtures.weakKeyForgery);
    throw new Error("weak Device Identity forgery was accepted");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Worker possession proof is invalid") {
      throw error;
    }
  }
  const nonCanonicalWeakKeyChallenge = createWorkerPossessionChallenge({
    requestId: request.requestId,
    ...request.payload,
  });
  try {
    await nonCanonicalWeakKeyChallenge.verify(fixtures.nonCanonicalWeakKeyForgery);
    throw new Error("non-canonical weak Device Identity forgery was accepted");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Worker possession proof is invalid") {
      throw error;
    }
  }
  const invalidSignWeakKeyChallenge = createWorkerPossessionChallenge({
    requestId: request.requestId,
    ...request.payload,
  });
  try {
    await invalidSignWeakKeyChallenge.verify(fixtures.invalidSignWeakKeyForgery);
    throw new Error("invalid-sign weak Device Identity forgery was accepted");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Worker possession proof is invalid") {
      throw error;
    }
  }
  const redacted = JSON.stringify({
    verified: true,
    replayRejected: true,
    weakKeyRejected: true,
    nonCanonicalWeakKeyRejected: true,
    invalidSignWeakKeyRejected: true,
  });
  if (/jwk|fingerprint|nonce|serial|credential|password/i.test(redacted)) {
    throw new Error("possession browser result is not redacted");
  }
  details.textContent = redacted;
  output.textContent = "passed";
  output.dataset.status = "passed";
} catch (error) {
  details.textContent = error instanceof Error ? error.message : String(error);
  output.textContent = "failed";
  output.dataset.status = "failed";
}
