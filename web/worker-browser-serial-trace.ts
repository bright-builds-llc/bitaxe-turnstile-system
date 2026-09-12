export const BROWSER_TRACE_CAPACITY = 256;
export const BROWSER_TRACE_STAGES = ["epoch_started", "chunk_received", "frame_assembled", "validation_started", "validation_completed", "validation_rejected", "frame_delivered", "frame_suppressed", "request_started", "request_formed", "request_consumed", "response_delivered", "close_started", "close_completed"] as const;
export type BrowserTraceStage = typeof BROWSER_TRACE_STAGES[number];
export type BrowserSerialTraceEvent = { ordinal: number; epoch: number; frameOrdinal: number; requestOrdinal: number; requestSequence: number; stage: BrowserTraceStage; atMs: number; wireBytes: number; queuedBytes: number };
export type BrowserSerialTrace = { schema: "worker-browser-serial-trace-v1"; capacity: 256; firstEventOrdinal: number; nextEventOrdinal: number; overwrittenEvents: number; events: BrowserSerialTraceEvent[] };
export type BrowserTraceBoundary = { epoch: number; requestOrdinal: number; requestSequence: number; nextEventOrdinal: number; receivedWireBytes: number; assembledFrames: number; validationPending: boolean };

/** Bounded metadata only: no frame objects, tokens, raw IDs, payloads or device identity. */
export class WorkerBrowserSerialTrace {
  readonly #events: BrowserSerialTraceEvent[] = [];
  #next = 1;
  #epoch = 0;
  constructor(readonly now: () => number) {}
  beginEpoch(): WorkerBrowserSerialTraceEpoch {
    const epoch = new WorkerBrowserSerialTraceEpoch(this, ++this.#epoch);
    epoch.record("epoch_started");
    return epoch;
  }
  append(epoch: number, requestOrdinal: number, frameOrdinal: number, requestSequence: number, stage: BrowserTraceStage, wireBytes: number, queuedBytes: number): void {
    if (this.#events.length === BROWSER_TRACE_CAPACITY) this.#events.shift();
    this.#events.push({ ordinal: this.#next++, epoch, requestOrdinal, frameOrdinal, requestSequence, stage, atMs: Math.max(0, Math.floor(this.now())), wireBytes, queuedBytes });
  }
  get nextEventOrdinal(): number { return this.#next; }
  snapshot(): BrowserSerialTrace {
    return { schema: "worker-browser-serial-trace-v1", capacity: BROWSER_TRACE_CAPACITY, firstEventOrdinal: this.#events[0]?.ordinal ?? this.#next, nextEventOrdinal: this.#next, overwrittenEvents: Math.max(0, this.#next - 1 - BROWSER_TRACE_CAPACITY), events: this.#events.map(event => ({ ...event })) };
  }
}

/** Epoch remains bound to its reader even if asynchronous validation finishes after close. */
export class WorkerBrowserSerialTraceEpoch {
  #requestOrdinal = 0;
  #requestSequence = 0;
  #receivedWireBytes = 0;
  #assembledFrames = 0;
  #validationPending = false;
  constructor(readonly history: WorkerBrowserSerialTrace, readonly epoch: number) {}
  request(ordinal: number): void { this.#requestOrdinal = ordinal; this.#requestSequence = 0; this.record("request_started"); }
  formedRequest(sequence: number): void { this.#requestSequence = sequence; this.record("request_formed"); }
  record(stage: BrowserTraceStage, wireBytes = 0, queuedBytes = 0, frameOrdinal = 0): void {
    if (stage === "chunk_received") this.#receivedWireBytes += wireBytes;
    if (stage === "frame_assembled") this.#assembledFrames += 1;
    if (stage === "validation_started") this.#validationPending = true;
    if (stage === "validation_completed" || stage === "validation_rejected" || stage === "close_completed") this.#validationPending = false;
    this.history.append(this.epoch, this.#requestOrdinal, frameOrdinal, this.#requestSequence, stage, wireBytes, queuedBytes);
  }
  boundary(): BrowserTraceBoundary {
    return { epoch: this.epoch, requestOrdinal: this.#requestOrdinal, requestSequence: this.#requestSequence, nextEventOrdinal: this.history.nextEventOrdinal, receivedWireBytes: this.#receivedWireBytes, assembledFrames: this.#assembledFrames, validationPending: this.#validationPending };
  }
}
