import { exactSerialRecord } from "./worker-serial";
import { noiseAuthorityKey, noisePrivateIpv4, noisePort } from "./worker-noise-diagnostic-values";

export const WORKER_V2_STANDARD_PROFILE = "bwg-worker-stratum-v2-standard/0.1" as const;
/** Private signed runtime input. Never place this value in diagnostics or persisted status. */
export type WorkerV2Stratum = {
  profile: typeof WORKER_V2_STANDARD_PROFILE;
  endpoint: string; authorityPublicKey: string; userIdentity: string;
};
export function isWorkerV2Stratum(input: object): input is WorkerV2Stratum { return Object.hasOwn(input, "profile"); }
/** No URL normalization, credential fields, DNS, or legacy fallback. */
export function parseWorkerV2Stratum(input: unknown): WorkerV2Stratum {
  const value = exactSerialRecord(input, ["profile", "endpoint", "authorityPublicKey", "userIdentity"]);
  if (value.profile !== WORKER_V2_STANDARD_PROFILE || typeof value.endpoint !== "string" || typeof value.userIdentity !== "string") throw new Error("v2_stratum_invalid");
  const maybeMatch = /^stratum\+tcp:\/\/([^/:]+):([1-9][0-9]{0,4})\/$/u.exec(value.endpoint);
  if (!maybeMatch) throw new Error("v2_endpoint_invalid");
  noisePrivateIpv4(maybeMatch[1]); noisePort(Number(maybeMatch[2]));
  const bytes = new TextEncoder().encode(value.userIdentity);
  if (value.userIdentity.includes("\0") || bytes.length < 1 || bytes.length > 255 || new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value.userIdentity) throw new Error("v2_user_identity_invalid");
  return { profile: WORKER_V2_STANDARD_PROFILE, endpoint: value.endpoint, authorityPublicKey: noiseAuthorityKey(value.authorityPublicKey), userIdentity: value.userIdentity };
}
