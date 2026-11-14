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
  cancelAccepted: () => boolean;
  gatePassRequests: () => number;
  send<T = Record<string, unknown>>(method: string, params?: object): Promise<T>;
  /** Subscribes to one of this tab's CDP events until the tab closes. */
  on(method: string, listener: (params: Record<string, unknown>) => void): void;
  evaluate<A extends unknown[], R>(pageFunction: (...args: A) => R, ...args: A): Promise<Awaited<R>>;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  elementState(path: ElementPath): Promise<ElementState>;
  click(path: ElementPath): Promise<void>;
  close(): Promise<void>;
};

export type ElementState = { present: boolean; visible: boolean; enabled: boolean; x: number; y: number };

export const GRANT_PATTERNS = ["*/work-session/start", "*/work-session/renew"];
const POLL_MILLISECONDS = 250;

/** Opens a blank tab, attaches to it and starts recording; `onPaused` receives its paused grants. */
export async function openHarnessTab(
  cdp: CdpConnection,
  name: string,
  onPaused: (tab: HarnessTab, event: FetchPausedEvent) => void,
): Promise<HarnessTab> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true });
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
    cancelAccepted: recorder.cancelAccepted,
    gatePassRequests: recorder.gatePassRequests,
    send,
    on(method, listener) {
      subscribe(method, (params, maybeSessionId) => {
        if (maybeSessionId === sessionId) listener(params);
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
    async click(path) {
      const state = await tab.elementState(path);
      if (!state.visible || !state.enabled) throw new Error(`tab ${name}: ${path.join(" > ")} is not clickable`);
      await send("Page.bringToFront");
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x: state.x, y: state.y, button: "left", clickCount: 1 });
      }
    },
    async close() {
      recorder.stop();
      stops.forEach((stop) => stop());
      await cdp.send("Target.closeTarget", { targetId });
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

function networkRecorder(cdp: CdpConnection, sessionId: string, tabName: string) {
  const requests: SeenRequest[] = [];
  const authorityStates: string[] = [];
  let maxProgress = 0n;
  let cancelAccepted = false;
  let gatePassRequests = 0;
  const mine = (listener: (params: Record<string, unknown>) => void | Promise<void>) =>
    (params: Record<string, unknown>, maybeSessionId: string | undefined) => {
      if (maybeSessionId === sessionId) void listener(params);
    };
  const stops = [
    cdp.on("Network.requestWillBeSent", mine(async (params) => {
      const request = params.request as { url: string; method: string; headers: Record<string, string>; postData?: string; hasPostData?: boolean };
      const route = routeTemplate(new URL(request.url).pathname);
      if (route?.endsWith("/gate-pass") || route === "/account-creation/redeem") gatePassRequests += 1;
      const seen: SeenRequest = { tab: tabName, method: request.method, url: request.url, headers: request.headers };
      requests.push(seen);
      if (request.postData !== undefined) {
        seen.maybeBody = request.postData;
      } else if (request.hasPostData) {
        const { postData } = await cdp.send<{ postData: string }>("Network.getRequestPostData", { requestId: params.requestId }, sessionId);
        seen.maybeBody = postData;
      }
    })),
    cdp.on("Network.responseReceived", mine((params) => {
      const response = params.response as { url: string; status: number };
      const route = routeTemplate(new URL(response.url).pathname);
      if (route?.endsWith("/work-session/cancel") && response.status >= 200 && response.status < 300) cancelAccepted = true;
    })),
    cdp.on("Network.eventSourceMessageReceived", mine((params) => {
      const data = JSON.parse(String(params.data)) as { state?: unknown; verified_progress?: unknown };
      if (params.eventName === "challenge_lifecycle" && typeof data.state === "string") authorityStates.push(data.state);
      if (params.eventName === "verified_progress" && typeof data.verified_progress === "string") {
        const progress = BigInt(data.verified_progress);
        if (progress > maxProgress) maxProgress = progress;
      }
    })),
  ];
  return {
    requests,
    authorityStates,
    verifiedProgress: () => maxProgress,
    cancelAccepted: () => cancelAccepted,
    gatePassRequests: () => gatePassRequests,
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
