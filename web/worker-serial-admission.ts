import { encodeBase64Url } from "./crypto-bytes";
import { WorkerSerialHelloExchange, exchangeWorkerSerialHello, parseWorkerSerialHelloAck } from "./worker-serial-hello";
import { parseWorkerControllerCapabilities, verifyWorkerControllerCapability, type WorkerControllerStatus } from "./worker-controller";
import { serialFailure } from "./worker-serial";
import type { WorkerSerialChannel } from "./webserial-worker-port";
import type { Ack, WorkerSerialAdmissionStage } from "./worker-serial-controller.types";

/** Shared admission performs no port selection, ownership acquisition or supervisor activation. */
export async function admitWorkerSerialSession(operations: {
  channel: WorkerSerialChannel; trustedUpdateKeys: readonly unknown[]; now(): number;
  stage(value: WorkerSerialAdmissionStage): void; current(): boolean;
  hello(value: WorkerSerialHelloExchange | undefined): void; acknowledged(ack: Ack, began: number): void;
  recovery(value: { discardedRecords: number; discardedReplies: number; discardedBytes: number }): void;
  timer(): void; discover(): Promise<unknown>;
  capability(value: Awaited<ReturnType<typeof verifyWorkerControllerCapability>>): void;
  prove(): Promise<void>; heartbeat(): Promise<void>; baseline(): Promise<WorkerControllerStatus>;
  establish(): Promise<{ status: "ready"; recovered: boolean }>;
}) {
  const requireCurrent = () => { if (!operations.current()) throw serialFailure("admission_lost"); };
  const hostNonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const began = operations.now(); operations.stage("hello");
  const hello = new WorkerSerialHelloExchange(hostNonce,
    frame => { operations.stage("manifest_identity"); return parseWorkerSerialHelloAck(frame, hostNonce); },
    ({ ack }) => operations.acknowledged(ack, began));
  operations.hello(hello);
  const received = await exchangeWorkerSerialHello(operations.channel, hello, hostNonce);
  requireCurrent();
  operations.recovery({ discardedRecords: hello.discardedRecords, discardedReplies: hello.discardedReplies, discardedBytes: operations.channel.bootstrapDiscardedBytes });
  operations.hello(undefined); operations.timer(); operations.stage("capability");
  const capabilities = parseWorkerControllerCapabilities(await operations.discover()); requireCurrent();
  const verified = await verifyWorkerControllerCapability(capabilities, received.manifest, operations.trustedUpdateKeys); requireCurrent(); operations.capability(verified);
  operations.stage("possession"); await operations.prove(); requireCurrent(); await operations.heartbeat(); requireCurrent();
  operations.stage("baseline"); const status = await operations.baseline(); requireCurrent();
  if (status.state !== "baseline" || !["confirmed", "not_required"].includes(status.restoration.status)) throw serialFailure("baseline_unconfirmed");
  requireCurrent();
  operations.stage("continuity"); return operations.establish();
}
