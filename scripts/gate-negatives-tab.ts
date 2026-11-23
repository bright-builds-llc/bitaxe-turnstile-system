/**
 * One browser tab of the Gate negatives harness: it records what the page sends
 * its origin, the Authority's event stream and the page's Cancel, pauses the
 * Authority's grant responses with CDP Fetch, and clicks the page's own controls
 * with trusted input.
 */
import type { CdpConnection, CdpListener } from "./cdp-connection";
import type { SeenRequest } from "./gate-negatives-audit";
import { routeTemplate } from "./gate-negatives-audit";

/** A selector per shadow-root hop, outermost first. */
export type ElementPath = readonly string[];

export type FetchPausedEvent = {
  requestId: string;
  request: { url: string };
  responseStatusCode?: number;
  responseHeaders?: { name: string; value: string }[];
};

export type HarnessTab = {
  name: string;
  sessionId: string;
  requests: SeenRequest[];
  authorityStates: string[];
  verifiedProgress: () => string;
  progressEvents: () => number;
  resyncRequired: () => boolean;
  /** Failures inside the tab's event handlers, judged as case failures. */
  recorderErrors: string[];
  cancelAccepted: () => boolean;
  gatePassRequests: () => number;
  /** The status of the page's Gate Pass redemption, once answered. */
  redeemStatus: () => number | undefined;
  send<T = Record<string, unknown>>(method: string, params?: object): Promise<T>;
  /** Subscribes to one of this tab's CDP events until the tab closes. */
  on(method: string, listener: (params: Record<string, unknown>) => void): void;
  evaluate<A extends unknown[], R>(pageFunction: (...args: A) => R, ...args: A): Promise<Awaited<R>>;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  elementState(path: ElementPath): Promise<ElementState>;
  /** The element's rendered text, or `undefined` if it isn't on the page. */
  text(path: ElementPath): Promise<string | undefined>;
  click(path: ElementPath): Promise<void>;
  close(): Promise<void>;
};

export type ElementState = { present: boolean; visible: boolean; enabled: boolean; x: number; y: number };

export const GRANT_PATTERNS = ["*/work-session/start", "*/work-session/renew"];
const POLL_MILLISECONDS = 250;

/**
 * Opens a blank tab, attaches to it and starts recording; `onPaused` receives its paused grants.
 * With `ownProfile` the tab opens in a new browser context, with its own Web Locks and no
 * serial grants, as a second profile would. On macOS, Chrome must have been started through
 * `open`: started from a shell, it aborts on the serial chooser's privacy check.
 */
export async function openHarnessTab(
  cdp: CdpConnection,
  name: string,
  onPaused: (tab: HarnessTab, event: FetchPausedEvent) => void,
  options: { ownProfile?: boolean } = {},
): Promise<HarnessTab> {
  const maybeContextId = options.ownProfile
    ? (await cdp.send<{ browserContextId: string }>("Target.createBrowserContext", {})).browserContextId
    : undefined;
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
    ...(maybeContextId ? { browserContextId: maybeContextId } : {}),
  });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const send = <T>(method: string, params: object = {}) => cdp.send<T>(method, params, sessionId);
  const recorder = networkRecorder(cdp, sessionId, name);
  const stops: (() => void)[] = [];
  const subscribe = (method: string, listener: CdpListener) => stops.push(cdp.on(method, listener));
  const tab: HarnessTab = {
    name,
    sessionId,
    requests: recorder.requests,
    authorityStates: recorder.authorityStates,
    verifiedProgress: () => recorder.verifiedProgress().toString(),
    progressEvents: recorder.progressEvents,
    resyncRequired: recorder.resyncRequired,
    recorderErrors: recorder.errors,
    cancelAccepted: recorder.cancelAccepted,
    gatePassRequests: recorder.gatePassRequests,
    redeemStatus: recorder.redeemStatus,
    send,
    on(method, listener) {
      subscribe(method, (params, maybeSessionId) => {
        if (maybeSessionId !== sessionId) return;
        try {
          listener(params);
        } catch (error) {
          recorder.errors.push(error instanceof Error ? error.message : String(error));
        }
      });
    },
    evaluate: (pageFunction, ...args) => evaluate(send, pageFunction, args),
    async navigate(url) {
      await send("Page.navigate", { url });
      await waitForLoad(tab);
    },
    async reload() {
      await send("Page.reload");
      await waitForLoad(tab);
    },
    elementState: (path) => evaluate(send, pageElementState, [path]),
    text: async (path) => (await evaluate(send, pageElementText, [path])) ?? undefined,
    async click(path) {
      const state = await tab.elementState(path);
      if (!state.visible || !state.enabled) throw new Error(`tab ${name}: ${path.join(" > ")} is not clickable`);
      await bringWindowToFront(cdp, targetId);
      await send("Page.bringToFront");
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x: state.x, y: state.y, button: "left", clickCount: 1 });
      }
    },
    async close() {
      recorder.stop();
      stops.forEach((stop) => stop());
      await cdp.send("Target.closeTarget", { targetId });
      if (maybeContextId) await cdp.send("Target.disposeBrowserContext", { browserContextId: maybeContextId });
    },
  };
  tab.on("Fetch.requestPaused", (params) => onPaused(tab, params as unknown as FetchPausedEvent));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Fetch.enable", {
    patterns: GRANT_PATTERNS.map((urlPattern) => ({ urlPattern, requestStage: "Response" })),
  });
  return tab;
}

