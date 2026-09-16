import type { WebSerialWorkerControllerInput } from "./worker-serial-controller.types";
import { serialFailure } from "./worker-serial";

/** Exact runtime pins are optional for ordinary controllers, never partially parsed. */
export function validateWorkerSerialControllerInput(input: WebSerialWorkerControllerInput): void {
  if (input.expectedFirmwareSourceCommit !== undefined && !/^[0-9a-f]{40}$/u.test(input.expectedFirmwareSourceCommit)) throw serialFailure("source_commit");
  if (input.expectedAppElfSha256 !== undefined && !/^[0-9a-f]{64}$/u.test(input.expectedAppElfSha256)) throw serialFailure("elf_hash");
}
