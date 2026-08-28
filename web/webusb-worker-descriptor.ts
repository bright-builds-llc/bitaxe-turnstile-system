import {
  parseWorkerUsbApplicationDescriptor,
  type WorkerUsbApplicationDescriptor,
} from "./worker-usb-profile";

/** Endpoint facts required for exact application descriptor admission. */
export type WorkerWebUsbEndpoint = {
  endpointNumber: number;
  direction: "in" | "out";
  type: "bulk" | "interrupt" | "isochronous";
};

/** Alternate-interface facts exposed by WebUSB. */
export type WorkerWebUsbAlternateInterface = {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  endpoints: readonly WorkerWebUsbEndpoint[];
};

/** One numbered WebUSB interface and its complete alternate set. */
export type WorkerWebUsbInterface = {
  interfaceNumber: number;
  alternates: readonly WorkerWebUsbAlternateInterface[];
};

/** One WebUSB configuration presented for strict topology admission. */
export type WorkerWebUsbConfiguration = {
  configurationValue: number;
  interfaces: readonly WorkerWebUsbInterface[];
};

/** Admits the shared exact vendor-control plus receive-only CDC evidence descriptor. */
export function admitWorkerWebUsbDescriptor(
  configurations: readonly WorkerWebUsbConfiguration[],
): WorkerUsbApplicationDescriptor {
  if (configurations.length !== 1) invalid();
  const configuration = configurations[0];
  if (!configuration || configuration.configurationValue !== 1) invalid();
  if (configuration.interfaces.length !== 3) invalid();

  const control = exactAlternate(configuration.interfaces, 0);
  const evidenceCommunication = exactAlternate(configuration.interfaces, 1);
  const evidenceData = exactAlternate(configuration.interfaces, 2);
  if (
    !alternateIs(control, 0, 255, 66, 1, [
      { endpointNumber: 1, direction: "out", type: "bulk" },
      { endpointNumber: 1, direction: "in", type: "bulk" },
    ]) ||
    !alternateIs(evidenceCommunication, 0, 2, 2, 1, [
      { endpointNumber: 2, direction: "in", type: "interrupt" },
    ]) ||
    !alternateIs(evidenceData, 0, 10, 0, 0, [
      { endpointNumber: 3, direction: "out", type: "bulk" },
      { endpointNumber: 3, direction: "in", type: "bulk" },
    ])
  ) {
    invalid();
  }

  return parseWorkerUsbApplicationDescriptor({
    configurationValue: 1,
    control: {
      interfaceNumber: 0,
      alternateSetting: 0,
      classCode: 255,
      subclassCode: 66,
      protocolCode: 1,
      endpointOut: 1,
      endpointIn: 1,
      transferType: "bulk",
    },
    evidence: {
      communicationInterfaceNumber: 1,
      dataInterfaceNumber: 2,
      notificationEndpointIn: 2,
      dataEndpointOut: 3,
      dataEndpointIn: 3,
      hostWritesAccepted: false,
    },
  });
}

function exactAlternate(
  interfaces: readonly WorkerWebUsbInterface[],
  interfaceNumber: number,
): WorkerWebUsbAlternateInterface {
  const matches = interfaces.filter((item) => item.interfaceNumber === interfaceNumber);
  const maybeInterface = matches[0];
  const maybeAlternate = maybeInterface?.alternates[0];
  if (matches.length !== 1 || maybeInterface?.alternates.length !== 1 || !maybeAlternate) invalid();
  return maybeAlternate;
}

function alternateIs(
  alternate: WorkerWebUsbAlternateInterface,
  setting: number,
  classCode: number,
  subclassCode: number,
  protocolCode: number,
  endpoints: readonly WorkerWebUsbEndpoint[],
): boolean {
  return (
    alternate.alternateSetting === setting &&
    alternate.interfaceClass === classCode &&
    alternate.interfaceSubclass === subclassCode &&
    alternate.interfaceProtocol === protocolCode &&
    endpointsMatch(alternate.endpoints, endpoints)
  );
}

function endpointsMatch(
  actual: readonly WorkerWebUsbEndpoint[],
  expected: readonly WorkerWebUsbEndpoint[],
): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((endpoint) =>
    actual.some((candidate) =>
      candidate.endpointNumber === endpoint.endpointNumber &&
      candidate.direction === endpoint.direction &&
      candidate.type === endpoint.type,
    ),
  );
}

function invalid(): never {
  throw new Error("Worker WebUSB application descriptor is invalid");
}
