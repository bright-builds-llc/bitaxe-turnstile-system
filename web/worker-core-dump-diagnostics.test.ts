import { expect, test } from "bun:test";
import { maybeWorkerSerialDiagnostic, maybeValidatedDiagnostic, WorkerSerialDiagnosticHistory } from "./worker-serial-diagnostics";
import { parseWorkerDiagnosticExport } from "./worker-diagnostic-export";
import { WorkerSerialFramer, encodeWorkerSerialEnvelope, WORKER_SERIAL_PROFILE } from "./worker-serial";

const valid = "core_dump_store_receipt schema=v1 origin=previous_boot status=valid source_hash=0123456789abcdef boot_ordinal=18446744073709551615 stage=store_returned capacity_bytes=974848 requested_bytes=1200000 prepared_bytes=1200000 init_result=0 prepare_result=257 start_result=unavailable end_result=unavailable store_result=257 self_test_marked=true redacted=true";
const receipt = (line = valid) => {
  const maybeValue = maybeWorkerSerialDiagnostic(line);
  if (!maybeValue) throw Error("synthetic core receipt rejected");
  return maybeValue;
};

test("store receipts preserve full u64 boot, bounded numbers and explicit unavailable results", () => {
  const value = receipt();
  expect(value).toMatchObject({ category: "core_dump_store_receipt", authoritative: false, origin: "previous_boot", status: "valid",
    source_hash: "0123456789abcdef", boot_ordinal: "18446744073709551615", capacity_bytes: 974848, requested_bytes: 1200000,
    init_result: 0, prepare_result: 257, start_result: "unavailable", store_result: 257, self_test_marked: true });
  expect(parseWorkerDiagnosticExport({ schema: "worker-diagnostic-export-v1", observations: [value] }).observations).toEqual([value]);
});
test.each(["ready", "store_entered", "init_entered", "init_returned", "prepare_entered", "prepare_returned", "start_entered", "start_returned", "end_entered", "end_returned", "store_returned"])("closed store stage %s is exported without inferring success", stage => {
  expect(receipt(valid.replace("stage=store_returned", `stage=${stage}`)).stage).toBe(stage);
});
test.each(["unavailable", "corrupt", "wrong_firmware", "wrong_boot"])("%s carries only origin and status", status => {
  const line = `core_dump_store_receipt schema=v1 origin=current_boot status=${status} redacted=true`;
  expect(receipt(line)).toEqual({ category: "core_dump_store_receipt", authoritative: false, origin: "current_boot", status });
  expect(maybeWorkerSerialDiagnostic(line.replace(" redacted=true", " capacity_bytes=1 redacted=true"))).toBeUndefined();
});
test("negative SDK results remain numeric and never alias unavailable", () => {
  const value = receipt(valid.replace("init_result=0", "init_result=-1").replace("prepare_result=257", "prepare_result=-2147483648").replace("store_result=257", "store_result=2147483647"));
  expect(value.init_result).toBe(-1); expect(value.prepare_result).toBe(-2147483648); expect(value.store_result).toBe(2147483647);
  expect(receipt(valid.replace("requested_bytes=1200000", "requested_bytes=unavailable")).requested_bytes).toBe("unavailable");
  expect(receipt(valid.replace("prepared_bytes=1200000", "prepared_bytes=unavailable")).prepared_bytes).toBe("unavailable");
  expect(receipt(valid.replace("capacity_bytes=974848", "capacity_bytes=0")).capacity_bytes).toBe(0);
});
test("store diagnostics reject open strings, overflow, noncanonical numbers and extra fields", () => {
  const changes: [string, string][] = [
    ["schema=v1", "schema=v2"], ["origin=previous_boot", "origin=private"], ["status=valid", "status=complete"],
    ["source_hash=0123456789abcdef", "source_hash=0123456789ABCDEF"], ["stage=store_returned", "stage=private"],
    ["boot_ordinal=18446744073709551615", "boot_ordinal=18446744073709551616"], ["boot_ordinal=18446744073709551615", "boot_ordinal=01"],
    ["capacity_bytes=974848", "capacity_bytes=4294967296"], ["capacity_bytes=974848", "capacity_bytes=unavailable"],
    ["requested_bytes=1200000", "requested_bytes=-1"], ["prepared_bytes=1200000", "prepared_bytes=1.5"],
    ["init_result=0", "init_result=-2147483649"], ["prepare_result=257", "prepare_result=2147483648"], ["init_result=0", "init_result=-0"],
    ["self_test_marked=true", "self_test_marked=1"], ["redacted=true", "extra=private redacted=true"], ["redacted=true", "redacted=false"],
  ];
  for (const [from, to] of changes) expect(maybeWorkerSerialDiagnostic(valid.replace(from, to))).toBeUndefined();
  expect(maybeWorkerSerialDiagnostic(`${valid}\n`)).toBeUndefined();
  expect(maybeWorkerSerialDiagnostic(`${valid} ${"x".repeat(1024)}`)).toBeUndefined();
});
test("export revalidation rejects attached fields, rounded boot counters and changed boolean types", () => {
  const value = receipt();
  for (const changed of [{ ...value, secret: "synthetic" }, { ...value, authoritative: true }, { ...value, boot_ordinal: 42 },
    { ...value, self_test_marked: "true" }, { ...value, capacity_bytes: "974848" }, { ...value, prepare_result: "257" }]) {
    expect(maybeValidatedDiagnostic(changed)).toBeUndefined();
    expect(() => parseWorkerDiagnosticExport({ schema: "worker-diagnostic-export-v1", observations: [changed] })).toThrow();
  }
});
test("current and previous receipts remain separate despite identical source, boot and stage", () => {
  // Arrange
  const history = new WorkerSerialDiagnosticHistory(), previous = receipt(), current = receipt(valid.replace("origin=previous_boot", "origin=current_boot"));
  // Act
  history.observe(previous); history.observe(current);
  // Assert
  expect(history.values()).toEqual([previous, current]);
  history.clear(); expect(history.values()).toEqual([previous]);
});
test("receipt identity preserves different boots and sources while updating only one current record", () => {
  // Arrange
  const history = new WorkerSerialDiagnosticHistory();
  const first = receipt(valid.replace("origin=previous_boot", "origin=current_boot"));
  const next = receipt(valid.replace("boot_ordinal=18446744073709551615", "boot_ordinal=42"));
  const source = receipt(valid.replace("source_hash=0123456789abcdef", "source_hash=fedcba9876543210"));
  // Act
  for (const value of [first, next, source]) history.observe(value);
  history.observe({ ...first, stage: "end_returned" });
  // Assert
  expect(history.values()).toHaveLength(3);
  expect(history.values().find(value => value.origin === "current_boot")?.stage).toBe("end_returned");
  expect(parseWorkerDiagnosticExport({ schema: "worker-diagnostic-export-v1", observations: history.values() }).observations).toHaveLength(3);
});
test("previous store evidence survives ordinary diagnostic churn without enlarging the export bound", () => {
  const history = new WorkerSerialDiagnosticHistory(); history.observe(receipt());
  for (let stage = 0; stage < 100; stage++) history.observe({ category: "synthetic", stage });
  expect(history.values()).toHaveLength(33); history.clear(); expect(history.values()).toEqual([receipt()]);
});
test("actual native framer accepts fragmented store diagnostics without admitting protocol authority", async () => {
  // Arrange
  const history = new WorkerSerialDiagnosticHistory(), framer = new WorkerSerialFramer(value => history.observe(value));
  const bytes = new TextEncoder().encode(`${valid}\n`);
  // Act
  const frames = [...await framer.push(bytes.slice(0, 73)), ...await framer.push(bytes.slice(73))];
  // Assert
  expect(frames).toEqual([]);
  expect(parseWorkerDiagnosticExport({ schema: "worker-diagnostic-export-v1", observations: history.values() }).observations).toEqual([receipt()]);
});
test("receipt-looking control payloads remain control frames and never become observed diagnostics", async () => {
  const history = new WorkerSerialDiagnosticHistory(), framer = new WorkerSerialFramer(value => history.observe(value));
  const bytes = await encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "control", sessionId: "AAAAAAAAAAAAAAAAAAAAAA", sequence: 1, payload: { line: valid } });
  expect(await framer.push(bytes)).toHaveLength(1); expect(history.values()).toEqual([]);
});

test("firmware renderer ready marker preserves unavailable results instead of inventing initialization success", () => {
  const line = "core_dump_store_receipt schema=v1 origin=current_boot status=valid source_hash=000000000000002a boot_ordinal=18 stage=ready capacity_bytes=974848 requested_bytes=unavailable prepared_bytes=unavailable init_result=unavailable prepare_result=unavailable start_result=unavailable end_result=unavailable store_result=unavailable self_test_marked=false redacted=true";
  const value = receipt(line);
  expect(value).toMatchObject({ origin: "current_boot", stage: "ready", boot_ordinal: "18", source_hash: "000000000000002a",
    requested_bytes: "unavailable", prepared_bytes: "unavailable", init_result: "unavailable", store_result: "unavailable", self_test_marked: false });
  expect(maybeValidatedDiagnostic(value)).toEqual(value);
});
