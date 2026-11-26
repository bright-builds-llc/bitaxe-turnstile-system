/**
 * Health and readiness for a Gate deployment's front (bwg-core Ticket 24). Health says the
 * application answers: the Authority's discovery and the Reference Relying Service. Readiness
 * adds valid mining-job readiness: a Stratum probe to Hydra must receive a `mining.notify`, which
 * pinned Hydra sends only for a job that passed Job Admission.
 */
import type { Socket } from "bun";

export type ApplicationHealth =
  | { status: "available" }
  | { status: "unavailable"; part: "gate_authority" | "reference_service" };

export type MiningJobReadiness = "admitted_job" | "no_job" | "refused" | "unreachable" | "unconfigured";

export type Readiness = { ready: boolean; application: string; miningJob: MiningJobReadiness };

/** An outcome lookup for this reference never matches one, so it reads the database and answers 404. */
const REFERENCE_PROBE_PATH = "/account-creation/outcomes/health-probe";
const DISCOVERY_PATH = "/.well-known/pow-gate-configuration";
const PROBE_TIMEOUT_MILLISECONDS = 2_000;

async function answers(fetcher: typeof fetch, url: string, isHealthy: (status: number) => boolean): Promise<boolean> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS) });
    return isHealthy(response.status);
  } catch {
    // A refused or timed-out probe is the unhealthy answer itself, not an error to report.
    return false;
  }
}

/** Whether both services answer: discovery with 200, the Relying Service with anything below 500. */
export async function applicationHealth(fetcher: typeof fetch, gate: string, reference: string): Promise<ApplicationHealth> {
  if (!(await answers(fetcher, `${gate}${DISCOVERY_PATH}`, (status) => status === 200))) {
    return { status: "unavailable", part: "gate_authority" };
  }
  if (!(await answers(fetcher, `${reference}${REFERENCE_PROBE_PATH}`, (status) => status < 500))) {
    return { status: "unavailable", part: "reference_service" };
  }
  return { status: "available" };
}

/** Subscribes and authorizes as `username`, then waits up to `timeoutMilliseconds` for a job. */
export async function probeMiningJob(
  pool: { host: string; port: number },
  username: string,
  timeoutMilliseconds: number,
): Promise<Exclude<MiningJobReadiness, "unconfigured">> {
  return await new Promise((resolve) => {
    let maybeSocket: Socket<undefined> | undefined;
    let buffered = "";
    let settled = false;
    const settle = (outcome: Exclude<MiningJobReadiness, "unconfigured">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      maybeSocket?.end();
      resolve(outcome);
    };
    const timer = setTimeout(() => settle(maybeSocket ? "no_job" : "unreachable"), timeoutMilliseconds);
    Bun.connect<undefined>({
      hostname: pool.host,
      port: pool.port,
      socket: {
        open(socket) {
          maybeSocket = socket;
          socket.write(`${JSON.stringify({ id: 1, method: "mining.subscribe", params: ["bwg-readiness/0.1"] })}\n`);
          socket.write(`${JSON.stringify({ id: 2, method: "mining.authorize", params: [username, "x"] })}\n`);
        },
        data(_socket, data) {
          buffered += data.toString();
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines.filter(Boolean)) {
            const message = JSON.parse(line) as { id?: unknown; method?: unknown; result?: unknown };
            if (message.method === "mining.notify") settle("admitted_job");
            if (message.id === 2 && message.result !== true) settle("refused");
          }
        },
        close() {
          settle(maybeSocket ? "no_job" : "unreachable");
        },
        connectError() {
          settle("unreachable");
        },
      },
    }).catch(() => settle("unreachable"));
  });
}

/** Ready only when the application is available and Hydra released an admitted job. */
export function readiness(health: ApplicationHealth, miningJob: MiningJobReadiness): Readiness {
  const application = health.status === "available" ? "available" : `unavailable: ${health.part}`;
  return { ready: health.status === "available" && miningJob === "admitted_job", application, miningJob };
}

/** Reuses one probe's outcome for `timeToLiveMilliseconds`, so readiness checks stay light on Hydra. */
export function cachedProbe<T>(probe: () => Promise<T>, timeToLiveMilliseconds: number, now: () => number = Date.now): () => Promise<T> {
  let maybeCached: { at: number; outcome: Promise<T> } | undefined;
  return async () => {
    if (!maybeCached || now() - maybeCached.at >= timeToLiveMilliseconds) {
      maybeCached = { at: now(), outcome: probe() };
    }
    return await maybeCached.outcome;
  };
}
