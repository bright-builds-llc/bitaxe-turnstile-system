import { maybeValidatedDiagnostic, maybeWorkerSerialDiagnostic, type WorkerSerialDiagnostic } from "./worker-serial-diagnostics";
import { serialFailure } from "./worker-serial";
import { parseQualificationRestartAck, type WorkerQualificationRestartAck, type WorkerQualificationRestartRequest } from "./worker-qualification-restart";

export type WorkerRestartSummary = {
  schema: "worker-qualification-restart-observation-v1"; stage: "armed" | "acknowledged" | "reacquiring" | "complete" | "failed";
  ackMatched: boolean; expectedBootOrdinal: number; nextBootOrdinal: number; bootObserved: boolean; runtimeReadyObserved: boolean;
  softwareResetObserved: boolean; identityObserved: boolean; identityMatched: boolean; records: number; bytes: number; durationMs: number; portReopens: 0 | 1; streamInterrupted: boolean;
  continuity: "uninterrupted" | "interrupted" | "same_port_reopened";
};
export type WorkerRestartEvidence = { summary: WorkerRestartSummary; ack: (Omit<WorkerQualificationRestartAck, "requestNonce"> & { requestNonceSha256: string }) | null;
  observations: { record: number; atMs: number; diagnostic: WorkerSerialDiagnostic }[];
  lifecycle: { record: number; atMs: number; event: "prearmed" | "acknowledged" | "stream_interrupted" | "same_port_reopened" | "hello_started" | "complete" | "failed" }[];
};
/** One bounded metadata observer; it cannot establish an application session. */
export class WorkerSerialRestartObserver {
  readonly startedAt: number;
  ready: Promise<void>;
  readonly failure: Promise<Error>;
  #resolveFailure!: (error: Error) => void;
  #lastElapsed = 0;
  #maybeFinishedElapsed: number | undefined;
  #resolveReady!: () => void;
  #maybeAck: WorkerQualificationRestartAck | undefined;
  #maybeNonceDigest: string | undefined;
  #maybeError: Error | undefined;
  #stage: WorkerRestartSummary["stage"] = "armed";
  #admitted = false;
  #statisticsRequired = false; #statisticsActive = false;
  #boot = false; #identity = false; #readySamples = 0; #maybeReadyUptime: number | undefined;
  #records = 0; #bytes = 0; #reopens: 0 | 1 = 0; #interrupted = false; #bootMode = false;
  #observations: WorkerRestartEvidence["observations"] = [];
  #lifecycle: WorkerRestartEvidence["lifecycle"] = [];
  #maybeStreamEnd: (() => void) | undefined;
  #streamEnd: Promise<void>;
  constructor(readonly request: WorkerQualificationRestartRequest, readonly identity: { firmwareSourceCommit: string; appElfSha256: string }, readonly now: () => number, maybeNonceDigest?: string) {
    this.startedAt = now();
    if (maybeNonceDigest !== undefined) this.setNonceDigest(maybeNonceDigest);
    if (!Number.isFinite(this.startedAt) || this.startedAt < 0) throw serialFailure("restart_clock");
    this.ready = new Promise(resolve => { this.#resolveReady = resolve; });
    this.failure = new Promise(resolve => { this.#resolveFailure = resolve; });
    this.#streamEnd = new Promise(resolve => { this.#maybeStreamEnd = resolve; });
    this.event("prearmed");
  }
  setNonceDigest(value: string) { if (this.#maybeNonceDigest !== undefined || !/^[0-9a-f]{64}$/u.test(value)) throw serialFailure("restart_request"); this.#maybeNonceDigest = value; }
  private nonceDigest(): string { if (!this.#maybeNonceDigest) throw serialFailure("restart_incomplete"); return this.#maybeNonceDigest; }
  get ackMatched() { return this.#maybeAck !== undefined; }
  get bootMode() { return this.#bootMode; }
  get active() { return !["complete", "failed"].includes(this.#stage); }
  get streamEnd() { return this.#streamEnd; }
  get needsReopen() { return this.#interrupted && this.#reopens === 0; }
  get interruptionError() { return this.#interruptionError; }
  readonly #interruptionError = serialFailure("restart_stream_interrupted");
  elapsed() { const elapsed = this.now() - this.startedAt; if (!Number.isFinite(elapsed) || elapsed < this.#lastElapsed) throw serialFailure("restart_clock"); this.#lastElapsed = Math.floor(elapsed); return this.#lastElapsed; }
  remaining() { this.check(); const left = 30000 - this.elapsed(); if (left <= 0) throw serialFailure("timeout"); return left; }
  check() { if (this.#maybeError) throw this.#maybeError; }
  event(event: WorkerRestartEvidence["lifecycle"][number]["event"]) { this.#lifecycle.push({ record: this.#records, atMs: this.#maybeFinishedElapsed ?? (this.#maybeError ? this.#lastElapsed : this.elapsed()), event }); }
  bytesReceived(count: number) {
    if (!this.active) return;
    this.remaining();
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(this.#bytes + count)) throw serialFailure("wire_bound");
    this.#bytes += count;
    if (this.#bytes > 262144) throw serialFailure("wire_bound");
  }
  byte(byte: number) {
    if (!this.active) return;
    this.remaining();
    if (byte === 10) this.#records++;
    if (this.#records > 512) throw serialFailure("wire_bound");
  }
  acknowledge(input: unknown) {
    if (this.#maybeAck || !this.#maybeNonceDigest || this.#stage !== "armed") throw serialFailure("restart_ack");
    this.#maybeAck = parseQualificationRestartAck(input, this.request);
    this.#stage = "acknowledged"; this.#bootMode = true; this.event("acknowledged");
  }
  rawRecord(bytes: Uint8Array) {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return; }
    const maybeDiagnostic = maybeWorkerSerialDiagnostic(text);
    if (maybeDiagnostic) this.diagnostic(maybeDiagnostic);
  }
  diagnostic(input: WorkerSerialDiagnostic) {
    if (!this.active) return;
    const value = maybeValidatedDiagnostic(input); if (!value) throw serialFailure("restart_diagnostic");
    this.remaining();
    if (this.#observations.length >= 512) throw serialFailure("wire_bound");
    this.#observations.push({ record: this.#records, atMs: this.elapsed(), diagnostic: structuredClone(value) });
    if (!this.ackMatched) return;
    if (value.category === "boot") {
      if (value.boot_ordinal === this.request.expectedBootOrdinal && !this.#boot) return;
      if (value.boot_ordinal !== this.request.expectedBootOrdinal + 1 || value.reset_reason !== "software_cpu") throw serialFailure("restart_boot");
      if (!this.#boot) { this.#readySamples = 0; this.#maybeReadyUptime = undefined; this.#statisticsActive = false; }
      this.#boot = true;
    }
    if (value.category === "runtime_identity") {
      if (value.firmware_commit !== this.identity.firmwareSourceCommit || value.app_elf_sha256 !== this.identity.appElfSha256) throw serialFailure("restart_identity");
      this.#identity = true;
    }
    if (value.category === "statistics_startup") {
      if (["spawn_failed", "config_failed", "cancelled"].includes(String(value.state))) {
        const error = serialFailure("restart_statistics_startup"); this.fail(error); throw error;
      }
      if (value.state === "prepared") { this.#statisticsRequired = true; this.#statisticsActive = false; }
      if (this.#boot && value.state === "active") this.#statisticsActive = true;
    }
    if (value.category === "startup") {
      if (value.first_failure !== "none" || value.state === "failed") throw serialFailure("restart_startup");
      if (this.#boot && value.stage === "runtime_ready" && value.state === "complete" && typeof value.uptime_ms === "number") {
        if (this.#maybeReadyUptime !== undefined && value.uptime_ms < this.#maybeReadyUptime) throw serialFailure("restart_startup_clock");
        if (this.#maybeReadyUptime === undefined || value.uptime_ms > this.#maybeReadyUptime) this.#readySamples++;
        this.#maybeReadyUptime = value.uptime_ms;
      }
    }
    if (this.#boot && this.#identity && this.#readySamples >= 2 && this.statisticsReady()) this.#resolveReady();
  }
  interrupted() {
    if (!this.ackMatched || !this.active || this.#reopens) throw serialFailure("restart_stream_interrupted");
    this.#interrupted = true; this.event("stream_interrupted"); this.#maybeStreamEnd?.(); this.#maybeStreamEnd = undefined;
  }
  requireReopen() { this.remaining(); if (!this.active || !this.#interrupted || this.#reopens) throw serialFailure("restart_reopen"); }
  reopened() {
    this.requireReopen();
    this.#reopens = 1; this.#bootMode = true; this.#stage = "acknowledged";
    this.#boot = false; this.#identity = false; this.#admitted = false; this.#statisticsActive = false; this.#readySamples = 0; this.#maybeReadyUptime = undefined;
    this.ready = new Promise(resolve => { this.#resolveReady = resolve; }); this.event("same_port_reopened");
    this.#streamEnd = new Promise(resolve => { this.#maybeStreamEnd = resolve; });
  }
  private statisticsReady() { return !this.#statisticsRequired || this.#statisticsActive; }
  helloStarted() { this.remaining(); if (!this.statisticsReady()) throw serialFailure("restart_incomplete"); this.#bootMode = false; this.#stage = "reacquiring"; this.event("hello_started"); }
  admitted() { this.check(); this.#admitted = true; }
  complete(): WorkerRestartEvidence {
    this.check(); if (!this.#maybeAck || !this.#boot || !this.#identity || !this.#admitted || this.#readySamples < 2 || !this.statisticsReady()) throw serialFailure("restart_incomplete");
    this.remaining(); this.#maybeFinishedElapsed = this.elapsed(); this.#stage = "complete"; this.event("complete");
    return this.evidence();
  }
  evidence(): WorkerRestartEvidence { return { summary: this.summary(), ack: this.#maybeAck ? { schema: this.#maybeAck.schema, requestNonceSha256: this.nonceDigest(), bootOrdinal: this.#maybeAck.bootOrdinal, nextBootOrdinal: this.#maybeAck.nextBootOrdinal } : null, observations: structuredClone(this.#observations), lifecycle: structuredClone(this.#lifecycle) }; }
  fail(error: Error) {
    if (this.#maybeError) return;
    const elapsed = this.now() - this.startedAt;
    if (Number.isFinite(elapsed) && elapsed >= this.#lastElapsed) this.#lastElapsed = Math.floor(elapsed);
    this.#maybeFinishedElapsed = this.#lastElapsed; this.#maybeError = error; this.#stage = "failed"; this.event("failed"); this.#resolveFailure(error);
  }
  summary(): WorkerRestartSummary {
    return { schema: "worker-qualification-restart-observation-v1", stage: this.#stage, ackMatched: this.ackMatched,
      expectedBootOrdinal: this.request.expectedBootOrdinal, nextBootOrdinal: this.request.expectedBootOrdinal + 1,
      bootObserved: this.#boot, softwareResetObserved: this.#boot, identityMatched: this.#admitted, identityObserved: this.#identity, runtimeReadyObserved: this.#readySamples >= 2,
      records: this.#records, bytes: this.#bytes, durationMs: this.#maybeFinishedElapsed ?? this.elapsed(), portReopens: this.#reopens,
      streamInterrupted: this.#interrupted, continuity: this.#reopens ? "same_port_reopened" : this.#interrupted ? "interrupted" : "uninterrupted" };
  }
}
