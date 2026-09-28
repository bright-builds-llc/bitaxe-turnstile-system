import type { WorkerSerialDiagnostic } from "./worker-serial-diagnostics";
import { sameRecord } from "./worker-preparation-diagnostics";

const prefix = "core_dump_store_receipt schema=v1";
const origins = ["current_boot", "previous_boot"];
const invalidStatuses = ["unavailable", "corrupt", "wrong_firmware", "wrong_boot"];
const stages = ["ready", "store_entered", "init_entered", "init_returned", "prepare_entered", "prepare_returned",
  "start_entered", "start_returned", "end_entered", "end_returned", "store_returned"];
const fields = ["source_hash", "boot_ordinal", "stage", "capacity_bytes", "requested_bytes", "prepared_bytes",
  "init_result", "prepare_result", "start_result", "end_result", "store_result", "self_test_marked"];
const results = new Set(["init_result", "prepare_result", "start_result", "end_result", "store_result"]);
const optionalBytes = new Set(["requested_bytes", "prepared_bytes"]);

/** A source fingerprint is not an authenticated image identity; all receipts are observations. */
export function maybeCoreDumpDiagnostic(line: string): WorkerSerialDiagnostic | undefined {
  if (line.length > 1024) return undefined;
  const tokens = line.split(" ");
  if (tokens[0] !== "core_dump_store_receipt" || tokens[1] !== "schema=v1" || tokens.at(-1) !== "redacted=true") return undefined;
  const maybeOrigin = tokens[2]?.slice("origin=".length), maybeStatus = tokens[3]?.slice("status=".length);
  if (!tokens[2]?.startsWith("origin=") || !maybeOrigin || !origins.includes(maybeOrigin) || !tokens[3]?.startsWith("status=") || !maybeStatus) return undefined;
  if (invalidStatuses.includes(maybeStatus)) return tokens.length === 5 ? Object.freeze({ category: "core_dump_store_receipt", authoritative: false, origin: maybeOrigin, status: maybeStatus }) : undefined;
  if (maybeStatus !== "valid" || tokens.length !== fields.length + 5) return undefined;
  const value: Record<string, string | number | boolean> = { category: "core_dump_store_receipt", authoritative: false, origin: maybeOrigin, status: maybeStatus };
  for (const [index, field] of fields.entries()) {
    const maybeToken = tokens[index + 4], marker = `${field}=`;
    if (!maybeToken?.startsWith(marker)) return undefined;
    const text = maybeToken.slice(marker.length);
    if (field === "source_hash") { if (!/^[a-f0-9]{16}$/u.test(text)) return undefined; value[field] = text; continue; }
    if (field === "boot_ordinal") {
      if (!/^(?:0|[1-9][0-9]{0,19})$/u.test(text) || BigInt(text) > 18446744073709551615n) return undefined;
      value[field] = text; continue;
    }
    if (field === "stage") { if (!stages.includes(text)) return undefined; value[field] = text; continue; }
    if (field === "self_test_marked") { if (text !== "true" && text !== "false") return undefined; value[field] = text === "true"; continue; }
    if (text === "unavailable" && (results.has(field) || optionalBytes.has(field))) { value[field] = text; continue; }
    const signed = results.has(field);
    if (!(signed ? /^(?:0|-?[1-9][0-9]{0,9})$/u : /^(?:0|[1-9][0-9]{0,9})$/u).test(text)) return undefined;
    const number = Number(text);
    if (!Number.isInteger(number) || number < (signed ? -2147483648 : 0) || number > (signed ? 2147483647 : 0xffffffff)) return undefined;
    value[field] = number;
  }
  return Object.freeze(value);
}

/** Reconstruct exactly the producer grammar and reject extra or incorrectly typed export fields. */
export function maybeCoreDumpExport(value: WorkerSerialDiagnostic): WorkerSerialDiagnostic | undefined {
  if (value.category !== "core_dump_store_receipt") return undefined;
  const suffix = value.status === "valid" ? ` ${fields.map(field => `${field}=${value[field]}`).join(" ")}` : "";
  const maybeParsed = maybeCoreDumpDiagnostic(`${prefix} origin=${value.origin} status=${value.status}${suffix} redacted=true`);
  return maybeParsed && sameRecord(value, maybeParsed) ? maybeParsed : undefined;
}

/** Current progress and previous crash records never share an identity key. */
export function coreDumpHistoryKey(value: WorkerSerialDiagnostic): string {
  return `${value.category}:${value.origin}:${value.source_hash ?? "none"}:${value.boot_ordinal ?? "none"}:${value.status}`;
}
