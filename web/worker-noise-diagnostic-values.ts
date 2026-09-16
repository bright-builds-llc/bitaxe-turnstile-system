import { serialFailure, serialToken, serialNonce } from "./worker-serial";

export function noiseUInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw serialFailure("noise_integer");
  return value;
}
export function noisePositive(value: unknown): number {
  const parsed = noiseUInt(value);
  if (parsed === 0) throw serialFailure("noise_positive");
  return parsed;
}
export function noisePort(value: unknown): number {
  const parsed = noisePositive(value);
  if (parsed > 65535) throw serialFailure("noise_port");
  return parsed;
}
export function maybeNoiseUInt(value: unknown): number | null { return value === null ? null : noiseUInt(value); }
export function noiseBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw serialFailure("noise_boolean");
  return value;
}
export function noiseEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  const maybeValue = allowed.find(candidate => candidate === value);
  if (maybeValue === undefined) throw serialFailure("noise_enum");
  return maybeValue;
}
export function noiseAttemptId(value: unknown): string {
  if (!serialToken(value)) throw serialFailure("noise_attempt");
  return value;
}
export function noiseAuthorityKey(value: unknown): string {
  if (!serialNonce(value)) throw serialFailure("noise_authority");
  return value;
}
export function noiseDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw serialFailure("noise_digest");
  return value;
}
/** Literal RFC1918 unicast only; no resolver, URL, legacy numeric forms or local fallback. */
export function noisePrivateIpv4(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/u.test(value)) throw serialFailure("noise_ipv4");
  const octets = value.split(".").map(Number);
  const [a, b] = octets;
  if (octets.some(octet => octet > 255) || !((a === 10) || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168))) throw serialFailure("noise_ipv4");
  return value;
}
