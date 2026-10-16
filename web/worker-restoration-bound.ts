/**
 * Bounds on the device restoring its Mining Baseline after a Work Lease window. Firmware ADR-0037
 * (decision 5, amended) makes a lease budget pure mining time: the work gate closes at the budget, and the
 * ordered shutdown runs after it, outside the budget, so every restoration deadline adds the shutdown bound.
 */

/**
 * The firmware's bound on the ordered pre-reset shutdown: the closed tail at the 575 MHz catalog maximum
 * (firmware ADR-0037). It replaces the 15,550 ms Conservative and 19,050 ms upstream-default tails, which
 * the budget used to contain. Firmware status reports it as `shutdown_budget_ms`.
 */
export const WORKER_SHUTDOWN_BOUND_MILLISECONDS = 22_550;
/** Revocation and expiry start the ordered shutdown within three seconds. */
export const WORKER_SHUTDOWN_INITIATION_MILLISECONDS = 3_000;
/** The device's cooling proof after the shutdown lasts at most 120 seconds. */
export const WORKER_COOLING_PROOF_MILLISECONDS = 120_000;
/** Initiation, ordered shutdown and cooling: the device-side terminal sequence after the work window. */
export const WORKER_TERMINAL_SEQUENCE_MILLISECONDS =
  WORKER_SHUTDOWN_INITIATION_MILLISECONDS + WORKER_SHUTDOWN_BOUND_MILLISECONDS + WORKER_COOLING_PROOF_MILLISECONDS;
/** Serial transport margin, unchanged from the former 145-second bound over its 138,550 ms sequence. */
export const WORKER_RESTORATION_TRANSPORT_ALLOWANCE_MILLISECONDS = 6_450;
/** Outer response deadline for a graceful Pause, Cancel, Restore or cooling command. */
export const WORKER_RESTORATION_RESPONSE_MILLISECONDS =
  WORKER_TERMINAL_SEQUENCE_MILLISECONDS + WORKER_RESTORATION_TRANSPORT_ALLOWANCE_MILLISECONDS;
