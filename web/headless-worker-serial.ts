import { createHeadlessClient } from "./headless-client";
import type {
  HeadlessClient,
  HeadlessClientInput,
} from "./headless-client.types";
import {
  createWebSerialWorkerController,
  type WebSerialWorkerControllerInput,
} from "./webserial-worker-controller";

/** Direct user-gesture entrypoint composing production serial admission and Authority work flows. */
export async function connectWebSerialHeadlessClient(input: {
  client: Omit<
    HeadlessClientInput,
    "maybeWorkerController" | "maybeWorkerLeaseAuthorizationContext"
  >;
  worker: WebSerialWorkerControllerInput;
}): Promise<HeadlessClient> {
  if (
    input.client.challenge.challengeId !==
    input.worker.continuityScope.challengeId
  ) {
    throw new Error("Worker Serial challenge binding mismatch");
  }
  const controller = createWebSerialWorkerController(input.worker);
  await controller.requestPermission();
  let client: HeadlessClient;
  try {
    client = await createHeadlessClient({
      ...input.client,
      maybeWorkerController: controller,
      maybeWorkerLeaseAuthorizationContext: controller,
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
