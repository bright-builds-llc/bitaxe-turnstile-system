import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";

import controllerSchema from "../conformance/bwg-worker-controller-0.3/contract.schema.json";
import usbSchema from "../conformance/bwg-worker-usb-0.2/contract.schema.json";
import schema from "../conformance/bwg-worker-deployment-trust-0.1/contract.schema.json";
import fixtures from "../conformance/bwg-worker-deployment-trust-0.1/fixtures.json";
import { parseWorkerDeploymentTrust } from "./worker-deployment-trust";
import {
  parseWorkerLeaseGrantV03,
  verifyWorkerControllerCapabilityV03,
  type WorkerControllerCapabilitiesV03,
} from "./worker-controller-v03";
import {
  invalidateWorkerLeaseAdmissionContext,
  planWorkerLeaseAdmission,
  WorkerLeaseAdmissionError,
  type WorkerLeaseAdmissionState,
} from "./worker-lease-admission";
import {
  signWorkerLeaseAuthorization,
  verifyWorkerLeaseAuthorization,
  type WorkerLeaseAuthorizationInput,
} from "./worker-lease-authorization";
import { parseWorkerUsbApplicationDescriptor } from "./worker-usb-profile";

test("published deployment trust fixtures satisfy schema and runtime verification", async () => {
  // Arrange
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(controllerSchema);
  ajv.addSchema(usbSchema);
  const validate = ajv.compile(schema);

  // Act
  const schemaValid = validate(fixtures);
  const trust = parseWorkerDeploymentTrust(fixtures.trust);
  const descriptor = parseWorkerUsbApplicationDescriptor(
    fixtures.ultra205.capabilityInput.descriptor,
  );

  // Assert
  expect(validate.errors).toBeNull();
  expect(schemaValid).toBeTrue();
  await expect(verifyWorkerControllerCapabilityV03(
    fixtures.ultra205.signedCapability as WorkerControllerCapabilitiesV03,
    descriptor,
    trust.updateAuthority.keys,
  )).resolves.toMatchObject({
    board: { model: "bitaxe-ultra", revision: "205" },
  });
  await expect(verifyWorkerLeaseAuthorization(
    fixtures.start.artifact.authorization,
    fixtures.start.input as WorkerLeaseAuthorizationInput,
    trust.workLeaseAuthority,
  )).resolves.toMatchObject({ sequence: 1n });
  await expect(verifyWorkerLeaseAuthorization(
    fixtures.renew.artifact.authorization,
    fixtures.renew.input as WorkerLeaseAuthorizationInput,
    trust.workLeaseAuthority,
  )).resolves.toMatchObject({ sequence: 2n });
  await expect(verifyWorkerLeaseAuthorization(
    fixtures.start.artifact.authorization,
    fixtures.start.input as WorkerLeaseAuthorizationInput,
    {
      ...trust.workLeaseAuthority,
      keys: trust.updateAuthority.keys,
    },
  )).rejects.toThrow("Worker Lease authorization is invalid");
  await expect(verifyWorkerLeaseAuthorization(
    "A".repeat(513),
    fixtures.start.input as WorkerLeaseAuthorizationInput,
    trust.workLeaseAuthority,
  )).rejects.toThrow("Worker Lease authorization is invalid");
  expect(JSON.stringify(fixtures.trust)).not.toMatch(/"d"\s*:/u);
  for (const boundary of fixtures.authorizationBoundaries) {
    const candidate = {
      ...fixtures.start.input.request,
      authorization: "A".repeat(boundary.bytes),
    };
    if (boundary.expected === "controller_syntax_accepted") {
      expect(() => parseWorkerLeaseGrantV03(candidate)).not.toThrow();
    } else {
      expect(() => parseWorkerLeaseGrantV03(candidate)).toThrow("grant is invalid");
    }
  }

  const executedNegativeCases = new Map<string, string>();
  const negative = (id: string): Record<string, unknown> => {
    const maybeFixture = fixtures.negativeCases.find((fixture) => fixture.id === id);
    if (!maybeFixture) throw new Error(`missing negative fixture: ${id}`);
    return maybeFixture.parameters as Record<string, unknown>;
  };
  const startInput = fixtures.start.input as WorkerLeaseAuthorizationInput;
  if (startInput.operation !== "start") throw new Error("fixture must be Start");
  const invalidAuthorization = async (
    id: string,
    promise: Promise<unknown>,
  ): Promise<void> => {
    await expect(promise).rejects.toThrow("Worker Lease authorization is invalid");
    executedNegativeCases.set(id, "invalid_authorization");
  };
  expect(negative("wrong_authority_role").role).toBe("update_authority");
  await invalidAuthorization("wrong_authority_role", verifyWorkerLeaseAuthorization(
    fixtures.start.artifact.authorization,
    startInput,
    { ...trust.workLeaseAuthority, keys: trust.updateAuthority.keys },
  ));
  await invalidAuthorization("changed_request", verifyWorkerLeaseAuthorization(
    fixtures.start.artifact.authorization,
    {
      ...startInput,
      request: {
        ...startInput.request,
        stratum: {
          ...startInput.request.stratum,
          password: String(negative("changed_request").changedPassword),
        },
      },
    },
    trust.workLeaseAuthority,
  ));
  for (const id of ["changed_context", "same_nonce_different_identity"] as const) {
    const changedBinding = negative(id).controlSessionBindingSha256;
    if (typeof changedBinding !== "string") throw new Error("fixture binding missing");
    await invalidAuthorization(id, verifyWorkerLeaseAuthorization(
      fixtures.start.artifact.authorization,
      { ...startInput, controlSessionBindingSha256: changedBinding },
      trust.workLeaseAuthority,
    ));
  }
  const admissionState: WorkerLeaseAdmissionState = {
    maybeContext: {
      controlSessionBindingSha256: startInput.controlSessionBindingSha256,
      establishedAtMonotonicMilliseconds: Number(
        negative("withheld_context").establishedAtMonotonicMilliseconds,
      ),
    },
    highWaterByKeyId: {
      [trust.workLeaseAuthority.keys[0]?.kid ?? "lease"]:
        String(negative("replayed_sequence").highWater),
    },
  };
  const admissionInput = {
    operation: "start" as const,
    leaseId: startInput.request.leaseId,
    controlSessionBindingSha256: startInput.controlSessionBindingSha256,
    nowMonotonicMilliseconds: 2_000,
    authorization: {
      keyId: trust.workLeaseAuthority.keys[0]?.kid ?? "lease",
      sequence: BigInt(String(negative("replayed_sequence").presentedSequence)),
    },
  };
  for (const [id, state, input] of [
    ["replayed_sequence", admissionState, admissionInput],
    ["withheld_context", admissionState, {
      ...admissionInput,
      authorization: { ...admissionInput.authorization, sequence: 2n },
      nowMonotonicMilliseconds: Number(
        negative("withheld_context").presentedAtMonotonicMilliseconds,
      ),
    }],
    ["post_restore_context", (() => {
      expect(negative("post_restore_context").lifecycleEvent).toBe("restoration");
      return invalidateWorkerLeaseAdmissionContext(admissionState);
    })(), {
      ...admissionInput,
      authorization: { ...admissionInput.authorization, sequence: 2n },
    }],
    ["post_reboot_context", (() => {
      expect(negative("post_reboot_context").lifecycleEvent).toBe("reboot");
      return invalidateWorkerLeaseAdmissionContext(admissionState);
    })(), {
      ...admissionInput,
      authorization: { ...admissionInput.authorization, sequence: 2n },
    }],
    ["cross_session_replay", {
      highWaterByKeyId: {
        [admissionInput.authorization.keyId]:
          String(negative("cross_session_replay").highWater),
      },
      maybeContext: {
        controlSessionBindingSha256: String(
          negative("cross_session_replay").controlSessionBindingSha256,
        ),
        establishedAtMonotonicMilliseconds: 1_000,
      },
    }, {
      ...admissionInput,
      controlSessionBindingSha256: String(
        negative("cross_session_replay").controlSessionBindingSha256,
      ),
      authorization: {
        ...admissionInput.authorization,
        sequence: BigInt(
          String(negative("cross_session_replay").presentedSequence),
        ),
      },
    }],
    ["monotonic_reset", {
      ...admissionState,
      maybeContext: {
        ...admissionState.maybeContext,
        establishedAtMonotonicMilliseconds: Number(
          negative("monotonic_reset").establishedAtMonotonicMilliseconds,
        ),
      },
    } as WorkerLeaseAdmissionState, {
      ...admissionInput,
      authorization: { ...admissionInput.authorization, sequence: 2n },
      nowMonotonicMilliseconds: Number(
        negative("monotonic_reset").presentedAtMonotonicMilliseconds,
      ),
    }],
    ["corrupt_high_water", {
      ...admissionState,
      highWaterByKeyId: {
        [admissionInput.authorization.keyId]:
          String(negative("corrupt_high_water").corruptHighWater),
      },
    } as WorkerLeaseAdmissionState, {
      ...admissionInput,
      authorization: {
        ...admissionInput.authorization,
        sequence: BigInt(
          String(negative("corrupt_high_water").presentedSequence),
        ),
      },
    }],
  ] as const) {
    try {
      planWorkerLeaseAdmission(state, input);
      throw new Error("expected admission rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerLeaseAdmissionError);
      executedNegativeCases.set(id, (error as WorkerLeaseAdmissionError).code);
    }
  }
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign"]);
  await invalidAuthorization("sequence_overflow", signWorkerLeaseAuthorization({
    input: startInput,
    sequence: (
      BigInt(String(negative("sequence_overflow").currentSequence)) + 1n
    ).toString(),
    kid: "fixture-overflow-key",
    issuer: trust.workLeaseAuthority.issuer,
    audience: trust.workLeaseAuthority.audience,
    privateKey: keyPair.privateKey,
  }));
  executedNegativeCases.set("sequence_overflow", "sequence_exhausted");
  await invalidAuthorization("authorization_513_bytes", verifyWorkerLeaseAuthorization(
    "A".repeat(Number(negative("authorization_513_bytes").authorizationBytes)),
    startInput,
    trust.workLeaseAuthority,
  ));
  expect(Object.fromEntries(executedNegativeCases)).toEqual(
    Object.fromEntries(
      fixtures.negativeCases.map((fixture) => [fixture.id, fixture.expectedError]),
    ),
  );
});
