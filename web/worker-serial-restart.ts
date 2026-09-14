import { boundedSerial, observeSerialOutcome, type WorkerSerialBrowserRuntime } from "./webserial-worker-port";
import { parseWorkerControlResult } from "./worker-control-rejection";
import { parseQualificationRestartRequest, qualificationRestartNonceDigest, type WorkerQualificationRestartRequest } from "./worker-qualification-restart";
import { WorkerSerialRestartObserver, type WorkerRestartEvidence } from "./worker-serial-restart-observer";
import { serialFailure, serialFailureFor } from "./worker-serial";
import type { Ack } from "./worker-serial-controller.types";

/** One consumed qualification request, followed only by observation and fresh admission. */
export class WorkerSerialRestart {
  #consumed = false;
  #maybePriorAck: Ack | undefined;
  #awaitingAck = false;
  #maybeObserver: WorkerSerialRestartObserver | undefined;
  #maybeAcknowledged: (() => void) | undefined;
  get active() { return this.#maybeObserver?.active === true; }
  get observer() { return this.#maybeObserver; }
  evidence() { return this.#maybeObserver?.evidence(); }
  acceptResponse(response: unknown) {
    if (!this.#awaitingAck) return;
    this.#maybeObserver?.acknowledge(parseWorkerControlResult(response));
    this.#awaitingAck = false; this.#maybeAcknowledged?.();
  }
  freshAck(ack: Ack) {
    const observer = this.#maybeObserver;
    if (observer?.active && observer.ackMatched && (ack.sessionId === this.#maybePriorAck?.sessionId || ack.deviceNonce === this.#maybePriorAck?.deviceNonce || ack.firmwareSourceCommit !== observer.identity.firmwareSourceCommit || ack.appElfSha256 !== observer.identity.appElfSha256)) throw serialFailure("restart_identity");
  }
  fail(error: Error) { if (this.#maybeObserver?.active) this.#maybeObserver.fail(error); }
  async run(input: WorkerQualificationRestartRequest, operations: {
    ready(): void; identity(): Ack;
    now(): number; maybeAfter: WorkerSerialBrowserRuntime["maybeAfter"];
    prearm(observer: WorkerSerialRestartObserver): void; prepare(): Promise<void>;
    freezeWrites(): Promise<void>; request(value: WorkerQualificationRestartRequest): Promise<unknown>;
    acknowledged(): void; reopen(observer: WorkerSerialRestartObserver): Promise<void>;
    fresh(observer: WorkerSerialRestartObserver): Promise<void>; finish(): void; cleanup(): Promise<void>;
  }): Promise<WorkerRestartEvidence> {
    const request = parseQualificationRestartRequest(input); operations.ready();
    if (this.#consumed) throw serialFailure("restart_consumed"); this.#consumed = true;
    const prior = operations.identity(); this.#maybePriorAck = prior;
    const observer = new WorkerSerialRestartObserver(request, { firmwareSourceCommit: prior.firmwareSourceCommit, appElfSha256: prior.appElfSha256 }, operations.now);
    this.#maybeObserver = observer; this.#maybeAcknowledged = operations.acknowledged;
    const limit = <T>(operation: () => Promise<T>) => {
      const remaining = observer.remaining();
      return boundedSerial(Promise.race([Promise.resolve().then(() => { observer.remaining(); return operation(); }), observer.failure.then(error => { throw error; })]), remaining, operations.maybeAfter);
    };
    try {
      operations.prearm(observer); observer.setNonceDigest(await limit(() => qualificationRestartNonceDigest(request.requestNonce))); await limit(() => operations.prepare()); await limit(() => operations.freezeWrites());
      this.#awaitingAck = true; await limit(() => operations.request(request));
      if (!observer.ackMatched) throw serialFailure("restart_ack");
      for (;;) {
        const boot = await limit(() => Promise.race([observer.ready.then(() => "ready"), observer.streamEnd.then(() => "interrupted")]));
        if (boot === "interrupted" || observer.needsReopen) { await limit(() => operations.reopen(observer)); continue; }
        const admission = observeSerialOutcome(limit(() => operations.fresh(observer)));
        const result = await limit(() => Promise.race([admission.then(value => ({ kind: "admitted" as const, value })), observer.streamEnd.then(() => ({ kind: "interrupted" as const }))]));
        if (result.kind === "interrupted" || observer.needsReopen) { await limit(() => operations.reopen(observer)); await admission; continue; }
        if (!result.value.ok) throw result.value.error;
        observer.admitted(); operations.finish(); return observer.complete();
      }
    } catch (error) {
      const failure = serialFailureFor(error, "restart_failed"); observer.fail(failure);
      try { await operations.cleanup(); }
      catch (cleanup) { throw new AggregateError([failure, cleanup], "Restart observation cleanup failed"); }
      throw failure;
    } finally { this.#awaitingAck = false; this.#maybeAcknowledged = undefined; this.#maybePriorAck = undefined; }
  }
}
