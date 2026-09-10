/** A cold baseline may need no restoration; this never substitutes for post-work restoration proof. */
export function workerDeviceBaselineConfirmed(maybeStatus: unknown): boolean {
  if (!maybeStatus || typeof maybeStatus !== "object" ||
    !("state" in maybeStatus) || maybeStatus.state !== "baseline" ||
    !("restoration" in maybeStatus)) return false;
  const maybeRestoration = maybeStatus.restoration;
  if (!maybeRestoration || typeof maybeRestoration !== "object" ||
    !("status" in maybeRestoration)) return false;
  return maybeRestoration.status === "confirmed" || maybeRestoration.status === "not_required";
}
