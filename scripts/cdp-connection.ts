/**
 * A minimal Chrome DevTools Protocol client over the browser's WebSocket, with
 * flattened target sessions. Enough for the Gate negatives harness to drive tabs,
 * read the network and pause Fetch responses in any Chrome started with
 * `--remote-debugging-port`.
 */

export type CdpListener = (params: Record<string, unknown>, maybeSessionId: string | undefined) => void;

export type CdpConnection = {
  send<T = Record<string, unknown>>(method: string, params?: object, maybeSessionId?: string): Promise<T>;
  /** Subscribes to one event method across all sessions; returns the unsubscribe. */
  on(method: string, listener: CdpListener): () => void;
  close(): void;
};

type Pending = { resolve(value: unknown): void; reject(error: Error): void; method: string };

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string };
};

/** Connects to a browser endpoint: its `ws://` URL, or `http://host:port` of its DevTools listener. */
export async function connectCdp(endpoint: string): Promise<CdpConnection> {
  const url = endpoint.startsWith("ws") ? endpoint : await browserWebSocketUrl(endpoint);
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("the browser's DevTools socket did not open")), { once: true });
  });
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<CdpListener>>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id === undefined) {
      for (const listener of listeners.get(message.method ?? "") ?? []) listener(message.params ?? {}, message.sessionId);
      return;
    }
    const maybeRequest = pending.get(message.id);
    if (!maybeRequest) return;
    pending.delete(message.id);
    if (message.error) {
      maybeRequest.reject(new Error(`${maybeRequest.method} failed: ${message.error.message ?? "unknown error"}`));
      return;
    }
    maybeRequest.resolve(message.result ?? {});
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) request.reject(new Error(`${request.method} failed: the browser closed`));
    pending.clear();
  });
  return {
    send<T>(method: string, params: object = {}, maybeSessionId?: string) {
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject, method });
        socket.send(JSON.stringify({ id, method, params, ...(maybeSessionId ? { sessionId: maybeSessionId } : {}) }));
      });
    },
    on(method, listener) {
      const methodListeners = listeners.get(method) ?? new Set<CdpListener>();
      listeners.set(method, methodListeners);
      methodListeners.add(listener);
      return () => methodListeners.delete(listener);
    },
    close: () => socket.close(),
  };
}

async function browserWebSocketUrl(endpoint: string): Promise<string> {
  const response = await fetch(new URL("/json/version", endpoint));
  if (!response.ok) throw new Error(`the browser's DevTools listener answered ${response.status}`);
  const version = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof version.webSocketDebuggerUrl !== "string") throw new Error("the browser has no DevTools socket");
  return version.webSocketDebuggerUrl;
}
