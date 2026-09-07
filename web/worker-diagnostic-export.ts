import { maybeValidatedDiagnostic, type WorkerSerialDiagnostic } from "./worker-serial-diagnostics";
export type WorkerDiagnosticExport = { schema: "worker-diagnostic-export-v1"; observations: WorkerSerialDiagnostic[] };
/** Validates the exact closed observation allowlist before any persistence boundary. */
export function parseWorkerDiagnosticExport(input: unknown): WorkerDiagnosticExport {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("diagnostic_export_invalid");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || value.schema !== "worker-diagnostic-export-v1" || !Array.isArray(value.observations) || value.observations.length > 40) throw new Error("diagnostic_export_invalid");
  const observations = value.observations.map(item => {
    const result = maybeValidatedDiagnostic(item);
    if (!result) throw new Error("diagnostic_export_invalid");
    return result;
  });
  return { schema: "worker-diagnostic-export-v1", observations };
}
