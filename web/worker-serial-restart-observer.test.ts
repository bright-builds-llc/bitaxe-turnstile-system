import { expect, test } from "bun:test";
import { WorkerSerialRestartObserver } from "./worker-serial-restart-observer";
import { WorkerSerialFramer, WORKER_SERIAL_PROFILE, encodeWorkerSerialEnvelope } from "./worker-serial";
import { restartBootBytes } from "./worker-restart.fixture";
const request = { requestNonce: "A".repeat(22), expectedBootOrdinal: 1 };
const identity = { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64) };
const ack = { schema: "worker-qualification-restart-v1", requestNonce: request.requestNonce, bootOrdinal: 1, nextBootOrdinal: 2 };
const create = (now = () => 0) => new WorkerSerialRestartObserver(request, identity, now, "f".repeat(64));

test("ACK receive callback switches the existing framer before coalesced boot bytes", async () => {
  // Arrange
  const observer = create(); const framer = new WorkerSerialFramer(); framer.observeExpectedRestart(observer);
  const frame = await encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "control", sessionId: "A".repeat(22), sequence: 1, payload: ack });
  const input = Uint8Array.from([...frame, ...restartBootBytes(2)]);
  // Act
  await framer.push(input, value => observer.acknowledge(value.payload)); await observer.ready;
  // Assert
  expect(observer.summary()).toMatchObject({ ackMatched: true, bootObserved: true, runtimeReadyObserved: true, identityMatched: false, records: 5, bytes: input.length });
  const evidence = observer.evidence(); expect(evidence.lifecycle[1]?.record).toBe(1);
  expect(evidence.observations[0]?.record).toBe(2);
  expect(() => observer.complete()).toThrow();
});
test("512 records and262144bytes are shared bounds rather than per-read allowances", () => {
  const records = create(); for (let i = 0; i < 512; i++) records.byte(10);
  expect(() => records.byte(10)).toThrow();
  const bytes = create(); bytes.bytesReceived(262144);
  expect(() => bytes.bytesReceived(1)).toThrow();
});
test("the30second deadline never resets when observation phases change", () => {
  let now = 0; const value = create(() => now); now = 20000; value.acknowledge(ack);
  expect(value.remaining()).toBe(10000); now = 30000;
  expect(() => value.remaining()).toThrow();
});
test("runtime-ready progress starts only after the expected new boot", async () => {
  // Arrange
  const value = create(); value.acknowledge(ack);
  const startup = (uptime_ms: number) => value.diagnostic({ category: "startup", authoritative: false, stage: "runtime_ready", state: "complete", first_failure: "none", uptime_ms });
  startup(100000); startup(100500);
  value.diagnostic({ category: "runtime_identity", authoritative: false, firmware_commit: identity.firmwareSourceCommit, app_elf_sha256: identity.appElfSha256 });
  // Act
  value.diagnostic({ category: "boot", authoritative: false, boot_ordinal: 2, reset_reason: "software_cpu", uptime_ms: 50 });
  expect(value.summary().runtimeReadyObserved).toBeFalse();
  startup(1000); startup(1000); expect(value.summary().runtimeReadyObserved).toBeFalse(); startup(1500);
  await value.ready;
  // Assert
  expect(value.summary().runtimeReadyObserved).toBeTrue();
  expect(value.evidence().observations.filter(value => value.diagnostic.category === "startup")).toHaveLength(5);
});

test("unexpected boot ordinal or reset cause cannot complete the expected reset", () => {
  for (const change of [{ boot_ordinal: 3 }, { reset_reason: "watchdog" }]) {
    const value = create(); value.acknowledge(ack);
    expect(() => value.diagnostic({ category: "boot", authoritative: false, boot_ordinal: 2, reset_reason: "software_cpu", uptime_ms: 1, ...change })).toThrow();
  }
});
test("completed evidence remains frozen while later ordinary diagnostics advance", () => {
  let now = 0; const value = create(() => now); value.acknowledge(ack);
  for (const line of new TextDecoder().decode(restartBootBytes(2)).trim().split("\n")) value.rawRecord(new TextEncoder().encode(line));
  value.admitted(); now = 100; const saved = value.complete(); now = 1000;
  expect(value.evidence()).toEqual(saved);
});

