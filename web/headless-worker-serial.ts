import { createHeadlessClient } from "./headless-client";
import type {
  HeadlessClient,
  HeadlessClientInput,
} from "./headless-client.types";
import {
  createWebSerialWorkerController,
  type WebSerialWorkerController,
  type WebSerialWorkerControllerInput,
} from "./webserial-worker-controller";

type SerialClientInput = Omit<
  HeadlessClientInput,
  | "maybeWorkerController"
  | "maybeWorkerLeaseAuthorizationContext"
  | "maybeReleaseWorker"
>;

/** Stands in until `prepareClient` has minted the challenge; it is never stored or sent. */
const PENDING_SCOPE = { challengeId: "challenge_pending_serial_permission", retentionExpiryUnixSeconds: 1 };

/**
 * Direct user-gesture entrypoint composing production serial admission and Authority work flows.
 * With `prepareClient`, the chooser opens first and the challenge is minted only once a port is
 * chosen, so a cancelled chooser leaves no challenge and the gesture isn't spent on the request.
 */
export async function connectWebSerialHeadlessClient(
  input:
    | { client: SerialClientInput; worker: WebSerialWorkerControllerInput }
    | {
        prepareClient(): Promise<SerialClientInput>;
        worker: Omit<WebSerialWorkerControllerInput, "continuityScope">;
      },
): Promise<HeadlessClient> {
  if ("client" in input) {
    if (input.client.challenge.challengeId !== input.worker.continuityScope.challengeId) {
      throw new Error("Worker Serial challenge binding mismatch");
    }
    const controller = createWebSerialWorkerController(input.worker);
    await controller.requestPermission();
    return await withController(controller, input.client);
  }
  const prepare = input.prepareClient;
  let maybePrepared: SerialClientInput | undefined;
  let maybePrepareFailure: { error: unknown } | undefined;
  const controller = createWebSerialWorkerController({
    ...input.worker,
    continuityScope: PENDING_SCOPE,
    async maybePrepareScope() {
      try {
        maybePrepared = await prepare();
      } catch (error) {
        maybePrepareFailure = { error };
        throw error;
      }
      return {
        challengeId: maybePrepared.challenge.challengeId,
        retentionExpiryUnixSeconds: maybePrepared.challenge.expiresAtUnixSeconds,
      };
    },
  });
  try {
    await controller.requestPermission();
  } catch (error) {
    // Admission reports its own failures by stage; the challenge request's error reaches the page as it was.
    throw maybePrepareFailure ? maybePrepareFailure.error : error;
  }
  if (!maybePrepared) throw new Error("Worker Serial admitted without a prepared challenge");
  return await withController(controller, maybePrepared);
}

async function withController(
  controller: WebSerialWorkerController,
  clientInput: SerialClientInput,
): Promise<HeadlessClient> {
  let client: HeadlessClient;
  try {
    client = await createHeadlessClient({
      ...clientInput,
      maybeWorkerController: controller,
      maybeWorkerLeaseAuthorizationContext: controller,
      // A confirmed Cancel or expiry hands the port back to other tools, as redemption does.
      maybeReleaseWorker: (reason) => controller.close(reason),
    });
  } catch (error) {
    try {
      await controller.close("control_failed");
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Worker client setup and cleanup failed",
      );
    }
    throw error;
  }
  return {
    ...client,
    async close() {
      const errors: unknown[] = [];
      try {
        await client.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await controller.close("tab_closed");
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(errors, "Worker client close failed");
    },
  };
}
