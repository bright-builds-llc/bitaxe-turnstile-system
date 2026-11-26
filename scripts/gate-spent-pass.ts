/**
 * The harness's side of criterion 10's spent-pass retry. It takes the retry's inputs from requests
 * the tab already recorded, and bundles `gate-spent-pass-page.ts` in memory for injection, so no
 * file is written and a running deployment's `dist/` is left alone.
 */
import { resolve } from "node:path";
import type { SeenRequest } from "./gate-negatives-audit";
import type { SpentPassInput } from "./gate-spent-pass-page";

const CHALLENGE_LOOKUP = /^\/v0\/challenges\/([^/]+)\/gate-pass$/u;

/** The page's challenge request names its Claimant key, its lookup the challenge, and its first redemption the pass. */
export function spentPassInput(requests: readonly SeenRequest[], origin: string): SpentPassInput {
  const challenge = bodyOf(requests, "/account-creation/challenge", "the page's challenge request wasn't recorded");
  const redemption = bodyOf(requests, "/account-creation/redeem", "the page's redemption wasn't recorded");
  const maybeChallengeId = requests
    .map((request) => CHALLENGE_LOOKUP.exec(new URL(request.url).pathname)?.[1])
    .find((maybeId) => maybeId !== undefined);
  if (!maybeChallengeId) throw new Error("the page's Gate Pass lookup wasn't recorded");
  return {
    origin,
    challengeId: decodeURIComponent(maybeChallengeId),
    claimantKey: stringField(challenge, "claimant_key"),
    gatePass: stringField(redemption, "gate_pass"),
    actionReference: stringField(redemption, "action_reference"),
  };
}

/** The page-side retry as one classic script that sets `globalThis.bwgSpentPassAttempt`. */
export async function spentPassPageScript(): Promise<string> {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "gate-spent-pass-page.ts")],
    target: "browser",
    format: "iife",
  });
  const [output] = build.outputs;
  if (!build.success || !output) throw new Error(`the spent-pass page script didn't build: ${build.logs.join("; ")}`);
  return await output.text();
}

function bodyOf(requests: readonly SeenRequest[], path: string, missing: string): Record<string, unknown> {
  const maybeRequest = requests.find((request) => request.method === "POST" && new URL(request.url).pathname === path);
  if (maybeRequest?.maybeBody === undefined) throw new Error(missing);
  return JSON.parse(maybeRequest.maybeBody) as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw new Error(`the recorded request has no ${field}`);
  return value;
}