test("an interrupted stream is never labelled uninterrupted before reopening succeeds", () => {
  const value = create(); value.acknowledge(ack);
  expect(() => value.requireReopen()).toThrow(); value.interrupted();
  expect(value.summary()).toMatchObject({ streamInterrupted: true, portReopens: 0, continuity: "interrupted" });
});

test("closed diagnostic observations cannot retain injected private fields", () => {
  const value = create(); value.acknowledge(ack);
  expect(() => value.diagnostic({ category: "boot", authoritative: false, boot_ordinal: 2, reset_reason: "software_cpu", uptime_ms: 1, private: "not evidence" })).toThrow();
  expect(value.evidence().observations).toHaveLength(0);
});


test("startup failure before the expected boot remains a failure", () => {
  // Arrange
  const value = create(); value.acknowledge(ack);
  // Act / Assert
  expect(() => value.diagnostic({ category: "startup", authoritative: false, stage: "runtime_ready", state: "failed", first_failure: "runtime_ready", uptime_ms: 100000 })).toThrow();
  expect(value.evidence().observations).toHaveLength(1);
  expect(value.summary().runtimeReadyObserved).toBeFalse();
});

const statistics = (state: string) => ({ category: "statistics_startup", authoritative: false, state, errno: "unavailable", stack_bytes: 8192, stack_caps: 2052, before_free_bytes: 40000, before_largest_block_bytes: 20000, after_free_bytes: 30000, after_largest_block_bytes: 16000 });
const replayBoot = (value: WorkerSerialRestartObserver) => {
  for (const line of new TextDecoder().decode(restartBootBytes(2)).trim().split("\n")) value.rawRecord(new TextEncoder().encode(line));
};

test("prepared statistics owner withholds fresh Hello until active", async () => {
  // Arrange
  const value = create(); value.acknowledge(ack);
  value.diagnostic(statistics("prepared"));
  let ready = false; void value.ready.then(() => { ready = true; });
  // Act
  replayBoot(value); await Promise.resolve();
  // Assert
  expect(ready).toBeFalse();
  expect(() => value.helloStarted()).toThrow();
  value.diagnostic(statistics("active")); await value.ready;
  expect(() => value.helloStarted()).not.toThrow();
  value.admitted(); expect(value.complete().summary.stage).toBe("complete");
});

test("queued old statistics active cannot satisfy the next boot", async () => {
  // Arrange
  const value = create(); value.acknowledge(ack);
  value.diagnostic(statistics("active")); value.diagnostic(statistics("prepared"));
  let ready = false; void value.ready.then(() => { ready = true; });
  // Act
  replayBoot(value); await Promise.resolve();
  // Assert
  expect(ready).toBeFalse();
  value.diagnostic(statistics("active")); await value.ready;
});

test.each(["spawn_failed", "config_failed", "cancelled"])("statistics %s is retained and rejects restart admission", state => {
  // Arrange
  const value = create(); value.acknowledge(ack);
  const diagnostic = state === "config_failed" ? { ...statistics(state), stack_caps: "unavailable", before_free_bytes: "unavailable", before_largest_block_bytes: "unavailable", after_free_bytes: "unavailable", after_largest_block_bytes: "unavailable" } : statistics(state);
  // Act / Assert
  expect(() => value.diagnostic(diagnostic)).toThrow();
  expect(value.evidence().observations[0]?.diagnostic).toEqual(diagnostic);
  expect(() => value.helloStarted()).toThrow();
});

test("statistics export rejects private injected fields before retention", () => {
  const value = create(); value.acknowledge(ack);
  expect(() => value.diagnostic({ ...statistics("prepared"), raw_error: "private" })).toThrow();
  expect(value.evidence().observations).toHaveLength(0);
});

test("statistics activation must be reobserved after a same-port gap", async () => {
  // Arrange
  const value = create(); value.acknowledge(ack);
  value.diagnostic(statistics("prepared")); replayBoot(value); value.diagnostic(statistics("active")); await value.ready;
  value.interrupted(); value.reopened();
  let ready = false; void value.ready.then(() => { ready = true; });
  // Act
  replayBoot(value); await Promise.resolve();
  // Assert
  expect(ready).toBeFalse(); expect(() => value.helloStarted()).toThrow();
  value.diagnostic(statistics("active")); await value.ready;
});
