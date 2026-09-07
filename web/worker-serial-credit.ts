import { serialFailure } from "./worker-serial-errors";

export const SERIAL_RECEIVE_WINDOW = 2048;
export const SERIAL_WRITE_CHUNK = 1024;

/** Computes the next debited chunk without wrapping cumulative counters. */
export function reserveSerialBytes(sent: number, received: number, wanted: number): number {
  if (![sent, received, wanted].every(Number.isSafeInteger) || received < 0 ||
    sent < received || sent - received > SERIAL_RECEIVE_WINDOW || wanted <= 0 ||
    sent > 0xffffffff || wanted > 0xffffffff - sent) throw serialFailure("credit_counter");
  return Math.min(wanted, SERIAL_WRITE_CHUNK, SERIAL_RECEIVE_WINDOW - (sent - received));
}

/** One session's consumed-byte window; native-write failure never refunds reservations. */
export class WorkerSerialCredit {
  #sent = 0;
  #received = 0;
  #active = false;
  #cancelled = false;
  #maybeWake: (() => void) | undefined;

  admit(): void {
    if (this.#active || this.#cancelled) throw serialFailure("credit_session");
    this.#active = true;
  }

  acknowledge(received: unknown): void {
    if (this.#cancelled) return;
    if (!this.#active || !Number.isSafeInteger(received) || Number(received) <= this.#received ||
      Number(received) > this.#sent || Number(received) > 0xffffffff) throw serialFailure("credit_invalid");
    this.#received = Number(received);
    this.#wake();
  }

  async reserve(wanted: number): Promise<number> {
    for (;;) {
      this.#requireActive();
      const count = reserveSerialBytes(this.#sent, this.#received, wanted);
      if (count) { this.#sent += count; return count; }
      await this.#wait();
    }
  }

  async consumed(): Promise<void> {
    for (;;) {
      this.#requireActive();
      if (this.#received === this.#sent) return;
      await this.#wait();
    }
  }

  cancel(): void { this.#cancelled = true; this.#wake(); }
  #requireActive() {
    if (!this.#active || this.#cancelled) throw serialFailure("credit_closed");
  }
  #wait(): Promise<void> { return new Promise(resolve => { this.#maybeWake = resolve; }); }
  #wake() { const wake = this.#maybeWake; this.#maybeWake = undefined; wake?.(); }
}
