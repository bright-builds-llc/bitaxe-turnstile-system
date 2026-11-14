import { expect, test } from "bun:test";
import { auditAuthorityRequests, routeTemplate, type SeenRequest } from "./gate-negatives-audit";

const ORIGIN = "https://gate.example.test:8443";
const BINDING = "jEc1ro90lL2fX0ZozUbY0XpmxrC46gEkEUKKTyGj0Zs";
const BOARD_VALUE = "board-identity-fingerprint-0001";

function post(path: string, body: unknown, tab = "a"): SeenRequest {
  return { tab, method: "POST", url: `${ORIGIN}${path}`, headers: {}, maybeBody: JSON.stringify(body) };
}

function startRequest(binding: string, tab = "a"): SeenRequest {
  return post("/v0/challenges/challenge_01/work-session/start", { control_session_binding_sha256: binding }, tab);
}

function audit(requests: SeenRequest[]) {
  return auditAuthorityRequests(requests, { origin: ORIGIN, boardValues: [BOARD_VALUE] });
}

test("templates a challenge route without its identifier", () => {
  expect(routeTemplate("/v0/challenges/challenge_01/work-session/renew")).toBe("/v0/challenges/{id}/work-session/renew");
});

test("leaves a static path untemplated", () => {
  expect(routeTemplate("/reference/account-creation.html")).toBeUndefined();
});

test("accepts a Start that carries only the control-session binding", () => {
  // Arrange
  const requests = [startRequest(BINDING)];

  // Act
  const result = audit(requests);

  // Assert
  expect(result.violations).toEqual([]);
});

test("lists each route's field names without their values", () => {
  // Arrange
  const requests = [startRequest(BINDING), startRequest(BINDING)];

  // Act
  const result = audit(requests);

  // Assert
  expect(result.routes).toEqual([
    { method: "POST", route: "/v0/challenges/{id}/work-session/start", fields: ["control_session_binding_sha256"] },
  ]);
});

test("flags a field a route does not allow", () => {
  // Arrange
  const requests = [post("/v0/challenges/challenge_01/work-session/start", {
    control_session_binding_sha256: BINDING,
    device_identity: "x",
  })];

  // Act
  const result = audit(requests);

  // Assert
  expect(result.violations).toEqual(['unexpected field "device_identity" on POST /v0/challenges/{id}/work-session/start']);
});

test("flags a board value anywhere in a request without printing it", () => {
  // Arrange
  const requests = [post("/account-creation/challenge", { claimant_key: `{"x":"${BOARD_VALUE}"}` })];

  // Act
  const result = audit(requests);

  // Assert
  expect(result.violations).toEqual(["a board value reached the Authority on POST /account-creation/challenge"]);
});

test("flags a board value inside a signed header's payload", () => {
  // Arrange
  const payload = Buffer.from(JSON.stringify({ sub: BOARD_VALUE })).toString("base64url");
  const request: SeenRequest = {
    tab: "a",
    method: "GET",
    url: `${ORIGIN}/v0/challenges/challenge_01/gate-pass`,
    headers: { "bwg-claimant-proof": `eyJhbGciOiJFUzI1NiJ9.${payload}.c2ln` },
  };

  // Act
  const result = audit([request]);

  // Assert
  expect(result.violations).toEqual(["a board value reached the Authority on GET /v0/challenges/{id}/gate-pass"]);
});

test("flags a binding that is not a SHA-256 digest", () => {
  // Arrange
  const requests = [startRequest("not-a-digest")];

  // Act
  const result = audit(requests);

  // Assert
  expect(result.violations).toEqual(["control_session_binding_sha256 is not a SHA-256 digest on POST /v0/challenges/{id}/work-session/start"]);
});

test("flags a Start without a control-session binding", () => {
  // Arrange
  const requests = [post("/v0/challenges/challenge_01/work-session/start", {})];

  // Act
  const result = audit(requests);

  // Assert
  expect(result.violations).toEqual(["POST /v0/challenges/{id}/work-session/start carried no control_session_binding_sha256"]);
});

test("flags a body sent to a route the audit does not know", () => {
  // Arrange
  const requests = [post("/v0/diagnostics", { anything: true })];

  // Act
  const result = audit(requests);

  // Assert
  expect(result.violations).toEqual(["a request body reached an unlisted route"]);
});

test("ignores requests to other origins", () => {
  // Arrange
  const requests: SeenRequest[] = [{ tab: "a", method: "POST", url: "https://elsewhere.test/x", headers: {}, maybeBody: BOARD_VALUE }];

  // Act
  const result = audit(requests);

  // Assert
  expect(result.violations).toEqual([]);
});

test("keeps each tab's Start bindings in the order they were sent", () => {
  // Arrange
  const other = "B".repeat(43);
  const requests = [startRequest(BINDING, "a"), startRequest(other, "b")];

  // Act
  const result = audit(requests);

  // Assert
  expect(result.startBindingsByTab).toEqual({ a: [BINDING], b: [other] });
});

test("keeps a Renew's binding out of the Start bindings", () => {
  // Arrange
  const requests = [post("/v0/challenges/challenge_01/work-session/renew", { control_session_binding_sha256: BINDING, lease_id: "l" })];

  // Act
  const result = audit(requests);

  // Assert
  expect(result.startBindingsByTab).toEqual({});
});

test("flags a POST to a listed route whose body wasn't captured", () => {
  // Arrange
  const requests: SeenRequest[] = [{ tab: "a", method: "POST", url: `${ORIGIN}/v0/challenges/challenge_01/work-session/start`, headers: {} }];

  // Act
  const result = audit(requests);

  // Assert
  expect(result.violations).toEqual(["the body of POST /v0/challenges/{id}/work-session/start was not captured"]);
});

test("refuses to audit without a board value to search for", () => {
  expect(() => auditAuthorityRequests([], { origin: ORIGIN, boardValues: [] })).toThrow("the audit needs at least one board value");
});

test("refuses a board value too short to search for safely", () => {
  expect(() => auditAuthorityRequests([], { origin: ORIGIN, boardValues: ["abc"] })).toThrow("board values must be at least 8 characters");
});
