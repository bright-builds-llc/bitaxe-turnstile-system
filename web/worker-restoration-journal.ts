/** Closed restoration-page events. Entries never carry authorization, challenge, lease, fingerprint or pool values. */
export const WORKER_RESTORATION_JOURNAL_EVENTS = [
  "configured", "admission_failed", "serial_failure", "connect_failed", "connected", "disconnected",
  "start_prepared", "lease_loaded", "lease_started", "lease_start_failed", "renewed", "renew_failed",
  "paused", "cancelled", "restored", "stop_failed", "device_baseline_observed",
  "stimulus_acknowledged", "stimulus_failed", "stimulus_reviewed", "rejection_reviewed", "status_reviewed", "review_failed",
  "replay_accepted", "replay_rejected", "replay_failed",
  "physical_window_begun", "physical_window_armed", "admission_observed",
  "device_identity_changed", "pool_configuration_changed",
  "status_failed", "closed", "close_failed", "completion_submitted", "completion_failed",
] as const;
export type WorkerRestorationJournalEvent = typeof WORKER_RESTORATION_JOURNAL_EVENTS[number];
export type WorkerRestorationJournalEntry = { ordinal: number; event: WorkerRestorationJournalEvent; category?: string };

const MAXIMUM_ENTRIES = 256;
const CATEGORY = /^[a-z][a-z0-9_]{0,63}$/u;

/** Bounded, ordered page journal; categories must already come from a closed vocabulary. */
export class WorkerRestorationJournal {
  readonly #entries: WorkerRestorationJournalEntry[] = [];
  #ordinal = 0;
  #dropped = 0;
  record(event: WorkerRestorationJournalEvent, maybeCategory?: string): void {
    if (maybeCategory !== undefined && !CATEGORY.test(maybeCategory)) throw new Error("journal_category_invalid");
    this.#ordinal += 1;
    this.#entries.push({ ordinal: this.#ordinal, event, ...(maybeCategory === undefined ? {} : { category: maybeCategory }) });
    if (this.#entries.length > MAXIMUM_ENTRIES) { this.#entries.shift(); this.#dropped += 1; }
  }
  values(): { entries: WorkerRestorationJournalEntry[]; dropped: number } {
    return { entries: this.#entries.map(entry => ({ ...entry })), dropped: this.#dropped };
  }
}