/**
 * Restores the tab's window and focuses it, so the chooser a click may open is in front of the
 * person picking ports. In Ticket 28 the second tab's window stayed behind and hid its chooser.
 */
async function bringWindowToFront(cdp: CdpConnection, targetId: string): Promise<void> {
  const { windowId } = await cdp.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId });
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await cdp.send("Target.activateTarget", { targetId });
}

/** Polls until `check` yields a value, failing with `label` after `timeoutMilliseconds`. */
export async function waitFor<T>(
  label: string,
  check: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMilliseconds: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const maybeValue = await check();
    if (maybeValue !== undefined && maybeValue !== false) return maybeValue;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(POLL_MILLISECONDS);
  }
}

export type AuthorityStreamEvent =
  | { type: "lifecycle"; state: string }
  | { type: "progress"; verifiedProgress: bigint }
  | { type: "resync" }
  | { type: "ignored" }
  | { type: "malformed"; eventName: string };

/** Reads one event from the Authority's challenge stream; `resync_required` carries plain text, not JSON. */
export function readAuthorityStreamEvent(eventName: string, data: string): AuthorityStreamEvent {
  if (eventName === "resync_required") return { type: "resync" };
  if (eventName !== "challenge_lifecycle" && eventName !== "verified_progress") return { type: "ignored" };
  const malformed = { type: "malformed", eventName } as const;
  try {
    const value = JSON.parse(data) as { state?: unknown; verified_progress?: unknown };
    if (eventName === "challenge_lifecycle") {
      return typeof value.state === "string" ? { type: "lifecycle", state: value.state } : malformed;
    }
    if (typeof value.verified_progress !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value.verified_progress)) return malformed;
    return { type: "progress", verifiedProgress: BigInt(value.verified_progress) };
  } catch {
    return malformed;
  }
}

