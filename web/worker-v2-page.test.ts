import { expect, test } from "bun:test";
import trust from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import { parseWorkerSerialAcceptanceConfiguration, requireWorkerAcceptanceModeTransition } from "./worker-serial-acceptance-config";
import { createWorkerV2PageOperations } from "./worker-v2-page";
import { WorkerPreservationBaseline } from "./worker-preservation";
import { v2Input, v2Idle, v2Admitted } from "./worker-v2-serial.fixture";
const identities = { before: { firmwareSourceCommit: "b".repeat(40), appElfSha256: "c".repeat(64) }, candidate: { firmwareSourceCommit: "d".repeat(40), appElfSha256: "e".repeat(64) } };
function config(phase: "before" | "candidate", scope = "channel") { return { expectedGateCommit: "a".repeat(40), expectedFirmwareSourceCommit: identities[phase].firmwareSourceCommit, expectedAppElfSha256: identities[phase].appElfSha256, trust, stratumV2Qualification: phase, stratumV2Identities: identities, stratumV2Scope: scope }; }
test("V2 immutable scope and pair allow one forward baseline transition only", () => {
  const before = parseWorkerSerialAcceptanceConfiguration(config("before"), "a".repeat(40)), candidate = parseWorkerSerialAcceptanceConfiguration(config("candidate"), "a".repeat(40));
  requireWorkerAcceptanceModeTransition(undefined, before); requireWorkerAcceptanceModeTransition(before, candidate); requireWorkerAcceptanceModeTransition(candidate, candidate);
  expect(() => requireWorkerAcceptanceModeTransition(undefined, candidate)).toThrow();
  expect(() => requireWorkerAcceptanceModeTransition(candidate, before)).toThrow();
  expect(() => requireWorkerAcceptanceModeTransition(candidate, { ...candidate, stratumV2Scope: "share" })).toThrow();
  expect(() => parseWorkerSerialAcceptanceConfiguration({ ...config("before"), noiseQualification: "before" }, "a".repeat(40))).toThrow();
});
test("separate Share scope captures its own same-pair baseline", () => {
  const same = { ...config("before", "share"), stratumV2Identities: { before: identities.before, candidate: identities.before } };
  const before = parseWorkerSerialAcceptanceConfiguration(same, "a".repeat(40));
  const candidate = parseWorkerSerialAcceptanceConfiguration({ ...same, stratumV2Qualification: "candidate" }, "a".repeat(40));
  requireWorkerAcceptanceModeTransition(undefined, before); requireWorkerAcceptanceModeTransition(before, candidate);
});
test("page keeps its private baseline through four reconnects and never imports it into Share", async () => {
  const preservation = new WorkerPreservationBaseline();
  const sample = { schema: "worker-preservation-v1" as const, settings_sha256: "1".repeat(64), authorization_high_water_sha256: "2".repeat(64), device_identity_sha256: "3".repeat(64), mine_on_boot: false };
  preservation.observe(sample); const original = preservation.maybePublicState()?.baseline_id;
  let starts = 0;
  const page = createWorkerV2PageOperations({ maybeReviewedBinding: () => undefined, serializeRead: run => run(), changed() {}, phase: () => "candidate", scope: () => "channel", connected: () => true, idle: () => true, maybePreservation: () => preservation.maybePublicState(), controller: () => ({ async prepareWorkerLeaseAuthorizationContext() { return { controlSessionBindingSha256: "fresh" }; }, async telemetryCadenceEndpoint() { throw Error("unused_endpoint"); }, async stratumV2ChannelStart() { starts++; return v2Admitted(); }, async stratumV2Status() { return v2Idle(); }, async stratumV2ChannelCancel() { return v2Idle(); } }) });
  for (let i = 0; i < 4; i++) { preservation.observe(sample); expect(await page.stratumV2Possession()).toBe("fresh"); }
  await page.stratumV2ChannelStart(v2Input, "fresh");
  await expect(page.stratumV2ChannelStart(v2Input, "fresh")).rejects.toThrow();
  await expect(page.stratumV2Status("share", null, "fresh")).rejects.toThrow();
  expect(starts).toBe(1); expect(preservation.maybePublicState()?.baseline_id).toBe(original);
});

test("production page composes with serial admission, four fresh cycles and restoration", async () => {
  const { runV2PageSerialConformance } = await import("./worker-v2-page.fixture");
  await runV2PageSerialConformance();
});

test("an ambiguous funded Start cannot consume another page claim after controller replacement", async () => {
  const { WorkerV2ShareStartClaim } = await import("./worker-v2-page");
  const claim = new WorkerV2ShareStartClaim(); let writes = 0;
  const start = async () => { claim.consume(); writes++; throw Error("response_lost"); };
  await expect(start()).rejects.toThrow("response_lost");
  await expect(start()).rejects.toThrow("v2_share_start_consumed");
  expect(writes).toBe(1);
});

test("before phase and Channel scope cannot enter existing signed work or cooling routes", async () => {
  const { requireWorkerV2ShareMode } = await import("./worker-v2-configuration");
  expect(() => requireWorkerV2ShareMode({ stratumV2Qualification: "before", stratumV2Scope: "share" })).toThrow();
  expect(() => requireWorkerV2ShareMode({ stratumV2Qualification: "candidate", stratumV2Scope: "channel" })).toThrow();
  expect(() => requireWorkerV2ShareMode({ stratumV2Qualification: "candidate", stratumV2Scope: "share" })).not.toThrow();
  expect(() => requireWorkerV2ShareMode(undefined)).not.toThrow();
});
