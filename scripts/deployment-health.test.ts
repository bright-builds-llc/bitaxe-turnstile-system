import { afterEach, expect, test } from "bun:test";
import type { Socket, TCPSocketListener } from "bun";

import {
  applicationHealth,
  cachedProbe,
  probeMiningJob,
  readiness,
} from "./deployment-health";

const GATE = "http://127.0.0.1:1";
const REFERENCE = "http://127.0.0.1:2";
let maybeServer: TCPSocketListener<undefined> | undefined;

afterEach(() => {
  maybeServer?.stop(true);
  maybeServer = undefined;
});

function fetchAnswering(statuses: Record<string, number | "down">): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const base = url.startsWith(GATE) ? GATE : REFERENCE;
    const status = statuses[base];
    if (status === undefined || status === "down") throw new Error("connection refused");
    return new Response(null, { status });
  }) as typeof fetch;
}

/** A Stratum pool that answers each request line with `reply(method)`'s lines. */
function stratumPool(reply: (method: string, id: unknown) => string[]): { host: string; port: number } {
  maybeServer = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket: Socket<undefined>, data) {
        for (const line of data.toString().split("\n").filter(Boolean)) {
          const request = JSON.parse(line) as { id: unknown; method: string };
          for (const answer of reply(request.method, request.id)) socket.write(`${answer}\n`);
        }
      },
    },
  });
  return { host: "127.0.0.1", port: maybeServer.port };
}

const NOTIFY = JSON.stringify({ id: null, method: "mining.notify", params: ["job", "00", "", "", [], "20000000", "1d00ffff", "00", true] });
const answer = (id: unknown, result: unknown) => JSON.stringify({ id, result, error: null });

test("the application is available when the Authority and the Relying Service both answer", async () => {
  // Act
  const health = await applicationHealth(fetchAnswering({ [GATE]: 200, [REFERENCE]: 404 }), GATE, REFERENCE);

  // Assert
  expect(health).toEqual({ status: "available" });
});

test("names the Gate Authority when its discovery doesn't answer", async () => {
  // Act
  const health = await applicationHealth(fetchAnswering({ [GATE]: "down", [REFERENCE]: 404 }), GATE, REFERENCE);

  // Assert
  expect(health).toEqual({ status: "unavailable", part: "gate_authority" });
});

test("names the Relying Service when it answers with a server error", async () => {
  // Act
  const health = await applicationHealth(fetchAnswering({ [GATE]: 200, [REFERENCE]: 500 }), GATE, REFERENCE);

  // Assert
  expect(health).toEqual({ status: "unavailable", part: "reference_service" });
});

test("finds an admitted job when the pool sends a notify after authorization", async () => {
  // Arrange
  const pool = stratumPool((method, id) =>
    method === "mining.authorize" ? [answer(id, true), NOTIFY] : [answer(id, [[], "00", 4])]);

  // Act
  const outcome = await probeMiningJob(pool, "operator-address", 2_000);

  // Assert
  expect(outcome).toBe("admitted_job");
});

test("finds no job when the pool authorizes but sends no notify in time", async () => {
  // Arrange
  const pool = stratumPool((method, id) => [answer(id, method === "mining.authorize" ? true : [[], "00", 4])]);

  // Act
  const outcome = await probeMiningJob(pool, "operator-address", 300);

  // Assert
  expect(outcome).toBe("no_job");
});

test("reports a refused authorization", async () => {
  // Arrange
  const pool = stratumPool((method, id) => [answer(id, method === "mining.authorize" ? false : [[], "00", 4])]);

  // Act
  const outcome = await probeMiningJob(pool, "operator-address", 2_000);

  // Assert
  expect(outcome).toBe("refused");
});

test("reports an unreachable pool", async () => {
  // Arrange
  const pool = stratumPool(() => []);
  maybeServer?.stop(true);

  // Act
  const outcome = await probeMiningJob(pool, "operator-address", 2_000);

  // Assert
  expect(outcome).toBe("unreachable");
});

test("is ready only with an available application and an admitted job", () => {
  // Act
  const verdict = readiness({ status: "available" }, "admitted_job");

  // Assert
  expect(verdict).toEqual({ ready: true, application: "available", miningJob: "admitted_job" });
});

test("isn't ready while the application is available but no job is admitted", () => {
  // Act
  const verdict = readiness({ status: "available" }, "no_job");

  // Assert
  expect(verdict.ready).toBe(false);
});

test("isn't ready when the application is unavailable, even with a job", () => {
  // Act
  const verdict = readiness({ status: "unavailable", part: "gate_authority" }, "admitted_job");

  // Assert
  expect(verdict).toEqual({ ready: false, application: "unavailable: gate_authority", miningJob: "admitted_job" });
});

test("isn't ready when mining readiness isn't configured", () => {
  // Act
  const verdict = readiness({ status: "available" }, "unconfigured");

  // Assert
  expect(verdict.ready).toBe(false);
});

test("reuses a probe's outcome within its time to live", async () => {
  // Arrange
  let probes = 0;
  let now = 0;
  const probe = cachedProbe(async () => {
    probes += 1;
    return "admitted_job" as const;
  }, 30_000, () => now);
  await probe();
  now = 29_999;

  // Act
  await probe();

  // Assert
  expect(probes).toBe(1);
});

test("probes again once the outcome is older than its time to live", async () => {
  // Arrange
  let probes = 0;
  let now = 0;
  const probe = cachedProbe(async () => {
    probes += 1;
    return "admitted_job" as const;
  }, 30_000, () => now);
  await probe();
  now = 30_000;

  // Act
  await probe();

  // Assert
  expect(probes).toBe(2);
});
