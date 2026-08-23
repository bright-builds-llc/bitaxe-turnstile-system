import { runCryptoConformance } from "./crypto-webcrypto.mjs";

const maybeResultOutput = document.querySelector("#result");
const maybeDetailsOutput = document.querySelector("#details");

if (!(maybeResultOutput instanceof HTMLOutputElement) || !(maybeDetailsOutput instanceof HTMLElement)) {
  throw new Error("browser conformance output elements are missing");
}

try {
  const response = await fetch("./crypto-vectors.json");
  const vectors = await response.json();
  const result = await runCryptoConformance(vectors);
  maybeResultOutput.value = "passed";
  maybeResultOutput.dataset.status = "passed";
  maybeDetailsOutput.textContent = JSON.stringify(result, null, 2);
} catch (error) {
  maybeResultOutput.value = "failed";
  maybeResultOutput.dataset.status = "failed";
  maybeDetailsOutput.textContent = error.stack ?? String(error);
}
