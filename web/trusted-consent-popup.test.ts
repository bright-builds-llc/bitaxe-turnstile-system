import { describe, expect, test } from "bun:test";

import { requestTrustedConsentWithPopup } from "./trusted-consent-popup";
import type { TrustedConsentRequest } from "./headless-client.types";

describe("trusted-origin popup transport", () => {
  test("a blocked popup fails closed", async () => {
    // Arrange
    const blocked = popupHarness(false);

    // Act
    const result = requestTrustedConsentWithPopup(request(), { maybeBrowser: blocked.browser });

    // Assert
    await expect(result).rejects.toThrow("popup was blocked");
  });

  test("a prematurely closed popup fails closed", async () => {
    // Arrange
    const closed = popupHarness(true);
    const result = requestTrustedConsentWithPopup(request(), { maybeBrowser: closed.browser });

    // Act
    closed.popup.closed = true;
    closed.tick();

    // Assert
    await expect(
      result,
    ).rejects.toThrow("closed before confirmation");
  });

  test("only the exact Authority origin, popup, and state can return a receipt", async () => {
    // Arrange
    const harness = popupHarness(true);
    const result = requestTrustedConsentWithPopup(request(), { maybeBrowser: harness.browser });
    const state = harness.maybeOpenedUrl?.searchParams.get("state");
    if (!state) throw new Error("popup state is missing");

    // Act
    harness.message("https://evil.example", harness.popup, {
      type: "bwg_trusted_consent_result",
      state,
      maybeReceipt: "forged",
    });
    harness.message("https://authority.example", {} as Window, {
      type: "bwg_trusted_consent_result",
      state,
      maybeReceipt: "forged",
    });
    harness.message("https://authority.example", harness.popup, {
      type: "bwg_trusted_consent_result",
      state: "wrong-state",
      maybeReceipt: "forged",
    });
    harness.message("https://authority.example", harness.popup, {
      type: "bwg_trusted_consent_result",
      state,
      maybeReceipt: "forged",
      unexpected: true,
    });
    harness.message("https://authority.example", harness.popup, {
      type: "bwg_trusted_consent_result",
      state,
      maybeReceipt: "authority-signed-receipt",
    });

    // Assert
    await expect(result).resolves.toBe("authority-signed-receipt");
    expect(harness.maybeOpenedUrl?.origin).toBe("https://authority.example");
    expect(harness.maybeOpenedUrl?.pathname).toBe("/v0/trusted-consent");
    expect(harness.popup.closed).toBe(true);
  });

  test("Authority cancellation is surfaced without a receipt", async () => {
    // Arrange
    const harness = popupHarness(true);
    const result = requestTrustedConsentWithPopup(request(), { maybeBrowser: harness.browser });
    const state = harness.maybeOpenedUrl?.searchParams.get("state");
    if (!state) throw new Error("popup state is missing");

    // Act
    harness.message("https://authority.example", harness.popup, {
      type: "bwg_trusted_consent_result",
      state,
      maybeError: "user cancelled WebAuthn confirmation",
    });

    // Assert
    await expect(result).rejects.toThrow("user cancelled WebAuthn confirmation");
  });

  test("abort closes the popup and prevents a late receipt", async () => {
    // Arrange
    const harness = popupHarness(true);
    const controller = new AbortController();
    const result = requestTrustedConsentWithPopup(request(), {
      maybeBrowser: harness.browser,
      maybeSignal: controller.signal,
    });
    const state = harness.maybeOpenedUrl?.searchParams.get("state");
    if (!state) throw new Error("popup state is missing");

    // Act
    controller.abort();
    harness.message("https://authority.example", harness.popup, {
      type: "bwg_trusted_consent_result",
      state,
      maybeReceipt: "late-receipt",
    });

    // Assert
    await expect(result).rejects.toThrow("trusted consent was aborted");
    expect(harness.popup.closed).toBe(true);
    expect(harness.listenerCount()).toBe(0);
  });

  test("timeout closes the popup and fails closed", async () => {
    // Arrange
    const harness = popupHarness(true);
    const result = requestTrustedConsentWithPopup(request(), {
      maybeBrowser: harness.browser,
      maybeTimeoutMilliseconds: 1,
    });

    // Act
    harness.timeout();

    // Assert
    await expect(result).rejects.toThrow("trusted consent timed out");
    expect(harness.popup.closed).toBe(true);
    expect(harness.listenerCount()).toBe(0);
  });
});

function request(): TrustedConsentRequest {
  return {
    reason: "elevated_work",
    authorityOrigin: "https://authority.example",
    challengeId: "challenge_trusted_01",
    disclosureDigestSha256: "disclosure-digest",
    poolOfferSetSignatureSha256: "pool-offer-digest",
    expiresAtUnixSeconds: 2_000,
  };
}

function popupHarness(available: boolean): {
  browser: Pick<
    Window,
    | "open"
    | "addEventListener"
    | "removeEventListener"
    | "setInterval"
    | "clearInterval"
    | "setTimeout"
    | "clearTimeout"
  >;
  popup: Window & { closed: boolean };
  maybeOpenedUrl: URL | undefined;
  message(origin: string, source: Window, data: unknown): void;
  listenerCount(): number;
  timeout(): void;
  tick(): void;
} {
  const listeners = new Set<EventListener>();
  const intervals = new Set<() => void>();
  const timeouts = new Set<() => void>();
  const popup = {
    closed: false,
    close(this: { closed: boolean }) {
      this.closed = true;
    },
  } as unknown as Window & { closed: boolean };
  let maybeOpenedUrl: URL | undefined;
  const browser = {
    open(url: string | URL) {
      maybeOpenedUrl = new URL(String(url));
      return available ? popup : null;
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === "message" && typeof listener === "function") listeners.add(listener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === "message" && typeof listener === "function") listeners.delete(listener);
    },
    setInterval(handler: TimerHandler) {
      if (typeof handler !== "function") throw new Error("test interval handler must be callable");
      intervals.add(handler as () => void);
      return intervals.size;
    },
    clearInterval() {
      intervals.clear();
    },
    setTimeout(handler: TimerHandler) {
      if (typeof handler !== "function") throw new Error("test timeout handler must be callable");
      timeouts.add(handler as () => void);
      return timeouts.size;
    },
    clearTimeout() {
      timeouts.clear();
    },
  } as unknown as Pick<
    Window,
    | "open"
    | "addEventListener"
    | "removeEventListener"
    | "setInterval"
    | "clearInterval"
    | "setTimeout"
    | "clearTimeout"
  >;
  return {
    browser,
    popup,
    get maybeOpenedUrl() {
      return maybeOpenedUrl;
    },
    message(origin, source, data) {
      const event = { origin, source, data } as MessageEvent;
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount() {
      return listeners.size;
    },
    timeout() {
      for (const timeout of [...timeouts]) timeout();
    },
    tick() {
      for (const interval of [...intervals]) interval();
    },
  };
}
