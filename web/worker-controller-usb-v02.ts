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
  WORKER_CONTROLLER_V02_PROTOCOL_VERSION,
  parseWorkerLeaseGrantV02,
  parseWorkerLeaseRenewalV02,
  type WorkerLeaseGrantV02,
  type WorkerLeaseRenewalV02,
} from "./worker-controller-v02";

export { MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES };

/** Strict Controller 0.2 request carried only by the WebUSB control function. */
export type WorkerControllerUsbRequestV02 = WorkerControllerUsbRequestFor<
  typeof WORKER_CONTROLLER_V02_PROTOCOL_VERSION,
  WorkerLeaseGrantV02,
  WorkerLeaseRenewalV02
>;

/** Correlated Controller 0.2 response with normalized metadata-only errors. */
export type WorkerControllerUsbResponseV02 = WorkerControllerUsbResponseFor<
  typeof WORKER_CONTROLLER_V02_PROTOCOL_VERSION
>;

const controllerV02Codec = {
  protocolVersion: WORKER_CONTROLLER_V02_PROTOCOL_VERSION,
  label: "Worker Controller 0.2 USB",
  parseGrant: parseWorkerLeaseGrantV02,
  parseRenewal: parseWorkerLeaseRenewalV02,
};

/** Encodes one Controller 0.2 JSON frame for a WebUSB bulk transfer. */
export function encodeWorkerControllerUsbMessageV02(value: unknown): Uint8Array {
  return encodeWorkerControllerUsbMessage(value);
}

/** Parses one strict Controller 0.2 request from a control-only bulk transfer. */
export function decodeWorkerControllerUsbRequestV02(
  frame: Uint8Array,
): WorkerControllerUsbRequestV02 {
  return decodeWorkerControllerUsbRequestFor(frame, controllerV02Codec);
}

/** Parses one correlated Controller 0.2 response and replaces device-supplied error text. */
export function decodeWorkerControllerUsbResponseV02(
  frame: Uint8Array,
): WorkerControllerUsbResponseV02 {
  return decodeWorkerControllerUsbResponseFor(frame, controllerV02Codec);
}

/** Rejects a response that does not belong to the exact outstanding control request. */
export function assertWorkerControllerUsbCorrelationV02(
  request: WorkerControllerUsbRequestV02,
  response: WorkerControllerUsbResponseV02,
): void {
  assertWorkerControllerUsbCorrelationFor(request, response, controllerV02Codec);
}
