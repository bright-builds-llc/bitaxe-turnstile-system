/**
 * A standard Stratum V1 Worker on the claimant page: one the claimant configures by hand, with no
 * Worker Controller. The page names its own control session, shows each lease's endpoint, username
 * and password while the lease runs, and withdraws them on Pause, Cancel or any terminal report.
 * The credentials themselves stop working when the Authority ends the lease, so the Pool Adapter,
 * not this page, is what stops gated work; the claimant points their Worker back at its own pool.
 */
import { encodeBase64Url, sha256Base64UrlBytes } from "./crypto-bytes";
import type { HeadlessTransport } from "./headless-client.types";
import type { WorkerLeaseGrant } from "./worker-controller";
import type {
  WorkerLeaseAuthorizationContext,
  WorkerLeaseAuthorizationContextProvider,
} from "./worker-lease-authorization";

/** What a claimant enters in a standard Stratum V1 Worker for one lease. */
export type StandardWorkerSettings = { endpoint: string; username: string; password: string };

export type StandardStratumWorker = WorkerLeaseAuthorizationContextProvider & {
  /** The active lease's settings, or undefined while no lease runs. */
  settings(): StandardWorkerSettings | undefined;
  /** Calls `listener` now and whenever the settings appear or are withdrawn. */
  subscribe(listener: (maybeSettings: StandardWorkerSettings | undefined) => void): () => void;
  /** Wraps the claimant transport, so its leases reach this Worker and its stops withdraw them. */
  transport(inner: HeadlessTransport): HeadlessTransport;
};

const TERMINAL_STATES = new Set(["satisfied", "pass_issued", "cancelled", "expired"]);

/** Creates the page's standard Worker, naming its control session by the SHA-256 of a page secret. */
export async function createStandardStratumWorker(): Promise<StandardStratumWorker> {
  const context: WorkerLeaseAuthorizationContext = {
    controlSessionBindingSha256: await sha256Base64UrlBytes(
      new TextEncoder().encode(encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))),
    ),
  };
  const listeners = new Set<(maybeSettings: StandardWorkerSettings | undefined) => void>();
  let maybeSettings: StandardWorkerSettings | undefined;
  const publish = (next: StandardWorkerSettings | undefined) => {
    maybeSettings = next;
    for (const listener of listeners) listener(next ? { ...next } : undefined);
  };
  const withdraw = () => {
    if (maybeSettings) publish(undefined);
  };
  const show = async (inner: HeadlessTransport, maybeGrant: void | WorkerLeaseGrant) => {
    if (!maybeGrant) return;
    const stratum = maybeGrant.stratum;
    if (!("username" in stratum) || !("password" in stratum)) {
      await inner.pause();
      throw new Error("the Work Lease has no Stratum V1 settings");
    }
    publish({ endpoint: stratum.endpoint, username: stratum.username, password: stratum.password });
  };
  return {
    async prepareWorkerLeaseAuthorizationContext() {
      return { ...context };
    },
    settings() {
      return maybeSettings ? { ...maybeSettings } : undefined;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(maybeSettings ? { ...maybeSettings } : undefined);
      return () => listeners.delete(listener);
    },
    transport(inner) {
      return {
        ...inner,
        async start(maybeReceipt, maybeContext) {
          const maybeGrant = await inner.start(maybeReceipt, maybeContext);
          await show(inner, maybeGrant);
          return maybeGrant;
        },
        async resume(maybeContext) {
          const maybeGrant = await inner.resume(maybeContext);
          await show(inner, maybeGrant);
          return maybeGrant;
        },
        async pause() {
          withdraw();
          await inner.pause();
        },
        async cancel() {
          withdraw();
          await inner.cancel();
        },
        subscribeAuthorityEvents(listener) {
          return inner.subscribeAuthorityEvents(async (event) => {
            if (event.type === "challenge_lifecycle" && TERMINAL_STATES.has(event.state)) withdraw();
            await listener(event);
          });
        },
      };
    },
  };
}
