import { exactSerialRecord, serialFailure, serialToken } from "./worker-serial";

export type WorkerQualificationRestartRequest = { requestNonce: string; expectedBootOrdinal: number };
export type WorkerQualificationRestartAck = { schema: "worker-qualification-restart-v1"; requestNonce: string; bootOrdinal: number; nextBootOrdinal: number };
export function parseQualificationRestartRequest(input: unknown): WorkerQualificationRestartRequest {
  const value = exactSerialRecord(input, ["requestNonce", "expectedBootOrdinal"]);
  if (!serialToken(value.requestNonce) || !Number.isSafeInteger(value.expectedBootOrdinal) || Number(value.expectedBootOrdinal) < 1 || Number(value.expectedBootOrdinal) >= Number.MAX_SAFE_INTEGER) throw serialFailure("restart_request");
  return { requestNonce: value.requestNonce, expectedBootOrdinal: Number(value.expectedBootOrdinal) };
}
export function parseQualificationRestartAck(input: unknown, expected: WorkerQualificationRestartRequest): WorkerQualificationRestartAck {
  const value = exactSerialRecord(input, ["schema", "requestNonce", "bootOrdinal", "nextBootOrdinal"]);
  if (value.schema !== "worker-qualification-restart-v1" || value.requestNonce !== expected.requestNonce || value.bootOrdinal !== expected.expectedBootOrdinal || value.nextBootOrdinal !== expected.expectedBootOrdinal + 1) throw serialFailure("restart_ack");
  return { schema: value.schema, requestNonce: expected.requestNonce, bootOrdinal: expected.expectedBootOrdinal, nextBootOrdinal: expected.expectedBootOrdinal + 1 };
}

/** Correlation evidence hashes the canonical nonce text, never a possession proof. */
export async function qualificationRestartNonceDigest(nonce: string): Promise<string> {
  if (!serialToken(nonce)) throw serialFailure("restart_request");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
