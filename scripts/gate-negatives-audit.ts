/**
 * Request audit for the Gate negatives harness (Ticket 21).
 *
 * Checks that the only board-bound value the page sends the Authority is
 * `control_session_binding_sha256`: every body field must be on its route's list,
 * and no known board value may appear in any URL, header or body. Findings name
 * routes as templates and fields by name, never values, endpoints or keys.
 */

/** One request the page sent, as the browser recorded it. */
export type SeenRequest = {
  tab: string;
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  maybeBody?: string;
};

export type AuditedRoute = { method: string; route: string; fields: string[] };

export type RequestAudit = {
  /** Distinct routes with the field names their bodies carried, for the evidence record. */
  routes: AuditedRoute[];
  violations: string[];
  /** Each tab's Start bindings, in order; compared, never printed. */
  startBindingsByTab: Record<string, string[]>;
};

export type RequestAuditInput = {
  /** The deployment origin serving the page, the Authority and the Relying Service. */
  origin: string;
  /** Values tied to the board (identity, firmware pins) that must never reach the Authority. */
  boardValues: readonly string[];
};

const BINDING_FIELD = "control_session_binding_sha256";
const START_ROUTE = "POST /v0/challenges/{id}/work-session/start";
const MINIMUM_BOARD_VALUE_LENGTH = 8;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/u;
const CHALLENGE_ROUTE = /^\/v0\/challenges\/[^/]+\/(work-session\/[a-z-]+|events|gate-pass)$/u;
const RELYING_SERVICE_ROUTE = /^\/account-creation\/(challenge|redeem)$/u;

/** The body fields each route may carry; only the binding is derived from the board. */
const ALLOWED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "POST /account-creation/challenge": ["claimant_key"],
  "POST /account-creation/redeem": ["gate_pass", "dpop_proof", "action_reference"],
  "POST /v0/challenges/{id}/work-session/pool-selection": ["pool_offer_id", "payout_destination_type", "payout_destination"],
  "POST /v0/challenges/{id}/work-session/start": [BINDING_FIELD, "trusted_consent_receipt"],
  "POST /v0/challenges/{id}/work-session/resume": [BINDING_FIELD],
  "POST /v0/challenges/{id}/work-session/renew": [BINDING_FIELD, "lease_id"],
  "POST /v0/challenges/{id}/work-session/pause": ["reason"],
  "POST /v0/challenges/{id}/work-session/cancel": ["confirm_progress_loss"],
};

const BINDING_REQUIRED = new Set([
  "POST /v0/challenges/{id}/work-session/start",
  "POST /v0/challenges/{id}/work-session/resume",
  "POST /v0/challenges/{id}/work-session/renew",
]);

/** The route with its challenge identifier replaced, or `undefined` for a path the audit doesn't name. */
export function routeTemplate(pathname: string): string | undefined {
  const challenge = CHALLENGE_ROUTE.exec(pathname);
  if (challenge) return `/v0/challenges/{id}/${challenge[1]}`;
  return RELYING_SERVICE_ROUTE.test(pathname) ? pathname : undefined;
}

/** Audits every request the page sent its own origin. */
export function auditAuthorityRequests(
  requests: readonly SeenRequest[],
  input: RequestAuditInput,
): RequestAudit {
  // An empty list would let the board-value search pass without searching for anything.
  if (input.boardValues.length === 0) throw new Error("the audit needs at least one board value");
  if (input.boardValues.some((value) => value.length < MINIMUM_BOARD_VALUE_LENGTH)) {
    throw new Error(`board values must be at least ${MINIMUM_BOARD_VALUE_LENGTH} characters`);
  }
  const origin = new URL(input.origin).origin;
  const violations: string[] = [];
  const routes = new Map<string, Set<string>>();
  const startBindingsByTab: Record<string, string[]> = {};
  for (const request of requests) {
    const url = new URL(request.url);
    if (url.origin !== origin) continue;
    const maybeRoute = routeTemplate(url.pathname);
    const label = maybeRoute ? `${request.method} ${maybeRoute}` : "an unlisted route";
    if (carriesBoardValue(request, input.boardValues)) {
      violations.push(`a board value reached the Authority on ${label}`);
    }
    if (request.maybeBody === undefined) {
      // A body the browser didn't hand over is unaudited, which must not read as clean.
      if (maybeRoute && request.method === "POST") violations.push(`the body of ${label} was not captured`);
      continue;
    }
    if (!maybeRoute) {
      violations.push("a request body reached an unlisted route");
      continue;
    }
    const maybeFields = bodyFields(request.maybeBody);
    if (!maybeFields) {
      violations.push(`a body that is not a JSON object on ${label}`);
      continue;
    }
    const seen = routes.get(label) ?? new Set<string>();
    routes.set(label, seen);
    violations.push(...fieldViolations(label, maybeFields, seen));
    const maybeBinding = maybeFields[BINDING_FIELD];
    if (label === START_ROUTE && typeof maybeBinding === "string") (startBindingsByTab[request.tab] ??= []).push(maybeBinding);
  }
  return { routes: routeList(routes), violations, startBindingsByTab };
}

function fieldViolations(label: string, fields: Record<string, unknown>, seen: Set<string>): string[] {
  const violations: string[] = [];
  const allowed = ALLOWED_FIELDS[label] ?? [];
  for (const name of Object.keys(fields)) {
    seen.add(name);
    if (!allowed.includes(name)) violations.push(`unexpected field ${JSON.stringify(name)} on ${label}`);
  }
  const maybeBinding = fields[BINDING_FIELD];
  if (maybeBinding === undefined) {
    if (BINDING_REQUIRED.has(label)) violations.push(`${label} carried no ${BINDING_FIELD}`);
    return violations;
  }
  if (typeof maybeBinding !== "string" || !SHA256_BASE64URL.test(maybeBinding)) {
    violations.push(`${BINDING_FIELD} is not a SHA-256 digest on ${label}`);
  }
  return violations;
}

function carriesBoardValue(request: SeenRequest, boardValues: readonly string[]): boolean {
  const headerValues = Object.values(request.headers);
  const haystack = [
    request.url,
    request.maybeBody ?? "",
    ...headerValues,
    ...headerValues.flatMap(decodedTokenSegments),
  ].join("\n");
  return boardValues.some((value) => haystack.includes(value));
}

/** A JWS-shaped header carries its claims base64url-encoded, so they're searched decoded too. */
function decodedTokenSegments(value: string): string[] {
  return value
    .split(".")
    .filter((segment) => /^[A-Za-z0-9_-]{4,}$/u.test(segment))
    .map((segment) => Buffer.from(segment, "base64url").toString("utf8"));
}

function bodyFields(body: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function routeList(routes: Map<string, Set<string>>): AuditedRoute[] {
  return [...routes.entries()]
    .map(([label, fields]) => {
      const [method = "", route = ""] = label.split(" ");
      return { method, route, fields: [...fields].sort() };
    })
    .sort((left, right) => left.route.localeCompare(right.route));
}