function networkRecorder(cdp: CdpConnection, sessionId: string, tabName: string) {
  const requests: SeenRequest[] = [];
  const authorityStates: string[] = [];
  const errors: string[] = [];
  let maxProgress = 0n;
  let progressEvents = 0;
  let resyncRequired = false;
  let cancelAccepted = false;
  let gatePassRequests = 0;
  let maybeRedeemStatus: number | undefined;
  // Every handler's failure is recorded for the verdict; none may escape as an unhandled rejection.
  const mine = (listener: (params: Record<string, unknown>) => void | Promise<void>) =>
    (params: Record<string, unknown>, maybeSessionId: string | undefined) => {
      if (maybeSessionId !== sessionId) return;
      Promise.resolve()
        .then(() => listener(params))
        .catch((error: unknown) => errors.push(error instanceof Error ? error.message : String(error)));
    };
  async function capturedBody(requestId: unknown): Promise<string | undefined> {
    try {
      const { postData } = await cdp.send<{ postData: string }>("Network.getRequestPostData", { requestId }, sessionId);
      return postData;
    } catch {
      // Left uncaptured, the audit flags the request instead of passing it unread.
      return undefined;
    }
  }
  const stops = [
    cdp.on("Network.requestWillBeSent", mine(async (params) => {
      const request = params.request as { url: string; method: string; headers: Record<string, string>; postData?: string; hasPostData?: boolean };
      const route = routeTemplate(new URL(request.url).pathname);
      if (route?.endsWith("/gate-pass") || route === "/account-creation/redeem") gatePassRequests += 1;
      const seen: SeenRequest = { tab: tabName, method: request.method, url: request.url, headers: request.headers };
      requests.push(seen);
      const maybeBody = request.postData ?? (request.hasPostData ? await capturedBody(params.requestId) : undefined);
      if (maybeBody !== undefined) seen.maybeBody = maybeBody;
    })),
    cdp.on("Network.responseReceived", mine((params) => {
      const response = params.response as { url: string; status: number };
      const route = routeTemplate(new URL(response.url).pathname);
      if (route?.endsWith("/work-session/cancel") && response.status >= 200 && response.status < 300) cancelAccepted = true;
      if (route === "/account-creation/redeem") maybeRedeemStatus = response.status;
    })),
    cdp.on("Network.eventSourceMessageReceived", mine((params) => {
      const event = readAuthorityStreamEvent(String(params.eventName), String(params.data));
      if (event.type === "lifecycle") authorityStates.push(event.state);
      if (event.type === "resync") resyncRequired = true;
      if (event.type === "malformed") errors.push(`the Authority's ${event.eventName} event was malformed`);
      if (event.type !== "progress") return;
      progressEvents += 1;
      if (event.verifiedProgress > maxProgress) maxProgress = event.verifiedProgress;
    })),
  ];
  return {
    requests,
    authorityStates,
    errors,
    verifiedProgress: () => maxProgress,
    progressEvents: () => progressEvents,
    resyncRequired: () => resyncRequired,
    cancelAccepted: () => cancelAccepted,
    gatePassRequests: () => gatePassRequests,
    redeemStatus: () => maybeRedeemStatus,
    stop: () => stops.forEach((stop) => stop()),
  };
}

async function evaluate<A extends unknown[], R>(
  send: <T>(method: string, params?: object) => Promise<T>,
  pageFunction: (...args: A) => R,
  args: A,
): Promise<Awaited<R>> {
  const result = await send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
    "Runtime.evaluate",
    { expression: `(${pageFunction.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true },
  );
  if (result.exceptionDetails) {
    throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? ""}`);
  }
  return result.result.value as Awaited<R>;
}

async function waitForLoad(tab: HarnessTab): Promise<void> {
  await waitFor("the page to load", () => tab.evaluate(() => document.readyState === "complete"), 30_000);
}

/** Runs in the page: finds an element through shadow roots and reports where to click it. */
function pageElementState(path: readonly string[]): ElementState {
  let root: ParentNode = document;
  let maybeElement: Element | null = null;
  for (const selector of path) {
    maybeElement = root.querySelector(selector);
    if (!maybeElement) return { present: false, visible: false, enabled: false, x: 0, y: 0 };
    root = maybeElement.shadowRoot ?? maybeElement;
  }
  const element = maybeElement as HTMLElement;
  element.scrollIntoView({ block: "center" });
  const rect = element.getBoundingClientRect();
  const visible = !element.closest("[hidden]") && rect.width > 0 && rect.height > 0;
  const enabled = !(element as HTMLButtonElement).disabled;
  return { present: true, visible, enabled, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** Runs in the page: an element's rendered text, found through shadow roots, or `null` if absent. */
function pageElementText(path: readonly string[]): string | null {
  let root: ParentNode = document;
  let maybeElement: Element | null = null;
  for (const selector of path) {
    maybeElement = root.querySelector(selector);
    if (!maybeElement) return null;
    root = maybeElement.shadowRoot ?? maybeElement;
  }
  return (maybeElement as HTMLElement).innerText.trim();
}
