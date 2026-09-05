import { BrowserSerialController } from "./worker-serial-controller-runtime";
import { browserSerialRuntime, workerSerialTestRuntime } from "./webserial-worker-port";
import {
  workerSerialQualificationHook, type WorkerSerialQualificationHook, type WorkerSerialInternalOptions,
  type WebSerialWorkerControllerInput, type WebSerialWorkerController
} from "./worker-serial-controller.types";
export {
  workerSerialQualificationHook, type WorkerSerialQualificationHook, type WorkerSerialInternalOptions,
  type WebSerialWorkerControllerInput, type WebSerialWorkerController
} from "./worker-serial-controller.types";

/** Creates the direct foreground-only production adapter; construction performs no port effect. */
export function createWebSerialWorkerController(
  input: WebSerialWorkerControllerInput,
): WebSerialWorkerController {
  const maybeOptions = (
    input as WebSerialWorkerControllerInput & {
      [workerSerialTestRuntime]?: WorkerSerialInternalOptions;
    }
  )[workerSerialTestRuntime];
  return new BrowserSerialController(
    input,
    maybeOptions?.runtime ?? browserSerialRuntime(),
    maybeOptions?.continuity,
    (
      input as WebSerialWorkerControllerInput & {
        [workerSerialQualificationHook]?: WorkerSerialQualificationHook;
      }
    )[workerSerialQualificationHook],
  );
}
