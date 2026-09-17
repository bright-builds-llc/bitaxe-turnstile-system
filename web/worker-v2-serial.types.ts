import type { WorkerV2Stratum as V2Stratum } from "./worker-v2-stratum";

type UInt = number; type Nonce16 = string; type Digest = string; type PrivateIpv4 = string; type Port = number;

export type ChannelStart = {
  schema: "worker-stratum-v2-channel-start-v1";
  attemptId: Nonce16; expectedBootOrdinal: UInt;
  networkObservedAtUs: UInt; stratum: V2Stratum;
};

export type V2Query = {
  schema: "worker-stratum-v2-query-v1"; scope: "channel" | "share";
  attemptId: Nonce16 | null;
};

export type ChannelCancel = {
  schema: "worker-stratum-v2-channel-cancel-v1"; attemptId: Nonce16;
};

export type SocketTuple = { localIpv4: PrivateIpv4; localPort: Port; remoteIpv4: PrivateIpv4; remotePort: Port };

export type CurrentObservation = {
  bootOrdinal: UInt; workerGeneration: UInt; serialTransportEpoch: UInt;
  observedAtUs: UInt | null; clockValid: boolean;
  stationIpv4: PrivateIpv4 | null; wifiConnected: boolean; socket: SocketTuple | null;
};

export type RetainedConnection = {
  observedAtUs: UInt; bootOrdinal: UInt; workerGeneration: UInt;
  serialTransportEpoch: UInt; poolSessionGeneration: UInt;
  poolTransportEpoch: UInt; socket: SocketTuple;
};

export type V2Status = {
  schema: "worker-stratum-v2-status-v1"; scope: "channel" | "share";
  state: "idle" | "admitted" | "running" | "terminal";
  observation: CurrentObservation; connection: RetainedConnection | null;
  record: DeviceRecord | null;
};

export type Event = {
  sequence: UInt; atDeviceUs: UInt | null; kind: Stage;
  channelId: UInt | null; jobId: UInt | null;
  submissionSequence: UInt | null; payloadSha256: Digest | null;
};

export type Timing = {
  operation: Operation; count: UInt; failedCount: UInt;
  maxDurationUs: UInt | null; totalDurationUs: UInt | null;
  firstStartedAtDeviceUs: UInt | null; lastFinishedAtDeviceUs: UInt | null;
  inFlightStartedAtDeviceUs: UInt | null;
};

export type ShareFact = {
  dispatchSequence: UInt; asicJobId: UInt; workFieldsSha256: Digest;
  dispatchedAtDeviceUs: UInt; nonceAtDeviceUs: UInt;
  writeStartedAtDeviceUs: UInt | null; writeCompletedAtDeviceUs: UInt | null;
  nonce: UInt; versionBits: UInt; asicIndex: UInt; coreId: UInt; smallCoreId: UInt;
  channelId: UInt; jobId: UInt; submissionSequence: UInt; ntime: UInt; version: UInt;
  ackAtDeviceUs: UInt | null; ackLastSequence: UInt | null;
  ackAcceptedCount: UInt | null; ackSharesSum: UInt | null; matchedSubmitCount: UInt | null;
};

export type DeviceRecord = {
  schema: "worker-v2-serial-evidence-v1"; scope: "channel" | "share";
  attemptId: Nonce16; bootOrdinal: UInt; workerGeneration: UInt;
  poolSessionGeneration: UInt | null; poolTransportEpoch: UInt | null;
  serialTransportEpoch: UInt;
  jobCommitment: Digest | null;
  observedAtUs: UInt | null; state: "admitted" | "running" | "terminal";
  admittedAtDeviceUs: UInt; authorityDeadlineDeviceUs: UInt | null;
  observationDeadlineDeviceUs: UInt | null; terminalAtDeviceUs: UInt | null;
  outcome: "accepted" | "rejected" | "expired" | "cancelled" | "incomplete" | null;
  events: Event[]; timings: Timing[]; shareFacts: ShareFact[];
  firstFailure: Failure | null;
  secondaryFailures: Failure[]; resources: Resources;
};

export type Failure = { stage: Stage; category: FailureCategory; atDeviceUs: UInt | null };

export type Resources = {
  socketClosed: boolean; workerQuiescent: boolean; fenceRetained: boolean;
  socketClosedAtUs: UInt | null; workerQuiescentAtUs: UInt | null;
};

export const V2_STAGES = ["admitted", "preparing", "connected", "authenticated", "setup", "channel", "job", "target", "work_ready", "socket_closed", "worker_quiescent", "asic_dispatch", "nonce", "submission", "accepted", "revoked", "shutdown", "cooled"] as const;
export type Stage = typeof V2_STAGES[number];
export const V2_OPERATIONS = ["initiator_construction", "act_one_construction", "connect", "act_one_write", "act_two_read", "act_two_authentication", "frame_encrypt", "frame_write", "frame_read", "header_decrypt", "payload_decrypt", "socket_close", "worker_join"] as const;
export type Operation = typeof V2_OPERATIONS[number];
export const V2_FAILURES = ["admission", "clock", "allocation", "authority", "timeout", "eof", "extra", "authentication", "protocol", "channel_mismatch", "job_mismatch", "invalid_nonce", "rejected_share", "safety", "cleanup", "evidence"] as const;
export type FailureCategory = typeof V2_FAILURES[number];
export type V2Scope = "channel" | "share";
