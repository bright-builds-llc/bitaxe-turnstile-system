import { WorkerSerialChannel } from "./webserial-worker-port";
import { WorkerSerialFramer, WorkerSerialPeer, WORKER_SERIAL_PROFILE, encodeWorkerSerialEnvelope, type WorkerSerialEnvelope } from "./worker-serial";

/** Native writes enqueue 64-byte USB packets; a paused 4096-byte ISR ring drops overflow. */
export function boundedSerialReceiver() {
  const session = "AAAAAAAAAAAAAAAAAAAAAA";
  const ring: number[] = [];
  const received: WorkerSerialEnvelope[] = [];
  const deviceFramer = new WorkerSerialFramer();
  const peer = new WorkerSerialPeer(session, 0);
  let maybeOutput: ReadableStreamDefaultController<Uint8Array> | undefined;
  let paused = true, running = false, suppressCredit = false, closed = false;
  let consumed = 0, reserved = 0, sequence = 0, dropped = 0, maximumBuffered = 0, writes = 0;
  let dropNextPacket = false;
  let maybeWithheldCredit: number | undefined;
  let maybeDrain: Promise<void> | undefined;
  const failures: string[] = [];
  async function credit(count = consumed) {
    const bytes = await encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "session", sessionId: session, sequence: ++sequence, payload: { op: "receive_credit", receivedBytes: count } });
    if (!closed) maybeOutput?.enqueue(bytes);
  }
  async function drain() {
    if (running || paused || closed) return;
    running = true;
    try {
      while (ring.length && !paused && !closed) {
        const bytes = Uint8Array.from(ring.splice(0));
        consumed += bytes.length;
        if (!suppressCredit && consumed !== maybeWithheldCredit) await credit();
        try { received.push(...await deviceFramer.push(bytes)); }
        catch { failures.push("integrity_or_framing"); }
      }
    } finally { running = false; }
  }
  function startDrain() { maybeDrain = drain(); return maybeDrain; }
  async function nativeWrite(bytes: Uint8Array) {
    writes++;
    reserved += bytes.length;
    for (let offset = 0; offset < bytes.length; offset += 64) {
      const packet = bytes.subarray(offset, offset + 64);
      if (dropNextPacket || ring.length + packet.length > 4096) {
        dropped += packet.length;
        dropNextPacket = false;
      } else ring.push(...packet);
      maximumBuffered = Math.max(maximumBuffered, ring.length);
    }
    // Device consumption/ACK can precede native promise settlement.
    await startDrain();
  }
  const port = {
    readable: new ReadableStream<Uint8Array>({ start(output) { maybeOutput = output; } }),
    writable: new WritableStream<Uint8Array>({ write: nativeWrite }),
    getInfo: () => ({}), async open() {}, async close() { closed = true; },
  };
  const channel = new WorkerSerialChannel(port, frame => {
    peer.receive(frame, 0);
    if (frame.kind !== "session" || frame.payload.op !== "receive_credit") throw new Error("fixture_credit_expected");
    channel.receiveCredit(frame.payload.receivedBytes);
  }, error => { failures.push(error.message); channel.abortRecord(); });
  channel.admitReceiveCredit();
  return {
    channel, received, failures,
    frame: (sequence = 1): WorkerSerialEnvelope => ({ profile: WORKER_SERIAL_PROFILE, kind: "control", sessionId: session, sequence, payload: { padding: "x".repeat(65522) } }),
    counts: () => ({ consumed, reserved, dropped, maximumBuffered, writes, closed }),
    async resume() { paused = false; await startDrain(); },
    pause() { paused = true; },
    loseCredit() { suppressCredit = true; },
    losePacket() { dropNextPacket = true; },
    withholdCreditAt(count: number) { maybeWithheldCredit = count; },
    injectUncredited: nativeWrite,
    credit,
    async settled() { await maybeDrain; await new Promise(resolve => setTimeout(resolve, 0)); },
  };
}
