import { expect, test } from "bun:test";
import { parseWorkerV2Status } from "./worker-v2-serial";
import { WorkerV2SerialHistory } from "./worker-v2-serial-history";
import { v2Admitted, v2ShareFact } from "./worker-v2-serial.fixture";

test("pre-dispatch Share admission and cancelled terminal retain an unknown deadline", () => {
  const status = v2Admitted("share");
  expect(parseWorkerV2Status(status).record?.authorityDeadlineDeviceUs).toBeNull();
  status.state = status.record.state = "terminal"; status.record.outcome = "cancelled"; status.record.terminalAtDeviceUs = 1000;
  status.record.firstFailure = { stage: "preparing", category: "authority", atDeviceUs: 1000 };
  expect(parseWorkerV2Status(status).record?.authorityDeadlineDeviceUs).toBeNull();
});
test("the guarded attempt arms once before successful dispatch and UART failure does not refund it", () => {
  const status = v2Admitted("share"), history = new WorkerV2SerialHistory(); history.observe(parseWorkerV2Status(status));
  status.observation.observedAtUs = status.record.observedAtUs = 4000;
  status.record.authorityDeadlineDeviceUs = 180003000;
  history.observe(parseWorkerV2Status(status));
  status.record.firstFailure = { stage: "asic_dispatch", category: "evidence", atDeviceUs: 4000 };
  history.observe(parseWorkerV2Status(status));
  status.record.authorityDeadlineDeviceUs = null;
  expect(() => history.observe(parseWorkerV2Status(status))).toThrow("v2_retained_evidence");
});
test("renewal and fresh terminal observation cannot move the armed deadline", () => {
  const status = v2Admitted("share"), history = new WorkerV2SerialHistory();
  status.record.authorityDeadlineDeviceUs = 180001000; history.observe(parseWorkerV2Status(status));
  status.record.observedAtUs = status.observation.observedAtUs = 5000; history.observe(parseWorkerV2Status(status));
  status.record.authorityDeadlineDeviceUs += 1000;
  expect(() => history.observe(parseWorkerV2Status(status))).toThrow("v2_retained_evidence");
});
test.each(["missing", "future_epoch", "before_epoch", "fractional_epoch", "overflow"])("Share rejects %s arming evidence", field => {
  const status = v2Admitted("share");
  status.record.observedAtUs = status.observation.observedAtUs = 10000;
  status.record.shareFacts = [v2ShareFact()]; status.record.authorityDeadlineDeviceUs = 180001000;
  if (field === "missing") status.record.authorityDeadlineDeviceUs = null;
  if (field === "future_epoch") status.record.authorityDeadlineDeviceUs = 180011000;
  if (field === "before_epoch") status.record.authorityDeadlineDeviceUs = 180006000;
  if (field === "fractional_epoch") status.record.authorityDeadlineDeviceUs = 180001001;
  if (field === "overflow") status.record.authorityDeadlineDeviceUs = Number.MAX_SAFE_INTEGER + 1;
  expect(() => parseWorkerV2Status(status)).toThrow();
});
test("Channel retains its nonnullable admission-relative deadline", () => {
  const status = v2Admitted(); status.record.authorityDeadlineDeviceUs = null;
  expect(() => parseWorkerV2Status(status)).toThrow();
});
