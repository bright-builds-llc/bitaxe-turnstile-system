import { encodeBase64Url, sha256Base64UrlBytes } from "./crypto-bytes";
import { canonicalJson } from "./headless-values";
import { createWorkerPossessionChallenge } from "./worker-possession";
import { workerSerialManifestSha256 } from "./worker-serial";
import type { WorkerControllerCapabilities } from "./worker-controller";
import type {
  Ack,
  WebSerialWorkerControllerInput,
} from "./worker-serial-controller.types";

/** Binds a fresh proof to this exact serial handshake and the deployment package expectation. */
export async function proveWorkerSerialPossession(input: {
  ack: Ack;
  capabilities: WorkerControllerCapabilities;
  requestId: string;
  challengeBindingSha256: string;
  maybeFingerprint: string | undefined;
  expected: WebSerialWorkerControllerInput;
  exchange(
    request: { requestId: string } & Record<string, unknown>,
  ): Promise<unknown>;
}) {
  const { ack } = input;
  const binding = {
    requestId: input.requestId,
    possessionNonce: encodeBase64Url(
      crypto.getRandomValues(new Uint8Array(32)),
    ),
    challengeBindingSha256: input.challengeBindingSha256,
    controllerCapabilitySha256: await sha256Base64UrlBytes(
      new TextEncoder().encode(canonicalJson(input.capabilities)),
    ),
    serialManifestSha256: await workerSerialManifestSha256(),
    sessionId: ack.sessionId,
    hostNonce: ack.hostNonce,
    deviceNonce: ack.deviceNonce,
    expectedFirmwareSourceCommit:
      input.expected.expectedFirmwareSourceCommit ?? ack.firmwareSourceCommit,
    expectedAppElfSha256:
      input.expected.expectedAppElfSha256 ?? ack.appElfSha256,
  };
  const challenge = createWorkerPossessionChallenge(
    input.maybeFingerprint
      ? {
          ...binding,
          purpose: "transport_reacquisition",
          expectedDeviceIdentityFingerprint: input.maybeFingerprint,
        }
      : { ...binding, purpose: "initial_admission" },
  );
  return challenge.verify(await input.exchange(challenge.request));
}
