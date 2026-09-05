import type { WorkerSerialDiagnostic } from "./worker-serial-diagnostics";
import {
  encodeWorkerSerialEnvelope,
  WorkerSerialFramer,
  type WorkerSerialEnvelope,
  serialFailure,
  serialFailureFor,
} from "./worker-serial";

/** Minimal direct Web Serial surface; production uses navigator.serial. */
export interface WorkerSerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  open(options: {
    baudRate: number;
    bufferSize: number;
    flowControl: "none";
  }): Promise<void>;
  close(): Promise<void>;
}
export interface WorkerSerialAccess {
  requestPort(options: {
    filters: { usbVendorId: number; usbProductId: number }[];
  }): Promise<WorkerSerialPort>;
}
export type WorkerSerialBrowserRuntime = {
  serial: WorkerSerialAccess;
  foreground(): boolean;
  userActivation(): boolean;
  now(): number;
  maybeAfter?: (milliseconds: number, listener: () => void) => () => void;
  acquireLock(): Promise<() => void>;
  subscribeForegroundLoss(listener: () => void): () => void;
  every(milliseconds: number, listener: () => void): () => void;
};
export const workerSerialTestRuntime = Symbol("workerSerialTestRuntime");

export function browserSerialRuntime(): WorkerSerialBrowserRuntime {
  if (typeof navigator === "undefined") throw serialFailure("unavailable");
  const access = navigator as Navigator & { serial?: WorkerSerialAccess };
  if (!access.serial || !navigator.locks) throw serialFailure("unavailable");
  return {
    serial: access.serial,
    foreground: () => document.visibilityState === "visible",
    userActivation: () => navigator.userActivation.isActive,
    now: () => performance.now(),
    acquireLock: () =>
      new Promise((resolve, reject) => {
        void navigator.locks
          .request("bwg-worker-serial", { ifAvailable: true }, (lock) => {
            if (!lock) {
              reject(serialFailure("already_owned"));
              return;
            }
            return new Promise<void>((release) => resolve(release));
          })
          .catch(() => reject(serialFailure("ownership")));
      }),
    subscribeForegroundLoss: (listener) => {
      const hidden = () => {
        if (document.visibilityState !== "visible") listener();
      };
      document.addEventListener("visibilitychange", hidden);
      window.addEventListener("pagehide", listener);
      return () => {
        document.removeEventListener("visibilitychange", hidden);
        window.removeEventListener("pagehide", listener);
      };
    },
    every: (milliseconds, listener) => {
      const timer = setInterval(listener, milliseconds);
      return () => clearInterval(timer);
    },
  };
}
export function boundedSerial<T>(
  operation: Promise<T>,
  milliseconds: number,
  maybeAfter?: (milliseconds: number, listener: () => void) => () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = maybeAfter
      ? maybeAfter(milliseconds, () => reject(serialFailure("timeout")))
      : (() => {
        const timer = setTimeout(
          () => reject(serialFailure("timeout")),
          milliseconds,
        );
        return () => clearTimeout(timer);
      })();
    operation.then(
      (value) => {
        cancel();
        resolve(value);
      },
      () => {
        cancel();
        reject(serialFailure("io"));
      },
    );
  });
}
type PendingWrite = {
  frame: WorkerSerialEnvelope;
  resolve(): void;
  reject(error: Error): void;
};

/** One reader and prioritized bounded writer own a port for exactly one session. */
export class WorkerSerialChannel {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #framer: WorkerSerialFramer;
  readonly #pending: PendingWrite[] = [];
  #writing = false;
  #closed = false;
  #portClosed = false;
  #maybeClosing: Promise<void> | undefined;
  #sequence = 0;
  readonly #reading: Promise<void>;
  constructor(
    readonly port: WorkerSerialPort,
    receive: (frame: WorkerSerialEnvelope) => void,
    failure: (error: Error) => void,
    maybeDiagnostic?: (value: WorkerSerialDiagnostic) => void,
  ) {
    this.#framer = new WorkerSerialFramer(maybeDiagnostic);
    if (!port.readable || !port.writable) throw serialFailure("streams");
    this.#reader = port.readable.getReader();
    this.#writer = port.writable.getWriter();
    this.#reading = this.#read(receive).catch((error: unknown) => {
      if (!this.#closed) failure(serialFailureFor(error, "read_failed"));
    });
  }
  send(frame: WorkerSerialEnvelope): Promise<void> {
    if (this.#closed || this.#pending.length >= 3)
      return Promise.reject(serialFailure("write_bound"));
    return new Promise((resolve, reject) => {
      const pending = { frame, resolve, reject };
      if (frame.kind === "heartbeat") this.#pending.unshift(pending);
      else this.#pending.push(pending);
      void this.#drain();
    });
  }
  async #drain(): Promise<void> {
    if (this.#writing || this.#closed) return;
    this.#writing = true;
    try {
      while (this.#pending.length > 0 && !this.#closed) {
        const pending = this.#pending.shift();
        if (!pending) break;
        try {
          const hello =
            pending.frame.kind === "session" &&
            pending.frame.payload.op === "hello";
          if (!hello && this.#sequence >= 0xffff_ffff)
            throw serialFailure("sequence_exhausted");
          const frame = {
            ...pending.frame,
            sequence: hello ? 0 : ++this.#sequence,
          };
          await boundedSerial(
            this.#writer.write(encodeWorkerSerialEnvelope(frame)),
            1_000,
          );
          pending.resolve();
        } catch {
          const error = serialFailure("write_failed");
          pending.reject(error);
          for (const queued of this.#pending.splice(0)) queued.reject(error);
          break;
        }
      }
    } finally {
      this.#writing = false;
    }
  }
  async #read(receive: (frame: WorkerSerialEnvelope) => void): Promise<void> {
    while (!this.#closed) {
      const result = await this.#reader.read();
      if (result.done) {
        if (!this.#closed) throw serialFailure("disconnected");
        return;
      }
      for (const frame of this.#framer.push(result.value)) receive(frame);
    }
  }
  get portClosed(): boolean { return this.#portClosed; }
  close(): Promise<void> {
    return this.#maybeClosing ??= this.#finishClose();
  }
  async #finishClose(): Promise<void> {
    this.#closed = true;
    for (const queued of this.#pending.splice(0))
      queued.reject(serialFailure("closed"));
    const errors: unknown[] = [];
    for (const result of await Promise.allSettled([
      boundedSerial(this.#reader.cancel(), 1_000),
      boundedSerial(this.#writer.abort(), 1_000),
    ])) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    try {
      await boundedSerial(this.#reading, 1_000);
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#reader.releaseLock();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#writer.releaseLock();
    } catch (error) {
      errors.push(error);
    }
    try {
      // The owner bounds its caller while retaining this native settlement promise.
      await this.port.close();
      this.#portClosed = true;
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, "Worker Serial cleanup failed");
  }
}
