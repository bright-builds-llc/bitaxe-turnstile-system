import { expect, test } from "bun:test";
import trustFixture from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import { parseWorkerDeploymentTrust } from "./worker-deployment-trust";
import { rejectedStartGrant } from "./worker-rejected-start";
import { verifyWorkerLeaseAuthorization } from "./worker-lease-authorization";
import { decodeBase64Url } from "./crypto-bytes";

test("recovery fixture has an invalid signature and contains no campaign reservation", async () => {
  // Arrange
  const trust = parseWorkerDeploymentTrust(trustFixture).workLeaseAuthority;
  const challengeId = "challenge_00000000000000000000000000000001";
  const binding = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  // Act
  const grant = await rejectedStartGrant(challengeId, binding, trust);
  const { authorization, ...request } = grant;
  // Assert
  expect(grant.acceptanceCampaign).toBeUndefined();
  expect(decodeBase64Url(authorization.split(".")[2] ?? "", 86, "signature")).toEqual(new Uint8Array(64));
  await expect(verifyWorkerLeaseAuthorization(authorization, { operation: "start", activeChallengeId: challengeId, controlSessionBindingSha256: binding, request }, trust)).rejects.toThrow();
});


test("correlated rejection parser drops arbitrary messages and extra payload fields", async () => {
  const { parseWorkerControlRejection } = await import("./worker-control-rejection");
  expect(parseWorkerControlRejection({ code: "command_rejected", message: "authentication_failed" })).toBe("authentication_failed");
  for (const error of [{ code: "command_rejected", message: "private" }, { code: "command_rejected", message: "authentication_failed", payload: "private" }, { code: "arbitrary", message: "authentication_failed" }]) expect(() => parseWorkerControlRejection(error)).toThrow();
});


test("actual browser recovery fixture requires correlated authentication rejection and releases port", async () => {
  // Arrange
  const { serialHarness } = await import("./worker-serial.test-support");
  const { createWebSerialWorkerController, workerSerialQualificationHook } = await import("./webserial-worker-controller");
  const h = await serialHarness();
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false } });
  const controller = createWebSerialWorkerController(h.input);
  await controller.requestPermission();
  // Act
  const result = await controller.rejectStartForRecoveryTest(h.trust);
  // Assert
  expect(result).toEqual({ rejected: true, error: "authentication_failed" });
  expect(h.counts()).toEqual({ opened: 1, closed: 1, locked: false, active: false });
  expect(h.received.at(-1)?.command).toBe("start_lease");
});
