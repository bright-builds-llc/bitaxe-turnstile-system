/**
 * Carries out `decideGrant` on the browser's paused grant responses: continues,
 * fails, delays or swaps them with CDP Fetch, and records what each tab's grant
 * went through. The grant bodies stay in memory and are never printed.
 */
import {
  decideGrant,
  emptyInterceptionState,
  type GateNegativeCase,
  type GrantDecision,
  type InterceptionAction,
  type TabEvidence,
} from "./gate-negatives-cases";
import type { FetchPausedEvent, HarnessTab } from "./gate-negatives-tab";

type PausedResponse = {
  tab: HarnessTab;
  event: FetchPausedEvent;
  pausedAtMilliseconds: number;
  maybeBody?: string;
};

/** Hop-by-hop and length headers describe the original bytes, not a substituted body. */
const DROPPED_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding"]);

export function grantInterceptor(caseName: GateNegativeCase) {
  let state = emptyInterceptionState();
  let nextKey = 0;
  let pendingDeliveries = 0;
  const paused = new Map<string, PausedResponse>();
  const interceptions = new Map<string, NonNullable<TabEvidence["maybeInterception"]>>();
  const errors: string[] = [];

  async function handle(tab: HarnessTab, event: FetchPausedEvent): Promise<void> {
    const status = event.responseStatusCode ?? 0;
    if (status < 200 || status >= 300) {
      await tab.send("Fetch.continueRequest", { requestId: event.requestId });
      return;
    }
    const operation = new URL(event.request.url).pathname.endsWith("/renew") ? "renew" : "start";
    const key = `${tab.name}-${++nextKey}`;
    const pausedAtMilliseconds = performance.now();
    const maybeBody = operation === "start" ? await responseBody(tab, event.requestId) : undefined;
    paused.set(key, { tab, event, pausedAtMilliseconds, ...(maybeBody === undefined ? {} : { maybeBody }) });
    const decided = decideGrant(caseName, state, { key, tab: tab.name, operation, pausedAtMilliseconds });
    state = decided.state;
    for (const decision of decided.decisions) execute(decision);
  }

  function execute(decision: GrantDecision): void {
    const target = paused.get(decision.key);
    if (!target) throw new Error("a decision named a grant that was never paused");
    const { tab, event } = target;
    if (decision.type === "pass") {
      void tab.send("Fetch.continueRequest", { requestId: event.requestId }).catch(record);
      return;
    }
    if (decision.type === "withhold") {
      void tab.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "ConnectionReset" })
        .then(() => note(target, "withheld"), record);
      return;
    }
    pendingDeliveries += 1;
    const delay = Math.max(0, decision.notBeforeMilliseconds - performance.now());
    setTimeout(() => {
      void deliver(target, decision.fromKey).then(
        () => note(target, decision.fromKey === decision.key ? "held" : "handed_over"),
        record,
      ).finally(() => {
        pendingDeliveries -= 1;
      });
    }, delay);
  }

  async function deliver(target: PausedResponse, fromKey: string): Promise<void> {
    const maybeBody = paused.get(fromKey)?.maybeBody;
    if (maybeBody === undefined) throw new Error("a delivered grant has no body");
    await target.tab.send("Fetch.fulfillRequest", {
      requestId: target.event.requestId,
      responseCode: target.event.responseStatusCode,
      responseHeaders: (target.event.responseHeaders ?? []).filter((header) => !DROPPED_HEADERS.has(header.name.toLowerCase())),
      body: maybeBody,
    });
  }

  function note(target: PausedResponse, action: InterceptionAction): void {
    interceptions.set(target.tab.name, {
      action,
      heldMilliseconds: Math.round(performance.now() - target.pausedAtMilliseconds),
    });
  }

  function record(error: unknown): void {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    onPaused(tab: HarnessTab, event: FetchPausedEvent): void {
      void handle(tab, event).catch(record);
    },
    /** The tab's Start grant has been paused and taken over by the case. */
    pausedStart: (tabName: string) => state.handledTabs.includes(tabName),
    /** Every taken-over grant has been answered; throws if the browser refused an answer. */
    settled(): boolean {
      if (errors.length > 0) throw new Error(`grant interception failed: ${errors.join("; ")}`);
      return pendingDeliveries === 0 && state.handledTabs.every((tab) => interceptions.has(tab));
    },
    interception: (tabName: string) => interceptions.get(tabName),
  };
}

/** The paused response's bytes, base64-encoded as `Fetch.fulfillRequest` takes them. */
async function responseBody(tab: HarnessTab, requestId: string): Promise<string> {
  const { body, base64Encoded } = await tab.send<{ body: string; base64Encoded: boolean }>("Fetch.getResponseBody", { requestId });
  return base64Encoded ? body : Buffer.from(body, "utf8").toString("base64");
}
