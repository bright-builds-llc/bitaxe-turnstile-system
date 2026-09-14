import { boundedSerial, type WorkerSerialPort, type WorkerSerialChannel, type WorkerSerialBrowserRuntime } from "./webserial-worker-port";
import { serialFailure } from "./worker-serial";

/** Keeps origin ownership until even a timed-out native open has settled and closed. */
export class WorkerSerialPortOwner {
  #maybePort: WorkerSerialPort | undefined;
  #maybeOpening: Promise<boolean> | undefined;
  #maybeChannel: WorkerSerialChannel | undefined;
  #maybeClosing: Promise<void> | undefined;
  #released = false;
  #reopened = false;
  constructor(private readonly release: () => void, private readonly maybeAfter: WorkerSerialBrowserRuntime["maybeAfter"]) { }
  get released() { return this.#released; }
  async open(port: WorkerSerialPort) {
    if (this.#maybeOpening || this.#maybeClosing) throw serialFailure("already_opening");
    this.#maybePort = port;
    const opening = Promise.resolve().then(() => port.open({ baudRate: 115_200, bufferSize: 66_560, flowControl: "none" }));
    // Failure is surfaced by open(); false means cleanup has no opened resource to close.
    this.#maybeOpening = opening.then(() => true, () => false);
    await boundedSerial(opening, 2_000, this.maybeAfter);
  }
  attach(channel: WorkerSerialChannel) {
    if (this.#maybeClosing) throw serialFailure("admission_cancelled");
    this.#maybeChannel = channel;
  }
  /** Explicitly retires ended streams and reopens only the already granted port, retaining its WebLock. */
  async reopenExpectedReset(check: () => void): Promise<WorkerSerialPort> {
    if (this.#released || this.#maybeClosing || this.#reopened || !this.#maybePort || !this.#maybeChannel) throw serialFailure("restart_reopen");
    check(); this.#reopened = true;
    const port = this.#maybePort;
    await this.#maybeChannel.close();
    if (!this.#maybeChannel.portClosed) throw serialFailure("cleanup_pending");
    if (this.#released || this.#maybeClosing) throw serialFailure("admission_cancelled");
    check(); this.#maybeChannel = undefined; this.#maybeOpening = undefined;
    await this.open(port);
    if (this.#released || this.#maybeClosing) throw serialFailure("admission_cancelled");
    check(); return port;
  }
  async close() {
    this.#maybeClosing ??= this.#finishClose();
    await boundedSerial(this.#maybeClosing, 2_000, this.maybeAfter);
  }
  async #finishClose() {
    const opened = this.#maybeOpening ? await this.#maybeOpening : false;
    try {
      if (opened) {
        if (this.#maybeChannel) await this.#maybeChannel.close();
        else if (this.#maybePort) await this.#maybePort.close();
      }
    } catch (error) {
      // A prior stream error still propagates, but confirmed native closure releases ownership.
      if (this.#maybeChannel?.portClosed) this.#release();
      throw error;
    }
    this.#release();
  }
  #release() {
    if (this.#released) return;
    this.#released = true;
    this.release();
  }
}
