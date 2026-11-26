import { expect, test } from "bun:test";

import type { HeadlessTransport } from "./headless-client.types";
import { createStandardStratumWorker, type StandardWorkerSettings } from "./headless-standard-worker";
import type { WorkerLeaseGrant } from "./worker-controller";

const SETTINGS = { endpoint: "stratum+tcp://pool-adapter.test:3334/", username: "u".repeat(32), password: "p".repeat(43) };

function grant(stratum: WorkerLeaseGrant["stratum"] = SETTINGS): WorkerLeaseGrant {
  return {
    protocolVersion: "bwg-worker-controller/0.4",
    leaseId: "lease-1",
    challengeId: "challenge-1",
    authorization: "authorization",
    durationMilliseconds: 60_000,
    renewAfterMilliseconds: 30_000,
    stratum,
  };
}

function innerTransport(options: { maybeGrant?: WorkerLeaseGrant; maybeStartFailure?: Error } = {}): {
  transport: HeadlessTransport;
  calls: string[];
  bindings: (string | undefined)[];
  emit(state: "active" | "satisfied" | "cancelled" | "expired"): Promise<void>;
} {
  const calls: string[] = [];
  const bindings: (string | undefined)[] = [];
  let maybeListener: Parameters<HeadlessTransport["subscribeAuthorityEvents"]>[0] | undefined;
  return {
    calls,
    bindings,
    transport: {
      async start(_receipt, maybeContext) {
        calls.push("start");
        bindings.push(maybeContext?.controlSessionBindingSha256);
        if (options.maybeStartFailure) throw options.maybeStartFailure;
        return options.maybeGrant ?? grant();
      },
      async pause() {
        calls.push("pause");
      },
      async resume(maybeContext) {
        calls.push("resume");
        bindings.push(maybeContext?.controlSessionBindingSha256);
        return options.maybeGrant ?? grant();
      },
      async cancel() {
        calls.push("cancel");
      },
      async renewWorkerLease(maybeContext) {
        calls.push("renew");
        bindings.push(maybeContext?.controlSessionBindingSha256);
        return {
          protocolVersion: "bwg-worker-controller/0.4",
          leaseId: "lease-1",
          authorization: "renewed",
          durationMilliseconds: 60_000,
          renewAfterMilliseconds: 30_000,
        };
      },
      subscribeAuthorityEvents(listener) {
        maybeListener = listener;
        return () => {
          maybeListener = undefined;
        };
      },
    },
    async emit(state) {
      await maybeListener?.({ type: "challenge_lifecycle", state });
    },
  };
}

async function started() {
  const worker = await createStandardStratumWorker();
  const inner = innerTransport();
  const transport = worker.transport(inner.transport);
  const seen: (StandardWorkerSettings | undefined)[] = [];
  worker.subscribe((maybeSettings) => seen.push(maybeSettings));
  transport.subscribeAuthorityEvents(async () => undefined);
  await transport.start(undefined, await worker.prepareWorkerLeaseAuthorizationContext("start"));
  return { worker, inner, transport, seen };
}

test("names its control session with one SHA-256 digest in base64url", async () => {
  // Arrange
  const worker = await createStandardStratumWorker();

  // Act
  const context = await worker.prepareWorkerLeaseAuthorizationContext("start");

  // Assert
  expect(context.controlSessionBindingSha256).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("keeps one control session from Start to Renew", async () => {
  // Arrange
  const worker = await createStandardStratumWorker();

  // Act
  const contexts = [
    await worker.prepareWorkerLeaseAuthorizationContext("start"),
    await worker.prepareWorkerLeaseAuthorizationContext("renew"),
  ];

  // Assert
  expect(contexts[1]).toEqual(contexts[0]);
});

test("gives each page its own control session", async () => {
  // Act
  const [first, second] = await Promise.all([createStandardStratumWorker(), createStandardStratumWorker()]);

  // Assert
  expect((await first.prepareWorkerLeaseAuthorizationContext("start")).controlSessionBindingSha256).not.toBe(
    (await second.prepareWorkerLeaseAuthorizationContext("start")).controlSessionBindingSha256,
  );
});

test("shows the started lease's Stratum settings", async () => {
  // Act
  const { worker } = await started();

  // Assert
  expect(worker.settings()).toEqual(SETTINGS);
});

test("tells a subscriber when the settings arrive", async () => {
  // Act
  const { seen } = await started();

  // Assert
  expect(seen).toEqual([undefined, SETTINGS]);
});

test("keeps the same settings across a Renew", async () => {
  // Arrange
  const { worker, transport } = await started();

  // Act
  await transport.renewWorkerLease?.(await worker.prepareWorkerLeaseAuthorizationContext("renew"));

  // Assert
  expect(worker.settings()).toEqual(SETTINGS);
});

test("withdraws the settings before a Pause reaches the Authority", async () => {
  // Arrange
  const { worker, inner, transport } = await started();
  let settingsAtPause: StandardWorkerSettings | undefined = SETTINGS;
  const pause = inner.transport.pause;
  inner.transport.pause = async () => {
    settingsAtPause = worker.settings();
    await pause();
  };

  // Act
  await transport.pause();

  // Assert
  expect(settingsAtPause).toBeUndefined();
});

test("withdraws the settings on Cancel", async () => {
  // Arrange
  const { worker, transport } = await started();

  // Act
  await transport.cancel();

  // Assert
  expect(worker.settings()).toBeUndefined();
});

for (const state of ["satisfied", "cancelled", "expired"] as const) {
  test(`withdraws the settings when the Authority reports ${state}`, async () => {
    // Arrange
    const { worker, inner } = await started();

    // Act
    await inner.emit(state);

    // Assert
    expect(worker.settings()).toBeUndefined();
  });
}

test("keeps the settings while the Authority reports the challenge active", async () => {
  // Arrange
  const { worker, inner } = await started();

  // Act
  await inner.emit("active");

  // Assert
  expect(worker.settings()).toEqual(SETTINGS);
});

test("shows no settings when Start fails", async () => {
  // Arrange
  const worker = await createStandardStratumWorker();
  const transport = worker.transport(innerTransport({ maybeStartFailure: new Error("refused") }).transport);

  // Act
  const start = transport.start(undefined, await worker.prepareWorkerLeaseAuthorizationContext("start"));

  // Assert
  await expect(start).rejects.toThrow("refused");
  expect(worker.settings()).toBeUndefined();
});

test("pauses a lease that carries no Stratum V1 settings, and refuses it", async () => {
  // Arrange
  const worker = await createStandardStratumWorker();
  const v2 = grant({ profile: "bwg-worker-sv2/0.1", endpoint: "pool:3336", authorityPublicKey: "k", userIdentity: "u" } as never);
  const inner = innerTransport({ maybeGrant: v2 });
  const transport = worker.transport(inner.transport);

  // Act
  const start = transport.start(undefined, await worker.prepareWorkerLeaseAuthorizationContext("start"));

  // Assert
  await expect(start).rejects.toThrow("the Work Lease has no Stratum V1 settings");
  expect(inner.calls).toEqual(["start", "pause"]);
});

test("shows a resumed lease's settings", async () => {
  // Arrange
  const { worker, transport } = await started();
  await transport.pause();

  // Act
  await transport.resume(await worker.prepareWorkerLeaseAuthorizationContext("start"));

  // Assert
  expect(worker.settings()).toEqual(SETTINGS);
});
