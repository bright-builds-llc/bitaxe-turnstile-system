/**
 * Runs inside the reference page, injected by the Gate negatives harness after a journey's
 * redemption (criterion 10). It retries the spent Gate Pass as its claimant could: it looks the
 * pass up again with a fresh Issuance Proof, then redeems it again with a fresh DPoP proof. Both
 * are signed with the page's own retained Claimant key and the page's own transport code, so
 * nothing outside the page signs. It returns only how each retry was answered, never the pass,
 * a proof or the key.
 */
import { createClaimantHttpTransport } from "../web/claimant-http-transport";
import { restoreClaimantIdentity } from "../web/headless-key";
import type { SpentPassEvidence } from "./gate-negatives-cases";

export type SpentPassInput = {
  origin: string;
  challengeId: string;
  /** The challenge request's `claimant_key`, a canonical public JWK. */
  claimantKey: string;
  gatePass: string;
  actionReference: string;
};

async function spentPassAttempt(input: SpentPassInput): Promise<SpentPassEvidence> {
  const claimantIdentity = await restoreClaimantIdentity(await retainedKeyId(input.claimantKey));
  const transport = createClaimantHttpTransport({ authorityBaseUrl: input.origin, challengeId: input.challengeId, claimantIdentity });
  const refresh = await transport.gatePass().then(
    (gatePass) => (gatePass === input.gatePass ? "identical" : "different"),
    () => "refused" as const,
  );
  const redemptionUrl = `${input.origin}/account-creation/redeem`;
  const dpopProof = await transport.gatePassDpopProof(input.gatePass, { method: "POST", url: redemptionUrl });
  const response = await fetch(redemptionUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gate_pass: input.gatePass, dpop_proof: dpopProof, action_reference: input.actionReference }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  const error = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error
    : "";
  return { refresh, replayStatus: response.status, replayError: error };
}

/** The page keeps each Claimant key by a random ID; the challenge names it only by its public JWK. */
async function retainedKeyId(claimantKey: string): Promise<string> {
  const { x, y } = JSON.parse(claimantKey) as { x?: unknown; y?: unknown };
  const records = await new Promise<{ keyId: string; publicJwk: JsonWebKey }[]>((resolve, reject) => {
    const open = indexedDB.open("bwg-headless", 1);
    open.onerror = () => reject(open.error ?? new Error("the Claimant key database didn't open"));
    open.onsuccess = () => {
      const request = open.result.transaction("claimant_keys", "readonly").objectStore("claimant_keys").getAll();
      request.onerror = () => reject(request.error ?? new Error("the Claimant keys couldn't be read"));
      request.onsuccess = () => resolve(request.result);
    };
  });
  const maybeRecord = records.find((record) => record.publicJwk.x === x && record.publicJwk.y === y);
  if (!maybeRecord) throw new Error("the page no longer retains the challenge's Claimant key");
  return maybeRecord.keyId;
}

(globalThis as { bwgSpentPassAttempt?: typeof spentPassAttempt }).bwgSpentPassAttempt = spentPassAttempt;
