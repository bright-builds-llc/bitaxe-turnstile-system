import type { TrustedConsentRequest } from "./headless-client.types";

type PopupMessage = {
  type: "bwg_trusted_consent_result";
  state: string;
  maybeReceipt?: string;
  maybeError?: string;
};

type TrustedConsentBrowser = Pick<
  Window,
  | "open"
  | "addEventListener"
  | "removeEventListener"
  | "setInterval"
  | "clearInterval"
  | "setTimeout"
  | "clearTimeout"
>;

export type TrustedConsentPopupOptions = {
  maybeBrowser?: TrustedConsentBrowser;
  maybeSignal?: AbortSignal;
  maybeTimeoutMilliseconds?: number;
};

const DEFAULT_TIMEOUT_MILLISECONDS = 120_000;

/** Opens the fixed Authority-origin surface and accepts only its bounded matching reply. */
export function requestTrustedConsentWithPopup(
  request: TrustedConsentRequest,
  options: TrustedConsentPopupOptions = {},
): Promise<string> {
  const maybeBrowser = options.maybeBrowser ?? globalThis.window;
  if (!maybeBrowser) return Promise.reject(new Error("trusted consent requires a browser window"));
  const timeoutMilliseconds = options.maybeTimeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 ||
    timeoutMilliseconds > DEFAULT_TIMEOUT_MILLISECONDS
  ) {
    return Promise.reject(new Error("trusted consent timeout is invalid"));
  }
  if (options.maybeSignal?.aborted) {
    return Promise.reject(new Error("trusted consent was aborted"));
  }
  const state = randomState();
  const confirmationUrl = new URL("/v0/trusted-consent", request.authorityOrigin);
  confirmationUrl.searchParams.set("challenge_id", request.challengeId);
  confirmationUrl.searchParams.set("disclosure_digest", request.disclosureDigestSha256);
  confirmationUrl.searchParams.set(
    "pool_offer_set_signature_digest",
    request.poolOfferSetSignatureSha256,
  );
  confirmationUrl.searchParams.set("reason", request.reason);
  confirmationUrl.searchParams.set("state", state);
  if (globalThis.location?.origin) {
    confirmationUrl.searchParams.set("opener_origin", globalThis.location.origin);
  }
  return new Promise((resolve, reject) => {
    let maybePopup: Window | null = null;
    let maybeClosedPoll: number | undefined;
    let maybeTimeout: number | undefined;
    let settled = false;
    const cleanup = () => {
      maybeBrowser.removeEventListener("message", receive as EventListener);
      if (maybeClosedPoll !== undefined) maybeBrowser.clearInterval(maybeClosedPoll);
      if (maybeTimeout !== undefined) maybeBrowser.clearTimeout(maybeTimeout);
      options.maybeSignal?.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      maybePopup?.close();
      reject(error);
    };
    const succeed = (receipt: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      maybePopup?.close();
      resolve(receipt);
    };
    const receive = (event: MessageEvent<unknown>) => {
      if (!maybePopup || event.origin !== request.authorityOrigin || event.source !== maybePopup) {
        return;
      }
      const maybeMessage = maybePopupMessage(event.data);
      if (!maybeMessage || maybeMessage.state !== state) return;
      if (maybeMessage.maybeReceipt) {
        succeed(maybeMessage.maybeReceipt);
        return;
      }
      fail(new Error(maybeMessage.maybeError ?? "trusted consent was cancelled"));
    };
    const abort = () => fail(new Error("trusted consent was aborted"));
    maybeBrowser.addEventListener("message", receive as EventListener);
    options.maybeSignal?.addEventListener("abort", abort, { once: true });
    maybePopup = maybeBrowser.open(
      confirmationUrl,
      "bwg-trusted-consent",
      "popup,width=560,height=720",
    );
    if (!maybePopup) {
      fail(new Error("trusted consent popup was blocked"));
      return;
    }
    maybeClosedPoll = maybeBrowser.setInterval(() => {
      if (!maybePopup?.closed) return;
      fail(new Error("trusted consent popup closed before confirmation"));
    }, 100);
    maybeTimeout = maybeBrowser.setTimeout(() => {
      fail(new Error("trusted consent timed out"));
    }, timeoutMilliseconds);
  });
}

function maybePopupMessage(value: unknown): PopupMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const maybeMessage = value as Record<string, unknown>;
  const maybeReceipt = maybeMessage.maybeReceipt;
  const maybeError = maybeMessage.maybeError;
  if (
    maybeMessage.type !== "bwg_trusted_consent_result" ||
    typeof maybeMessage.state !== "string" ||
    (maybeReceipt !== undefined && (typeof maybeReceipt !== "string" || maybeReceipt.length === 0)) ||
    (maybeError !== undefined && (typeof maybeError !== "string" || maybeError.length === 0)) ||
    (maybeReceipt === undefined) === (maybeError === undefined)
  ) {
    return undefined;
  }
  const expectedKeys = [
    "type",
    "state",
    maybeReceipt === undefined ? "maybeError" : "maybeReceipt",
  ].sort();
  if (JSON.stringify(Object.keys(maybeMessage).sort()) !== JSON.stringify(expectedKeys)) {
    return undefined;
  }
  return maybeMessage as PopupMessage;
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
