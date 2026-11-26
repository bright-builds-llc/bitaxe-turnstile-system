/** Shows a standard Worker's lease settings in the page's `#stratum-settings` section, or hides it. */
import type { StandardWorkerSettings } from "./headless-standard-worker";

export function renderStandardWorkerSettings(
  section: HTMLElement,
  maybeSettings: StandardWorkerSettings | undefined,
): void {
  for (const field of ["endpoint", "username", "password"] as const) {
    const element = section.querySelector<HTMLElement>(`[data-field=${field}]`);
    if (!element) throw new Error(`the settings section has no ${field}`);
    element.textContent = maybeSettings?.[field] ?? "";
  }
  section.hidden = maybeSettings === undefined;
}
