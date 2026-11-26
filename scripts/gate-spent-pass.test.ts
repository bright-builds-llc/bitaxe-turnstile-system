import { expect, test } from "bun:test";
import type { SeenRequest } from "./gate-negatives-audit";
import { spentPassInput } from "./gate-spent-pass";

const ORIGIN = "https://gate.example.test";
const CLAIMANT_KEY = '{"crv":"P-256","kty":"EC","x":"X","y":"Y"}';

function post(path: string, body: Record<string, unknown>): SeenRequest {
  return { tab: "a", method: "POST", url: `${ORIGIN}${path}`, headers: {}, maybeBody: JSON.stringify(body) };
}

const journeyRequests: SeenRequest[] = [
  post("/account-creation/challenge", { claimant_key: CLAIMANT_KEY }),
  { tab: "a", method: "GET", url: `${ORIGIN}/v0/challenges/challenge_abc/gate-pass`, headers: {} },
  post("/account-creation/redeem", { gate_pass: "pass.jws", dpop_proof: "proof.jwt", action_reference: "action_1" }),
];

test("reads the retry's inputs from the page's own challenge, lookup and redemption", () => {
  // Act
  const input = spentPassInput(journeyRequests, ORIGIN);

  // Assert
  expect(input).toEqual({
    origin: ORIGIN,
    challengeId: "challenge_abc",
    claimantKey: CLAIMANT_KEY,
    gatePass: "pass.jws",
    actionReference: "action_1",
  });
});

test("refuses to retry before the page has redeemed", () => {
  // Arrange
  const requests = journeyRequests.slice(0, 2);

  // Act and assert
  expect(() => spentPassInput(requests, ORIGIN)).toThrow("the page's redemption wasn't recorded");
});

test("retries the pass of the page's first redemption, not a later one", () => {
  // Arrange
  const requests = [...journeyRequests, post("/account-creation/redeem", { gate_pass: "other.jws", dpop_proof: "p", action_reference: "action_1" })];

  // Act
  const input = spentPassInput(requests, ORIGIN);

  // Assert
  expect(input.gatePass).toBe("pass.jws");
});
