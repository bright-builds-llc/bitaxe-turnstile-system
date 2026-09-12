import { BROWSER_TRACE_STAGES, type BrowserSerialTrace } from "./worker-browser-serial-trace";
import { exactSerialRecord, serialFailure } from "./worker-serial";

export const DEVICE_TRACE_STAGES = ["hello", "validated", "validation_rejected", "enqueue_started", "enqueued", "enqueue_rejected", "dispatch_started", "dispatch_rejected", "reply_created", "reply_rejected", "writer_accepted", "writer_rejected", "writer_started", "writer_queued", "writer_completed", "writer_abandoned", "epoch_revoked"] as const;
export type DeviceSerialTraceWindow = {
  epoch: number; firstEventOrdinal: number; nextEventOrdinal: number; overwrittenEvents: number;
  events: { ordinal: number; epoch: number; requestSequence: number; stage: typeof DEVICE_TRACE_STAGES[number]; atMs: number; wireBytes: number; queuedBytes: number }[];
};
export type DeviceSerialTrace = { schema: "worker-serial-trace-v1"; capacity: 64; snapshotAvailable: boolean; droppedEvents: number; current: DeviceSerialTraceWindow; previous: DeviceSerialTraceWindow | null };
const numeric = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function ordinals(value: Record<string, unknown>, events: Record<string, unknown>[]): void {
  for (const key of ["firstEventOrdinal", "nextEventOrdinal", "overwrittenEvents"]) if (!numeric(value[key])) throw serialFailure("shape");
  let previous = Number(value.firstEventOrdinal) - 1;
  for (const event of events) {
    if (!numeric(event.ordinal) || event.ordinal !== previous + 1) throw serialFailure("shape");
    previous = event.ordinal;
  }
  if ((events[0]?.ordinal ?? value.nextEventOrdinal) !== value.firstEventOrdinal || (events.length && previous + 1 !== value.nextEventOrdinal)) throw serialFailure("shape");
}
function event(input: unknown, keys: readonly string[], stages: readonly string[]): Record<string, unknown> {
  const value = exactSerialRecord(input, keys);
  if (typeof value.stage !== "string" || !stages.includes(value.stage)) throw serialFailure("shape");
  for (const key of keys.filter(key => key !== "stage")) if (!numeric(value[key])) throw serialFailure("shape");
  return value;
}
/** Closed metadata export; unknown fields cannot smuggle payloads or identifiers. */
export function parseBrowserSerialTrace(input: unknown): BrowserSerialTrace {
  const value = exactSerialRecord(input, ["schema", "capacity", "firstEventOrdinal", "nextEventOrdinal", "overwrittenEvents", "events"]);
  if (value.schema !== "worker-browser-serial-trace-v1" || value.capacity !== 256 || !Array.isArray(value.events) || value.events.length > 256) throw serialFailure("shape");
  const events = value.events.map(item => event(item, ["ordinal", "epoch", "frameOrdinal", "requestOrdinal", "requestSequence", "stage", "atMs", "wireBytes", "queuedBytes"], BROWSER_TRACE_STAGES));
  for (const event of events) for (const key of ["epoch", "frameOrdinal", "requestOrdinal", "requestSequence", "wireBytes", "queuedBytes"]) if (Number(event[key]) > 0xffff_ffff) throw serialFailure("shape");
  ordinals(value, events);
  if (!Number(value.firstEventOrdinal) || !Number(value.nextEventOrdinal)) throw serialFailure("shape");
  return structuredClone(value) as BrowserSerialTrace;
}
/** Device traces describe writer acceptance and queue observations, never browser receipt. */
export function parseDeviceSerialTrace(input: unknown): DeviceSerialTrace {
  const value = exactSerialRecord(input, ["schema", "capacity", "snapshotAvailable", "droppedEvents", "current", "previous"]);
  if (value.schema !== "worker-serial-trace-v1" || value.capacity !== 64 || typeof value.snapshotAvailable !== "boolean" || !numeric(value.droppedEvents)) throw serialFailure("shape");
  const current = deviceWindow(value.current, value.snapshotAvailable);
  const maybePrevious = value.previous === null ? null : deviceWindow(value.previous, value.snapshotAvailable);
  if (maybePrevious && Number(maybePrevious.epoch) >= Number(current.epoch)) throw serialFailure("shape");
  if (!value.snapshotAvailable && (value.previous !== null || current.epoch !== 0)) throw serialFailure("shape");
  return structuredClone(value) as DeviceSerialTrace;
}

function deviceWindow(input: unknown, available: boolean): Record<string, unknown> {
  const value = exactSerialRecord(input, ["epoch", "firstEventOrdinal", "nextEventOrdinal", "overwrittenEvents", "events"]);
  if (!numeric(value.epoch) || !Array.isArray(value.events) || value.events.length > 64) throw serialFailure("shape");
  const events = value.events.map(item => event(item, ["ordinal", "epoch", "requestSequence", "stage", "atMs", "wireBytes", "queuedBytes"], DEVICE_TRACE_STAGES));
  ordinals(value, events);
  if (events.some(event => event.epoch !== value.epoch)) throw serialFailure("shape");
  if (!available && (events.length || value.firstEventOrdinal !== 0 || value.nextEventOrdinal !== 0 || value.overwrittenEvents !== 0)) throw serialFailure("shape");
  if (available && (!Number(value.firstEventOrdinal) || !Number(value.nextEventOrdinal))) throw serialFailure("shape");
  return value;
}
