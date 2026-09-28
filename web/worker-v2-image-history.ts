import { WorkerV2SerialHistory } from "./worker-v2-serial-history";
import { serialFailure } from "./worker-serial";
import type { V2Status } from "./worker-v2-serial";
import type { WorkerPreservationContinuity } from "./worker-preservation";
export type WorkerV2ObservedImage = {
  phase: "before" | "candidate";
  firmwareSourceCommit: string;
  appElfSha256: string;
};
const sameImage = (a: WorkerV2ObservedImage, b: WorkerV2ObservedImage) => a.firmwareSourceCommit === b.firmwareSourceCommit && a.appElfSha256 === b.appElfSha256;
const fail = (): never => { throw serialFailure("v2_retained_evidence"); };
/** A planned update partitions history; it never discards the old evidence or admits work. */
export class WorkerV2ImageHistory {
  readonly #before = new WorkerV2SerialHistory();
  #maybeCandidate: { history: WorkerV2SerialHistory; image: WorkerV2ObservedImage; boot: number; retained: boolean } | undefined;
  #maybePrevious: { status: V2Status; image: WorkerV2ObservedImage } | undefined;
  observe(status: V2Status, maybeImage: WorkerV2ObservedImage | undefined, maybePreservation: WorkerPreservationContinuity | undefined): void {
    const maybeCandidate = this.#maybeCandidate;
    if (maybeCandidate) {
      if (!maybeImage || maybeImage.phase !== "candidate" || !sameImage(maybeImage, maybeCandidate.image) || (maybeCandidate.retained ? status.observation.bootOrdinal !== maybeCandidate.boot : status.observation.bootOrdinal < maybeCandidate.boot) || (status.record && status.record.bootOrdinal !== status.observation.bootOrdinal)) fail();
      maybeCandidate.history.observe(status);
      maybeCandidate.boot = status.observation.bootOrdinal;
      maybeCandidate.retained ||= status.record !== null;
      return;
    }
    const maybePrevious = this.#maybePrevious;
    if (maybePrevious && maybeImage && maybePrevious.image.phase === "before" && maybeImage.phase === "candidate" && !sameImage(maybePrevious.image, maybeImage)) {
      const record = maybePrevious.status.record;
      if (maybePrevious.image.firmwareSourceCommit === maybeImage.firmwareSourceCommit || maybePrevious.image.appElfSha256 === maybeImage.appElfSha256) fail();
      if (record && (record.state !== "terminal" || record.outcome === null || !record.resources.socketClosed || !record.resources.workerQuiescent || record.resources.fenceRetained)) fail();
      if (!maybePreservation?.settings_match || !maybePreservation.authorization_high_water_match || !maybePreservation.device_identity_match || maybePreservation.mine_on_boot) fail();
      if (status.state !== "idle" || status.record !== null || status.observation.bootOrdinal <= Math.max(maybePrevious.status.observation.bootOrdinal, record?.bootOrdinal ?? 0)) fail();
      const history = new WorkerV2SerialHistory();
      history.observe(status);
      this.#maybeCandidate = { history, image: structuredClone(maybeImage), boot: status.observation.bootOrdinal, retained: false };
      return;
    }
    this.#before.observe(status);
    if (maybeImage) this.#maybePrevious = { status: structuredClone(status), image: structuredClone(maybeImage) };
  }
}
