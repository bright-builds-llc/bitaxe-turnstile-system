/**
 * The closed set of boards a Reference Firmware capability may state (ADR-0104).
 * Model and revision travel together; neither is free text.
 */
export const REFERENCE_FIRMWARE_BOARDS = [
  { model: "bitaxe-ultra", revision: "205" },
  { model: "bitaxe-gamma", revision: "601" },
] as const;

/** One admitted Reference Firmware board identity. */
export type ReferenceFirmwareBoard = (typeof REFERENCE_FIRMWARE_BOARDS)[number];

/** Returns the admitted board with exactly this model and revision. */
export function maybeReferenceFirmwareBoard(
  model: unknown,
  revision: unknown,
): ReferenceFirmwareBoard | undefined {
  return REFERENCE_FIRMWARE_BOARDS.find(
    (board) => board.model === model && board.revision === revision,
  );
}

/** Returns the admitted board named by its revision alone, such as `601`. */
export function maybeReferenceFirmwareBoardByRevision(
  revision: unknown,
): ReferenceFirmwareBoard | undefined {
  return REFERENCE_FIRMWARE_BOARDS.find((board) => board.revision === revision);
}
