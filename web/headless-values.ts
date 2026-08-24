import type { WorkerDisclosure, WorkConsentDisclosure } from "./headless-client.types";

export function estimateWork(
  expectedHashes: bigint,
  workers: readonly WorkerDisclosure[],
): Pick<WorkConsentDisclosure, "maybeDurationSeconds" | "maybeEnergyWattHours"> {
  let totalHashrate = 0n;
  for (const worker of workers) {
    totalHashrate += canonicalSafePositiveBigInt(worker.hashrateHs, "Worker hashrate");
    if (totalHashrate > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("combined Worker hashrate exceeds the display range");
    }
  }
  if (totalHashrate === 0n) return {};
  const maybeDurationSeconds = Number(expectedHashes) / Number(totalHashrate);
  const maybePowers = workers.map((worker) => worker.maybePowerWatts);
  if (maybePowers.some((maybePower) => maybePower === undefined)) {
    return { maybeDurationSeconds };
  }
  const totalWatts = maybePowers.reduce<number>((sum, maybePower) => {
    if (!Number.isFinite(maybePower) || maybePower === undefined || maybePower <= 0) {
      throw new TypeError("Worker power must be a positive finite number");
    }
    return sum + maybePower;
  }, 0);
  return {
    maybeDurationSeconds,
    maybeEnergyWattHours: (totalWatts * maybeDurationSeconds) / 3_600,
  };
}

export function canonicalSafePositiveBigInt(value: string, name: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError(`${name} must be a canonical positive integer`);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} exceeds the supported display range`);
  }
  return parsed;
}

export function canonicalNonNegativeBigInt(value: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical non-negative integer`);
  }
  return BigInt(value);
}

export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
