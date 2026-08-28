import {
  MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES,
  assertWorkerControllerUsbCorrelationFor,
  decodeWorkerControllerUsbRequestFor,
  decodeWorkerControllerUsbResponseFor,
  encodeWorkerControllerUsbMessage,
  type WorkerControllerUsbRequestFor,
  type WorkerControllerUsbResponseFor,
} from "./worker-controller-usb-codec";
import {
  WORKER_CONTROLLER_V03_PROTOCOL_VERSION,
  parseWorkerLeaseGrantV03,
  parseWorkerLeaseRenewalV03,
  type WorkerLeaseGrantV03,
  type WorkerLeaseRenewalV03,
} from "./worker-controller-v03";

export { MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES };

/** Strict Controller 0.3 request carried only by the WebUSB control function. */
export type WorkerControllerUsbRequestV03 = WorkerControllerUsbRequestFor<
  typeof WORKER_CONTROLLER_V03_PROTOCOL_VERSION,
  WorkerLeaseGrantV03,
  WorkerLeaseRenewalV03
>;

/** Correlated Controller 0.3 response with normalized metadata-only errors. */
export type WorkerControllerUsbResponseV03 = WorkerControllerUsbResponseFor<
  typeof WORKER_CONTROLLER_V03_PROTOCOL_VERSION
>;

const controllerV03Codec = {
  protocolVersion: WORKER_CONTROLLER_V03_PROTOCOL_VERSION,
  label: "Worker Controller 0.3 USB",
  parseGrant: parseWorkerLeaseGrantV03,
  parseRenewal: parseWorkerLeaseRenewalV03,
};

/** Encodes one Controller 0.3 JSON frame for a WebUSB bulk transfer. */
export function encodeWorkerControllerUsbMessageV03(value: unknown): Uint8Array {
  return encodeWorkerControllerUsbMessage(value);
}

/** Parses one strict Controller 0.3 request from a control-only bulk transfer. */
export function decodeWorkerControllerUsbRequestV03(
  frame: Uint8Array,
): WorkerControllerUsbRequestV03 {
  return decodeWorkerControllerUsbRequestFor(frame, controllerV03Codec);
}

/** Parses one correlated Controller 0.3 response and replaces device-supplied error text. */
export function decodeWorkerControllerUsbResponseV03(
  frame: Uint8Array,
): WorkerControllerUsbResponseV03 {
  return decodeWorkerControllerUsbResponseFor(frame, controllerV03Codec);
}

/** Rejects a response that does not belong to the exact outstanding control request. */
export function assertWorkerControllerUsbCorrelationV03(
  request: WorkerControllerUsbRequestV03,
  response: WorkerControllerUsbResponseV03,
): void {
  assertWorkerControllerUsbCorrelationFor(request, response, controllerV03Codec);
}
